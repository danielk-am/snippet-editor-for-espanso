import fs from 'node:fs/promises';
import path from 'node:path';
import { isSafeFileName } from './store.js';
import { parseRepositoryAddress, repositoryKey } from './teamAddress.js';
import { MANIFEST, PACKAGE_NAME } from './teamRepo.js';
import { repositoryLabel } from '../shared/repositoryLabel.js';
import { isPlainObject, toText } from '../shared/text.js';

// Team packages as Espanso sees them: one folder each under match/team/.
// Espanso loads every .yml in there, so what the folder holds is what runs.
//
// A folder is the app's only if it carries the marker file. The marker is
// written before anything else, so a folder is the app's to repair from the
// first moment, and a folder someone else made is never touched.
//
// The marker also names the repository the package came from, and the package
// belongs to that one. With several repositories connected, two can offer a
// package of one name. There is one folder for a name, so only the repository
// that holds it may replace it, until it is removed.

export const MARKER = '.snippet-editor.json';

// Espanso skips files whose names start with an underscore. A file is
// written under such a name first, then renamed, so Espanso never reads one
// that is half written. One short name serves every file: installs run one
// at a time, and a name built from the file's own could be too long.
const INCOMING = '_incoming.tmp';

const fail = (code, message) => Object.assign(new Error(message), { code });
const isPackageFile = (name) => name === MANIFEST || isSafeFileName(name);

// `allowLocal` exists for tests, whose repositories are folders on this
// computer. The app itself never passes it.
export function createTeamPackages({ matchDir, now = () => new Date(), allowLocal = false }) {
	const root = path.join(matchDir, 'team');
	const folder = (name) => path.join(root, name);

	// Which repository an address means, whatever form it was written in. A
	// marker that cannot be read, or whose address the app would refuse, names
	// none: its key is ''.
	const keyOf = (url) => repositoryKey(url, { allowLocal });
	// The address a marker names, as the app itself would write it, or '' when
	// its text is no address. A marker is a file, and a file can be edited by
	// hand: its text can be any length, and can hold a sign-in. So that text
	// is read here and handed on to nobody. What goes on is the address.
	const addressOf = (text) => {
		try {
			return parseRepositoryAddress(text, { allowLocal }).url;
		} catch {
			return '';
		}
	};
	// A folder whose marker names no repository is damaged, and any repository
	// may repair it. One that names a repository is that repository's alone.
	// The message names the holder as owner/repo. What a marker names is by
	// now an address as the app keeps it, which is what the label is made from.
	const refuseIfHeld = (name, marker, repository) => {
		const holder = marker ? keyOf(marker.repository) : '';
		if (holder && holder !== keyOf(repository)) {
			throw fail('EXISTS', `A package named ${name} is already installed from ${repositoryLabel(marker.repository)}. Remove it first, then install this one.`);
		}
	};

	let queue = Promise.resolve();
	const inTurn = (work) => {
		const result = queue.then(work);
		queue = result.catch(() => {});
		return result;
	};

	const checkName = (name) => {
		if (typeof name !== 'string' || !PACKAGE_NAME.test(name)) throw fail('INVALID', 'A package name is lowercase letters, digits and dashes, 80 characters or fewer.');
	};

	// null: no folder, or an empty one, which is nobody's. false: a folder (or
	// a link) that is not the app's.
	async function markerOf(name) {
		let stat;
		try {
			stat = await fs.lstat(folder(name));
		} catch {
			return null;
		}
		if (!stat.isDirectory()) return false;
		let text;
		try {
			text = await fs.readFile(path.join(folder(name), MARKER), 'utf8');
		} catch {
			// An install that failed before its first write leaves an empty
			// folder behind. That must not block the next one.
			return (await fs.readdir(folder(name)).catch(() => [''])).length === 0 ? null : false;
		}
		let data = null;
		try {
			data = JSON.parse(text);
		} catch {
			// Damaged, but there: the folder is still the app's, half done.
		}
		const known = isPlainObject(data);
		return {
			repository: known ? addressOf(toText(data.repository)) : '',
			package: name,
			commit: known ? toText(data.commit) : '',
			tree: known ? toText(data.tree) : '',
			state: known && data.state === 'installed' ? 'installed' : 'installing',
			installedAt: known ? toText(data.installedAt) : '',
		};
	}

	async function writeMarker(name, marker) {
		const file = path.join(folder(name), MARKER);
		await fs.writeFile(`${file}.tmp`, JSON.stringify(marker, null, '\t') + '\n');
		await fs.rename(`${file}.tmp`, file);
	}

	async function install({ name, files, repository, commit, tree }) {
		checkName(name);
		if (!Array.isArray(files) || !files.length) throw fail('INVALID', 'That package has no files to install.');
		for (const file of files) {
			if (!isPackageFile(file?.name) || !Buffer.isBuffer(file.bytes)) throw fail('INVALID', 'That package holds a file that cannot be installed.');
		}

		const existing = await markerOf(name);
		if (existing === false) throw fail('EXISTS', `A folder named ${name} is already in match/team and was not put there by this app.`);
		// Checked here, in turn, so that of two repositories installing one name
		// at the same moment the second meets the first's marker.
		refuseIfHeld(name, existing, repository);
		await fs.mkdir(folder(name), { recursive: true });

		const marker = { repository: toText(repository), package: name, commit: toText(commit), tree: toText(tree), state: 'installing', installedAt: now().toISOString() };
		await writeMarker(name, marker);

		const staged = path.join(folder(name), INCOMING);
		for (const file of files) {
			await fs.rm(staged, { recursive: true, force: true });
			await fs.writeFile(staged, file.bytes, { flag: 'wx' });
			await fs.rename(staged, path.join(folder(name), file.name));
		}
		// The folder mirrors the package: what the package dropped goes too.
		const keep = new Set([MARKER, ...files.map((file) => file.name)]);
		for (const entry of await fs.readdir(folder(name))) {
			if (!keep.has(entry)) await fs.rm(path.join(folder(name), entry), { recursive: true, force: true });
		}

		marker.state = 'installed';
		await writeMarker(name, marker);
		return marker;
	}

	async function remove(name) {
		checkName(name);
		const existing = await markerOf(name);
		if (existing === null) throw fail('NOT_FOUND', 'That package is not installed.');
		if (existing === false) throw fail('READ_ONLY', `The folder named ${name} in match/team was not put there by this app, so it is left alone.`);
		await fs.rm(folder(name), { recursive: true, force: true });
	}

	async function installed() {
		const found = new Map();
		const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
		for (const entry of entries.filter((item) => item.isDirectory() && PACKAGE_NAME.test(item.name)).sort((a, b) => (a.name < b.name ? -1 : 1))) {
			const marker = await markerOf(entry.name);
			if (marker) found.set(entry.name, marker);
		}
		return found;
	}

	// The question install asks, for a caller that wants the answer before it
	// reads a package's files. Nothing is written.
	async function checkFree(name, repository) {
		checkName(name);
		refuseIfHeld(name, await markerOf(name), repository);
	}

	return {
		root,
		keyOf,
		installed: () => inTurn(installed),
		install: (input = {}) => inTurn(() => install(input)),
		checkFree: (name, repository) => inTurn(() => checkFree(name, repository)),
		remove: (name) => inTurn(() => remove(name)),
	};
}
