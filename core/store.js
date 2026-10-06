import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { parseDocument } from 'yaml';
import {
	applyMatchUpdate,
	insertMatch,
	newFileText,
	parseMatchFile,
	removeMatch,
	writeHeaderMeta,
} from './matchFile.js';
import { searchFiles } from '../shared/search.js';
import { toText } from '../shared/text.js';

// The match folder is the only store: Espanso reads these files directly, so
// there is no database to drift from them. Every write is therefore careful:
// checked against the version the editor read, backed up, queued and swapped
// in atomically.

export class StoreError extends Error {
	constructor(code, message) {
		super(message);
		this.name = 'StoreError';
		this.code = code;
	}
}

const MANIFEST = '_manifest.yml';
const PACKAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// Line breaks, tabs and the like: legal in a file name on most systems, and
// never what anyone meant to type.
const hasControlCharacter = (name) =>
	[...name].some((character) => {
		const code = character.codePointAt(0);
		return code < 0x20 || code === 0x7f;
	});

function isSafeFileName(name) {
	return (
		typeof name === 'string' &&
		name.length > 0 &&
		name.length <= 255 &&
		!name.startsWith('.') &&
		!/[\\/]/.test(name) &&
		!hasControlCharacter(name) &&
		/\.ya?ml$/i.test(name)
	);
}

const byName = (a, b) => (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1);

const MEGABYTE = 1024 * 1024;

// A file's version is a fingerprint of its bytes. Unlike a timestamp, it
// cannot be the same for two different contents.
const versionOf = (bytes) => createHash('sha256').update(bytes).digest('hex').slice(0, 24);

const READ_FAILURES = {
	EACCES: 'This file cannot be read: permission denied.',
	EPERM: 'This file cannot be read: permission denied.',
	ELOOP: 'This link points back to itself.',
	EISDIR: 'This is a folder, not a file.',
};

export function createStore({ matchDir, backupDir, maxBackups = 20, maxFileBytes = 2 * MEGABYTE, now = () => new Date() }) {
	const packagesDir = path.join(matchDir, 'packages');

	function resolve(ref) {
		if (!ref || !isSafeFileName(ref.name)) {
			throw new StoreError('INVALID_NAME', 'Use a file name ending in .yml, without slashes or a leading dot.');
		}
		if (ref.source === 'local') {
			return { id: `local:${ref.name}`, filePath: path.join(matchDir, ref.name), backupKey: ['local', ref.name] };
		}
		if (ref.source === 'package' && typeof ref.package === 'string' && PACKAGE_NAME.test(ref.package)) {
			return {
				id: `package:${ref.package}:${ref.name}`,
				filePath: path.join(matchDir, 'packages', ref.package, ref.name),
				backupKey: null,
			};
		}
		throw new StoreError('INVALID_NAME', 'That is not a file in the match folder.');
	}

	// A package is someone else's content. A link inside one must not be a way
	// to show a file from elsewhere on the disk, so package files are read
	// only when they really live under the packages folder. Your own match
	// files may be links: that is a choice you made.
	async function insidePackages(filePath) {
		try {
			const [root, real] = await Promise.all([fs.realpath(packagesDir), fs.realpath(filePath)]);
			return real.startsWith(root + path.sep);
		} catch {
			return false;
		}
	}

	function describe(ref, id, stat, fields) {
		return {
			id,
			source: ref.source,
			...(ref.source === 'package' ? { package: ref.package } : {}),
			name: ref.name,
			description: '',
			prefix: '',
			importOnly: ref.name.startsWith('_'),
			readOnly: ref.source !== 'local',
			sizeBytes: stat?.size ?? 0,
			version: '',
			...fields,
		};
	}

	// A file that exists but cannot be opened here. It is listed, so you can
	// see it and why, and it is read-only, so nothing can be saved over it.
	const unreadable = (ref, id, stat, message) =>
		describe(ref, id, stat, { matchCount: null, parseErrors: [message], matches: null, text: '', readOnly: true, unreadable: true });

	const megabytes = Math.round((maxFileBytes / MEGABYTE) * 10) / 10;

	async function load(ref) {
		const { id, filePath } = resolve(ref);
		const gone = () => new StoreError('NOT_FOUND', `${ref.name} is no longer in the match folder.`);
		if (ref.source === 'package' && !(await insidePackages(filePath))) throw gone();

		// A file that is there but cannot be opened is described, not thrown:
		// asked for on its own it answers as it does in the list of files.
		const refused = (error, stat) => {
			if (error.code === 'ENOENT') throw gone();
			if (Object.hasOwn(READ_FAILURES, error.code)) return unreadable(ref, id, stat, READ_FAILURES[error.code]);
			throw error;
		};

		let stat;
		try {
			stat = await fs.stat(filePath);
		} catch (error) {
			return refused(error, null);
		}
		if (!stat.isFile()) return unreadable(ref, id, stat, READ_FAILURES.EISDIR);
		if (stat.size > maxFileBytes) {
			return unreadable(ref, id, stat, `This file is too large to open here (over ${megabytes} MB).`);
		}

		let bytes;
		try {
			bytes = await fs.readFile(filePath);
		} catch (error) {
			return refused(error, stat);
		}
		// Text in another encoding would be damaged by reading and writing it
		// as UTF-8, so such a file is shown but never rewritten.
		const text = bytes.toString('utf8');
		if (!Buffer.from(text, 'utf8').equals(bytes)) {
			return unreadable(ref, id, stat, 'This file is not valid UTF-8 text, so it is not opened here.');
		}
		const writeProtected =
			ref.source === 'local' &&
			(await fs.access(filePath, fs.constants.W_OK).then(
				() => false,
				() => true
			));
		const parsed = parseMatchFile(text);
		return describe(ref, id, stat, {
			description: parsed.header.description,
			prefix: parsed.header.prefix,
			matchCount: parsed.matches ? parsed.matches.length : null,
			parseErrors: parsed.errors,
			matches: parsed.matches,
			text,
			version: versionOf(bytes),
			...(writeProtected ? { readOnly: true, writeProtected: true } : {}),
		});
	}

	const withoutText = ({ text, ...record }) => record;

	async function listYaml(dir, { links }) {
		let entries;
		try {
			entries = await fs.readdir(dir, { withFileTypes: true });
		} catch (error) {
			if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
			throw error;
		}
		return entries
			.filter((entry) => (entry.isFile() || (links && entry.isSymbolicLink())) && isSafeFileName(entry.name))
			.map((entry) => ({ name: entry.name }))
			.sort(byName);
	}

	// One file's trouble stays with that file. A file that vanished between
	// listing and reading is skipped; any other failure is listed as a
	// problem, so the rest of the folder still opens.
	async function loadAll(refs) {
		const loaded = await Promise.all(
			refs.map((ref) =>
				load(ref).catch((error) => {
					if (error.code === 'NOT_FOUND') return null;
					const message = READ_FAILURES[error.code] ?? `This file could not be read (${error.code ?? error.message}).`;
					return unreadable(ref, resolve(ref).id, null, message);
				})
			)
		);
		return loaded.filter(Boolean).map(withoutText);
	}

	async function readManifest(dir) {
		const file = path.join(dir, MANIFEST);
		try {
			if (!(await insidePackages(file))) return { data: {} };
			if ((await fs.stat(file)).size > maxFileBytes) return { error: 'The manifest is too large to read.' };
			const doc = parseDocument(await fs.readFile(file, 'utf8'));
			if (doc.errors.length) return { error: doc.errors[0].message.split('\n')[0] };
			const data = doc.toJS();
			return { data: data !== null && typeof data === 'object' && !Array.isArray(data) ? data : {} };
		} catch (error) {
			return { error: String(error?.message ?? error).split('\n')[0] };
		}
	}

	async function readPackage(name) {
		const dir = path.join(packagesDir, name);
		const manifest = await readManifest(dir);
		const listed = (await listYaml(dir, { links: false })) ?? [];
		const files = await loadAll(
			listed.filter((file) => file.name !== MANIFEST).map((file) => ({ source: 'package', package: name, name: file.name }))
		);
		return {
			name,
			title: toText(manifest.data?.title) || name,
			description: toText(manifest.data?.description),
			version: toText(manifest.data?.version),
			author: toText(manifest.data?.author),
			manifestError: manifest.error ?? '',
			matchCount: files.reduce((sum, file) => sum + (file.matchCount ?? 0), 0),
			files,
		};
	}

	async function listPackages() {
		let entries;
		try {
			entries = await fs.readdir(packagesDir, { withFileTypes: true });
		} catch {
			return [];
		}
		// isDirectory() is false for a link, so a package folder that links
		// somewhere else is never listed.
		const names = entries
			.filter((entry) => entry.isDirectory() && PACKAGE_NAME.test(entry.name))
			.map((entry) => ({ name: entry.name }))
			.sort(byName);

		return Promise.all(
			names.map(({ name }) =>
				readPackage(name).catch((error) => ({
					name,
					title: name,
					description: '',
					version: '',
					author: '',
					manifestError: `This package could not be read (${error.code ?? error.message}).`,
					matchCount: 0,
					files: [],
				}))
			)
		);
	}

	async function inventory() {
		let listed;
		try {
			listed = await listYaml(matchDir, { links: true });
		} catch (error) {
			return { matchDir, exists: true, error: `The match folder could not be read (${error.code ?? error.message}).`, files: [], packages: [] };
		}
		if (listed === null) return { matchDir, exists: false, files: [], packages: [] };
		const [files, packages] = await Promise.all([
			loadAll(listed.map((file) => ({ source: 'local', name: file.name }))),
			listPackages(),
		]);
		return { matchDir, exists: true, files, packages };
	}

	// Writes run one at a time, in the order they were asked for. A person
	// saves one thing at a time, so there is nothing to gain from running
	// them side by side, and one queue cannot be sidestepped by reaching the
	// same file under two names (a link, or a different case).
	let queue = Promise.resolve();
	function enqueue(task) {
		const run = queue.then(task, task);
		queue = run.catch(() => {});
		return run;
	}

	async function backup(backupKey, text) {
		const dir = path.join(backupDir, ...backupKey);
		await fs.mkdir(dir, { recursive: true });
		// The counter keeps names in order when two backups share an instant.
		const stamp = now().toISOString().replace(/[:.]/g, '-');
		for (let n = 0; ; n += 1) {
			try {
				await fs.writeFile(path.join(dir, `${stamp}-${String(n).padStart(3, '0')}.yml`), text, { flag: 'wx' });
				break;
			} catch (error) {
				if (error.code !== 'EEXIST') throw error;
			}
		}
		const kept = (await fs.readdir(dir)).filter((name) => name.endsWith('.yml')).sort();
		await Promise.all(kept.slice(0, Math.max(0, kept.length - maxBackups)).map((name) => fs.rm(path.join(dir, name))));
	}

	// Write beside the real file and rename over it, so Espanso never reads a
	// half-written file. A symlinked match file keeps its link: the swap
	// happens at the link's target.
	async function atomicWrite(filePath, text, expectedVersion, name) {
		const real = await fs.realpath(filePath);
		const { mode } = await fs.stat(real);
		const tmp = path.join(path.dirname(real), `.${path.basename(real)}.${randomBytes(6).toString('hex')}.tmp`);
		try {
			const handle = await fs.open(tmp, 'wx', mode & 0o777);
			try {
				await handle.writeFile(text);
				// The mode given to open() is cut down by the umask; set it outright.
				await handle.chmod(mode & 0o7777);
				await handle.sync();
			} finally {
				await handle.close();
			}
			// One last look before the swap, in case another program wrote
			// the file while the backup was being made.
			if (versionOf(await fs.readFile(real)) !== expectedVersion) throw changedOnDisk(name);
			await fs.rename(tmp, real);
		} catch (error) {
			await fs.rm(tmp, { force: true });
			throw error;
		}
	}

	const changedOnDisk = (name) => new StoreError('CONFLICT', `${name} changed on disk since it was opened. Reload it, then try again.`);

	function checkWritable(ref, current, version) {
		if (ref.source !== 'local') {
			throw new StoreError('READ_ONLY', 'Package files are read-only here. Copy the snippet into one of your own files to change it.');
		}
		if (current.unreadable) {
			throw new StoreError('READ_ONLY', `${ref.name} could not be opened, so it cannot be changed here.`);
		}
		if (current.writeProtected) {
			throw new StoreError('READ_ONLY', `${ref.name} is write-protected. Change its permissions to edit it here.`);
		}
		if (!version || version !== current.version) throw changedOnDisk(ref.name);
	}

	// async so that a refused name rejects like every other failure.
	async function mutate(ref, version, transform) {
		const { filePath, backupKey } = resolve(ref);
		return enqueue(async () => {
			const current = await load(ref);
			checkWritable(ref, current, version);

			let nextText;
			try {
				nextText = transform(current);
			} catch (error) {
				if (error instanceof StoreError) throw error;
				throw new StoreError('INVALID', error.message);
			}
			if (nextText === current.text) return current;

			// Saved, the file could not be opened here again, or changed back.
			if (Buffer.byteLength(nextText) > maxFileBytes) {
				throw new StoreError('TOO_LARGE', `That would make ${ref.name} larger than ${megabytes} MB, which is too large to open here.`);
			}

			const errors = parseMatchFile(nextText).errors;
			if (errors.length) throw new StoreError('PARSE_ERROR', errors.join(' '));

			await backup(backupKey, current.text);
			await atomicWrite(filePath, nextText, current.version, ref.name);
			return load(ref);
		});
	}

	function structured(edit) {
		return (current) => {
			if (current.matches === null) {
				throw new StoreError('PARSE_ERROR', `${current.name} has YAML errors. Fix them in the raw editor first.`);
			}
			return edit(current.text);
		};
	}

	return {
		matchDir,
		backupDir,
		inventory,
		readFile: load,

		async createFile({ name, description = '', prefix = '' } = {}) {
			const ref = { source: 'local', name };
			const { filePath } = resolve(ref);
			let text;
			try {
				text = newFileText({ description, prefix });
			} catch (error) {
				throw new StoreError('INVALID', error.message);
			}
			await fs.mkdir(matchDir, { recursive: true });
			const taken = (await fs.readdir(matchDir)).some((existing) => existing.toLowerCase() === name.toLowerCase());
			if (taken) throw new StoreError('EXISTS', `A file named ${name} already exists.`);
			await fs.writeFile(filePath, text, { flag: 'wx' });
			return load(ref);
		},

		async deleteFile(ref, { version } = {}) {
			const { filePath, backupKey } = resolve(ref);
			return enqueue(async () => {
				const current = await load(ref);
				checkWritable(ref, current, version);
				await backup(backupKey, current.text);
				await fs.unlink(filePath);
				return { id: current.id };
			});
		},

		saveRaw: (ref, { text, version } = {}) => mutate(ref, version, () => String(text ?? '')),

		setHeader: (ref, { description, prefix, version } = {}) =>
			mutate(ref, version, (current) => writeHeaderMeta(current.text, { description, prefix })),

		createMatch: (ref, { match, index, version } = {}) =>
			mutate(
				ref,
				version,
				structured((text) => insertMatch(text, match, index))
			),

		updateMatch: (ref, { index, match, version } = {}) =>
			mutate(
				ref,
				version,
				structured((text) => applyMatchUpdate(text, index, match))
			),

		deleteMatch: (ref, { index, version } = {}) =>
			mutate(
				ref,
				version,
				structured((text) => removeMatch(text, index))
			),

		async search(query, options) {
			const { files, packages } = await inventory();
			return searchFiles([...files, ...packages.flatMap((pkg) => pkg.files)], query, options);
		},
	};
}
