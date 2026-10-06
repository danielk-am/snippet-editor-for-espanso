import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseDocument, stringify } from 'yaml';
import { isSafeFileName } from './store.js';
import { isPlainObject, toText } from '../shared/text.js';

// The app's copy of the team repository. It is a bare copy: nothing is
// checked out, and packages are read straight from the commit with git's own
// commands. So a symbolic link or a submodule in the repository is seen for
// what it is and never followed.

export const PACKAGE_NAME = /^[a-z0-9][a-z0-9-]{0,79}$/;
export const MANIFEST = '_manifest.yml';

const MEGABYTE = 1024 * 1024;
const LIMITS = { packages: 200, files: 50, fileBytes: 2 * MEGABYTE, totalBytes: 12 * MEGABYTE };

const fail = (code, message) => Object.assign(new Error(message), { code });

// "<mode> <type> <sha>[ <size>]\t<path>", one per NUL.
function parseTree(text) {
	return text
		.split('\0')
		.filter(Boolean)
		.map((line) => {
			const tab = line.indexOf('\t');
			const [mode, type, sha, size] = line.slice(0, tab).split(/ +/);
			return { mode, type, sha, size: size === undefined || size === '-' ? null : Number(size), path: line.slice(tab + 1) };
		});
}

const isYaml = (name) => /\.ya?ml$/i.test(name);
const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
// Notes in the order a person would look for them, whatever their first letter's case.
const byText = (a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1);

// Espanso runs a `shell` or `script` variable as a command when the snippet
// is used. A person should know that before installing someone else's.
function runsCommands(data) {
	const risky = (vars) => Array.isArray(vars) && vars.some((item) => isPlainObject(item) && (item.type === 'shell' || item.type === 'script'));
	if (!isPlainObject(data)) return false;
	if (risky(data.global_vars)) return true;
	return Array.isArray(data.matches) && data.matches.some((match) => isPlainObject(match) && risky(match.vars));
}

// What a match file holds, read leniently: this is a listing, not a save.
function scan(bytes) {
	const text = bytes.toString('utf8');
	if (!Buffer.from(text, 'utf8').equals(bytes)) return { matchCount: null, runs: false };
	try {
		const doc = parseDocument(text, { uniqueKeys: false });
		if (doc.errors.length) return { matchCount: null, runs: false };
		const data = doc.toJS();
		return { matchCount: Array.isArray(data?.matches) ? data.matches.length : 0, runs: runsCommands(data) };
	} catch {
		return { matchCount: null, runs: false };
	}
}

function readManifest(bytes) {
	if (!bytes) return { data: {}, error: 'It has no _manifest.yml.' };
	try {
		const doc = parseDocument(bytes.toString('utf8'), { uniqueKeys: false });
		if (doc.errors.length) return { data: {}, error: `Its manifest could not be read: ${doc.errors[0].message.split('\n')[0]}` };
		const data = doc.toJS();
		return isPlainObject(data) ? { data, error: '' } : { data: {}, error: 'Its manifest is not a list of keys and values.' };
	} catch (error) {
		return { data: {}, error: `Its manifest could not be read: ${String(error.message).split('\n')[0]}` };
	}
}

export function createTeamRepo({ dataDir, address, git, now = () => new Date(), limits = {} }) {
	const max = { ...LIMITS, ...limits };
	const dir = path.join(dataDir, 'team', createHash('sha256').update(address.url).digest('hex').slice(0, 12));
	const repoDir = path.join(dir, 'repo.git');
	const stampFile = path.join(dir, 'fetched-at');
	const run = (args, options) => git(args, { cwd: repoDir, ...options });

	// One piece of work at a time. Git does not like two commands changing
	// one repository at once, and a person asks for one thing at a time.
	let queue = Promise.resolve();
	const inTurn = (work) => {
		const result = queue.then(work);
		queue = result.catch(() => {});
		return result;
	};

	let cache = null;

	const cloned = () => fs.access(path.join(repoDir, 'HEAD')).then(() => true, () => false);
	const needCloned = async () => {
		if (!(await cloned())) throw fail('NOT_CONNECTED', 'No team repository is connected.');
	};

	const defaultBranch = async () => (await run(['symbolic-ref', '--short', 'HEAD'])).trim();
	const head = async (branch) => run(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`]).then((out) => out.trim(), () => null);

	// What a connection or a proposal left behind when it was cut short.
	async function cleanUp() {
		for (const entry of await fs.readdir(dir).catch(() => [])) {
			if (/^(repo\.git\.tmp-|work-)/.test(entry)) await fs.rm(path.join(dir, entry), { recursive: true, force: true });
		}
		if (await cloned()) await run(['worktree', 'prune']).catch(() => {});
	}

	async function fetch() {
		const branch = await defaultBranch();
		try {
			await run(['fetch', '--prune', '--no-tags', 'origin', `+refs/heads/${branch}:refs/heads/${branch}`], { timeout: 60_000 });
		} catch (error) {
			// A repository with no commits yet has no branch to fetch.
			if (!/couldn't find remote ref/i.test(error.detail ?? '')) throw error;
		}
		await fs.writeFile(stampFile, now().toISOString());
	}

	async function connect() {
		await fs.mkdir(dir, { recursive: true });
		await cleanUp();
		if (await cloned()) return fetch();
		const staging = `${repoDir}.tmp-${randomBytes(4).toString('hex')}`;
		try {
			await git(['clone', '--quiet', '--bare', '--single-branch', '--no-tags', '--', address.url, staging], { cwd: dir, timeout: 120_000 });
			await fs.rename(staging, repoDir);
		} catch (error) {
			await fs.rm(staging, { recursive: true, force: true });
			throw error;
		}
		await fs.writeFile(stampFile, now().toISOString());
	}

	async function status() {
		if (!(await cloned())) return { branch: null, commit: null, fetchedAt: null };
		const branch = await defaultBranch();
		const fetchedAt = await fs.readFile(stampFile, 'utf8').then((text) => text.trim(), () => null);
		return { branch, commit: await head(branch), fetchedAt };
	}

	// Many files in one call: "<sha> blob <size>\n<bytes>\n" for each.
	async function readBlobs(shas) {
		const blobs = new Map();
		if (!shas.length) return blobs;
		const out = await run(['cat-file', '--batch'], { input: `${shas.join('\n')}\n`, binary: true, timeout: 60_000 });
		let at = 0;
		for (const sha of shas) {
			const lineEnd = out.indexOf(0x0a, at);
			if (lineEnd < 0) break;
			const [, type, size] = out.subarray(at, lineEnd).toString('latin1').split(' ');
			at = lineEnd + 1;
			if (type !== 'blob') continue;
			blobs.set(sha, out.subarray(at, at + Number(size)));
			at += Number(size) + 1;
		}
		return blobs;
	}

	async function listing() {
		await needCloned();
		const branch = await defaultBranch();
		const commit = await head(branch);
		if (!commit) return { commit, branch, packages: [], problems: ['This repository is empty.'], files: new Map() };
		if (cache?.commit === commit) return cache;

		const problems = [];
		const top = parseTree(await run(['ls-tree', '-z', commit, 'packages/']));
		if (!top.length) {
			return (cache = { commit, branch, packages: [], problems: ['This repository has no packages folder yet.'], files: new Map() });
		}

		let folders = [];
		for (const entry of top) {
			const name = entry.path.slice('packages/'.length);
			if (entry.mode === '120000') problems.push(`${name} was left out: it is a link.`);
			else if (entry.mode === '160000') problems.push(`${name} was left out: it is a submodule.`);
			else if (entry.type !== 'tree') continue; // A stray file beside the packages.
			else if (!PACKAGE_NAME.test(name)) problems.push(`${name} was left out: that is not a package name.`);
			else folders.push({ name, tree: entry.sha });
		}
		folders.sort(byName);
		problems.sort(byText);
		if (folders.length > max.packages) {
			folders = folders.slice(0, max.packages);
			problems.push(`Only the first ${max.packages} packages are shown.`);
		}

		// Everything under packages/, sorted into its package.
		const inside = new Map(folders.map((folder) => [folder.name, { ...folder, files: [], manifest: null, problems: [] }]));
		for (const entry of parseTree(await run(['ls-tree', '-r', '-z', '--long', commit, 'packages/']))) {
			const [, name, ...rest] = entry.path.split('/');
			const pkg = inside.get(name);
			if (!pkg || !rest.length) continue;
			const file = rest.join('/');
			const note = (text) => !pkg.problems.includes(text) && pkg.problems.push(text);
			if (rest.length > 1) note('Subfolders were left out.');
			else if (entry.mode === '120000') note(`${file} was left out: it is a link.`);
			else if (entry.mode === '160000') note(`${file} was left out: it is a submodule.`);
			else if (!isYaml(file)) continue; // A readme, a licence: not Espanso's business.
			else if (file !== MANIFEST && !isSafeFileName(file)) note(`${file} was left out: that is not a match file name.`);
			else if (entry.size > max.fileBytes) note(`${file} was left out: it is larger than the app opens.`);
			else if (file === MANIFEST) pkg.manifest = entry.sha;
			else pkg.files.push({ name: file, sha: entry.sha, size: entry.size });
		}

		// Read what is needed to describe each package, within a budget.
		let budget = max.totalBytes;
		const wanted = [];
		for (const pkg of inside.values()) {
			pkg.files.sort(byName);
			if (pkg.files.length > max.files) {
				pkg.files = pkg.files.slice(0, max.files);
				pkg.problems.push(`Only the first ${max.files} files are included.`);
			}
			const cost = pkg.files.reduce((sum, file) => sum + file.size, 0);
			pkg.read = cost <= budget;
			if (!pkg.read) continue;
			budget -= cost;
			wanted.push(...pkg.files.map((file) => file.sha), ...(pkg.manifest ? [pkg.manifest] : []));
		}
		const blobs = await readBlobs([...new Set(wanted)]);

		const files = new Map();
		const packages = [...inside.values()].map((pkg) => {
			files.set(pkg.name, [...(pkg.manifest ? [{ name: MANIFEST, sha: pkg.manifest }] : []), ...pkg.files.map(({ name, sha }) => ({ name, sha }))]);
			const manifest = readManifest(pkg.manifest && blobs.get(pkg.manifest));
			let runs = false;
			const listed = pkg.files.map((file) => {
				const found = pkg.read ? scan(blobs.get(file.sha) ?? Buffer.alloc(0)) : { matchCount: null, runs: false };
				if (pkg.read && found.matchCount === null) pkg.problems.push(`${file.name} has YAML errors.`);
				runs ||= found.runs;
				return { name: file.name, matchCount: found.matchCount, size: file.size };
			});
			if (!pkg.read) pkg.problems.push('Not read: the repository holds more than the app reads at once.');
			return {
				name: pkg.name,
				title: toText(manifest.data.title) || pkg.name,
				description: toText(manifest.data.description),
				version: toText(manifest.data.version),
				author: toText(manifest.data.author),
				manifestError: manifest.error,
				files: listed,
				matchCount: pkg.read ? listed.reduce((sum, file) => sum + (file.matchCount ?? 0), 0) : null,
				runsCommands: runs,
				tree: pkg.tree,
				problems: pkg.problems.sort(byText),
				webUrl: address.webUrl ? `${address.webUrl}/tree/${branch}/packages/${pkg.name}` : null,
			};
		});

		return (cache = { commit, branch, packages, problems, files });
	}

	const oneLine = (value, most) => typeof value === 'string' && value.trim().length > 0 && value.trim().length <= most && !/[\r\n]/.test(value);
	const stamp = () => now().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

	// What the commit holds at one path: null, or its entry.
	const entryAt = async (commit, file) => parseTree(await run(['ls-tree', '-z', commit, '--', file]))[0] ?? null;

	// Sends one file to a package as a new branch. The main branch is never
	// pushed, and nothing is forced: the only thing that reaches the team is a
	// branch someone can open a pull request from, or ignore.
	async function propose({ package: name, fileName, text, summary, title, description }) {
		await needCloned();
		if (typeof name !== 'string' || !PACKAGE_NAME.test(name)) {
			throw fail('INVALID', 'A package name is lowercase letters, digits and dashes, 80 characters or fewer.');
		}
		if (fileName === MANIFEST || !isSafeFileName(fileName)) throw fail('INVALID', 'That is not a match file name.');
		if (typeof text !== 'string' || !text.trim()) throw fail('INVALID', 'There is nothing in that file to propose.');
		if (Buffer.byteLength(text) > max.fileBytes) throw fail('TOO_LARGE', 'That file is larger than the app opens.');
		if (!oneLine(summary, 100)) throw fail('INVALID', 'Write a one-line summary, 100 characters or fewer.');

		await fetch();
		const branch = await defaultBranch();
		const commit = await head(branch);
		if (!commit) throw fail('INVALID', 'This repository is empty. Add a first commit on GitHub, then propose again.');

		// The path must be folders all the way down. A link there would have
		// the file written wherever the link points.
		const [root, folder, existing] = await Promise.all([entryAt(commit, 'packages'), entryAt(commit, `packages/${name}`), entryAt(commit, `packages/${name}/${fileName}`)]);
		if ((root && root.type !== 'tree') || (folder && folder.type !== 'tree')) {
			throw fail('INVALID', `The repository has something other than a folder at packages/${name}, such as a link.`);
		}
		if (existing && (existing.type !== 'blob' || existing.mode === '120000')) {
			throw fail('INVALID', `${fileName} is a link in the team repository, so it cannot be replaced from here.`);
		}

		const created = !folder;
		if (created) {
			if (!oneLine(title, 100)) throw fail('INVALID', 'A new package needs a `title`: one line, 100 characters or fewer.');
			if (typeof description !== 'string' || description.trim().length < 3 || description.trim().length > 1000) {
				throw fail('INVALID', 'A new package needs a `description` of 3 to 1000 characters.');
			}
		}

		// A name nobody has used: two proposals can land in the same second.
		const base = `snippet-editor/${name}-${stamp()}`;
		let proposal = base;
		for (let attempt = 2; (await run(['ls-remote', '--heads', 'origin', `refs/heads/${proposal}`], { timeout: 60_000 })).trim(); attempt += 1) {
			proposal = `${base}-${attempt}`;
		}

		const work = path.join(dir, `work-${randomBytes(4).toString('hex')}`);
		const inWork = (args, options) => git(args, { cwd: work, ...options });
		try {
			await run(['worktree', 'add', '--quiet', '-b', proposal, work, commit], { timeout: 60_000 });
			const target = path.join(work, 'packages', name);
			await fs.mkdir(target, { recursive: true });
			await fs.writeFile(path.join(target, fileName), text);
			if (created) {
				const author = await inWork(['config', 'user.name']).then((out) => out.trim(), () => '');
				await fs.writeFile(path.join(target, MANIFEST), stringify({ name, title: title.trim(), description: description.trim(), version: '0.1.0', author }, { lineWidth: 0 }));
			}
			await inWork(['add', '--', `packages/${name}`]);
			// Nothing staged: the package holds this file already, byte for byte
			// or once git has normalised its line endings.
			if (!(await inWork(['status', '--porcelain'])).trim()) throw fail('INVALID', 'The team package already has this file as it is.');
			await inWork(['commit', '--quiet', '-m', `${summary.trim()}\n\nProposed with Snippet Editor for Espanso.`], { timeout: 60_000 });
			const sha = (await inWork(['rev-parse', 'HEAD'])).trim();
			await run(['push', '--quiet', 'origin', `refs/heads/${proposal}:refs/heads/${proposal}`], { timeout: 60_000 });
			return {
				branch: proposal,
				commit: sha,
				created,
				compareUrl: address.webUrl ? `${address.webUrl}/compare/${branch}...${proposal}?expand=1` : null,
			};
		} finally {
			await run(['worktree', 'remove', '--force', work]).catch(() => {});
			await fs.rm(work, { recursive: true, force: true });
			await run(['worktree', 'prune']).catch(() => {});
			await run(['branch', '--quiet', '-D', proposal]).catch(() => {});
		}
	}

	return {
		dir,
		connect: () => inTurn(connect),
		propose: (input = {}) => inTurn(() => propose(input)),
		fetch: () => inTurn(async () => (await needCloned(), fetch())),
		status: () => inTurn(status),
		packages: () => inTurn(async () => (({ packages, problems }) => ({ packages, problems }))(await listing())),

		// The files of one package, as they are in the commit, for installing.
		packageFiles: (name) =>
			inTurn(async () => {
				const { files } = await listing();
				const wanted = files.get(name);
				if (!wanted) throw fail('NOT_FOUND', `The team repository has no package named ${name}.`);
				const blobs = await readBlobs(wanted.map((file) => file.sha));
				return wanted.map((file) => ({ name: file.name, bytes: blobs.get(file.sha) }));
			}),

		disconnect: () =>
			inTurn(async () => {
				cache = null;
				await fs.rm(dir, { recursive: true, force: true });
			}),
	};
}
