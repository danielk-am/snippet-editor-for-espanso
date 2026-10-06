import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseDocument, stringify } from 'yaml';
import { isSafeFileName } from './store.js';
import { isPlainObject, oddBreak, toText } from '../shared/text.js';

// The app's copy of the team repository. It is a bare copy: nothing is
// checked out, and packages are read straight from the commit with git's own
// commands. So a symbolic link or a submodule in the repository is seen for
// what it is and never followed.

export const PACKAGE_NAME = /^[a-z0-9][a-z0-9-]{0,79}$/;
export const MANIFEST = '_manifest.yml';

const MEGABYTE = 1024 * 1024;
const LIMITS = { packages: 200, files: 50, fileBytes: 2 * MEGABYTE, manifestBytes: 64 * 1024, totalBytes: 12 * MEGABYTE };

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

// What a file holds, read leniently: this is a listing, not a save.
//
// A file this app cannot read counts as one that may run commands. Espanso
// reads some YAML this parser refuses, so "could not check" must never be
// shown as "nothing to worry about".
function scan(bytes) {
	const unread = { matchCount: null, runs: true };
	const text = bytes.toString('utf8');
	if (!Buffer.from(text, 'utf8').equals(bytes)) return unread;
	// A line break only Espanso reads can hide a command from this reader.
	if (oddBreak(text)) return unread;
	try {
		const doc = parseDocument(text, { uniqueKeys: false });
		if (doc.errors.length) return unread;
		const data = doc.toJS();
		return { matchCount: Array.isArray(data?.matches) ? data.matches.length : 0, runs: runsCommands(data) };
	} catch {
		return unread;
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
			if (/^(repo\.git\.tmp-|work-|index-)/.test(entry)) await fs.rm(path.join(dir, entry), { recursive: true, force: true });
		}
	}

	async function fetch() {
		// Which branch the team calls its main one today. Teams rename it, and
		// a repository that was empty gets its first branch later.
		const listed = await run(['ls-remote', '--symref', 'origin', 'HEAD'], { timeout: 60_000 });
		const named = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(listed)?.[1];
		if (named) {
			if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(named) || named.includes('..')) throw fail('GIT_FAILED', "The repository's main branch has a name the app cannot use.");
			if (named !== (await defaultBranch())) await run(['symbolic-ref', 'HEAD', `refs/heads/${named}`]);
			try {
				await run(['fetch', '--prune', '--no-tags', 'origin', `+refs/heads/${named}:refs/heads/${named}`], { timeout: 60_000 });
			} catch (error) {
				// Named, but with no commits on it yet.
				if (!/couldn't find remote ref/i.test(error.detail ?? '')) throw error;
			}
		}
		await fs.writeFile(stampFile, now().toISOString());
	}

	async function connect() {
		await fs.mkdir(dir, { recursive: true });
		await cleanUp();
		if (await cloned()) return fetch();
		const staging = `${repoDir}.tmp-${randomBytes(4).toString('hex')}`;
		try {
			// The remote is named here, whatever name the person's git would give it.
			await git(['clone', '--quiet', '--bare', '--single-branch', '--no-tags', '--origin', 'origin', '--', address.url, staging], { cwd: dir, timeout: 120_000 });
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
			else if (file === MANIFEST) {
				if (entry.size > max.manifestBytes) pkg.manifestTooLarge = true;
				else pkg.manifest = { sha: entry.sha, size: entry.size };
			} else if (!isSafeFileName(file)) note(`${file} was left out: that is not a match file name.`);
			else if (entry.size > max.fileBytes) note(`${file} was left out: it is larger than the app opens.`);
			else pkg.files.push({ name: file, sha: entry.sha, size: entry.size });
		}

		// Read what is needed to describe each package, within a budget.
		let budget = max.totalBytes;
		const wanted = [];
		for (const pkg of inside.values()) {
			pkg.files.sort(byName);
			// Many disks hold one file per name whatever its capitals, so only
			// one of two such files could be installed. The first is offered.
			const taken = new Map();
			pkg.files = pkg.files.filter((file) => {
				const first = taken.get(file.name.toLowerCase());
				if (first) pkg.problems.push(`${file.name} was left out: ${first} has the same name in other capitals.`);
				else taken.set(file.name.toLowerCase(), file.name);
				return !first;
			});
			if (pkg.files.length > max.files) {
				pkg.files = pkg.files.slice(0, max.files);
				pkg.problems.push(`Only the first ${max.files} files are included.`);
			}
			const cost = pkg.files.reduce((sum, file) => sum + file.size, pkg.manifest?.size ?? 0);
			pkg.read = cost <= budget;
			if (!pkg.read) continue;
			budget -= cost;
			wanted.push(...pkg.files.map((file) => file.sha), ...(pkg.manifest ? [pkg.manifest.sha] : []));
		}
		const blobs = await readBlobs([...new Set(wanted)]);

		const files = new Map();
		const packages = [...inside.values()].map((pkg) => {
			files.set(pkg.name, [...(pkg.manifest ? [{ name: MANIFEST, sha: pkg.manifest.sha }] : []), ...pkg.files.map(({ name, sha }) => ({ name, sha }))]);
			const manifestBytes = pkg.manifest && pkg.read ? blobs.get(pkg.manifest.sha) : null;
			const manifest = pkg.manifestTooLarge ? { data: {}, error: 'Its manifest is too large to read.' } : readManifest(manifestBytes);
			// The manifest is installed too, and a match file can import it, so
			// it is checked for commands like any other file.
			let runs = manifestBytes ? scan(manifestBytes).runs : false;
			const listed = pkg.files.map((file) => {
				const found = pkg.read ? scan(blobs.get(file.sha) ?? Buffer.alloc(0)) : { matchCount: null, runs: false };
				if (pkg.read && found.matchCount === null) pkg.problems.push(`${file.name} has YAML errors, so it could not be checked for commands.`);
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

	// The entries directly inside one folder of a commit, by their own names.
	const entriesIn = async (commit, folder) =>
		parseTree(await run(['ls-tree', '-z', commit, ...(folder ? [`${folder}/`] : [])])).map((entry) => ({ ...entry, name: entry.path.slice(folder ? folder.length + 1 : 0) }));
	// A name that differs from the wanted one only in capital letters. On many
	// disks the two would be one file, so such a pair is never created.
	const sameButForCapitals = (entries, wanted) => entries.find((entry) => entry.name !== wanted && entry.name.toLowerCase() === wanted.toLowerCase());
	const clash = (where, other, wanted) => fail('INVALID', `${where} already has ${other.name}, which differs from ${wanted} only in capital letters. Use that name, or another one.`);

	// Sends one file to a package as a new branch. The main branch is never
	// pushed, and nothing is forced: the only thing that reaches the team is a
	// branch someone can open a pull request from, or ignore.
	//
	// The commit is built inside git, with no files checked out. So whatever
	// the repository holds (a link, a filter, a hook), nothing of it is ever
	// written to or run on this computer.
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

		// The path must be real folders all the way down, with no other name
		// beside it that differs only in capitals.
		const notAFolder = () => fail('INVALID', `The repository has something other than a folder at packages/${name}, such as a link.`);
		const top = await entriesIn(commit, '');
		const root = top.find((entry) => entry.name === 'packages');
		if (root && root.type !== 'tree') throw notAFolder();
		if (!root && sameButForCapitals(top, 'packages')) throw clash('The repository', sameButForCapitals(top, 'packages'), 'packages');
		const folders = root ? await entriesIn(commit, 'packages') : [];
		const folder = folders.find((entry) => entry.name === name);
		if (folder && folder.type !== 'tree') throw notAFolder();
		if (!folder && sameButForCapitals(folders, name)) throw clash('The repository', sameButForCapitals(folders, name), name);
		const files = folder ? await entriesIn(commit, `packages/${name}`) : [];
		const existing = files.find((entry) => entry.name === fileName);
		if (existing && (existing.type !== 'blob' || existing.mode === '120000')) {
			throw fail('INVALID', `${fileName} is a link in the team repository, so it cannot be replaced from here.`);
		}
		if (!existing && sameButForCapitals(files, fileName)) throw clash('The package', sameButForCapitals(files, fileName), fileName);

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

		// A private index: the list of files the new commit will hold.
		const index = path.join(dir, `index-${randomBytes(4).toString('hex')}`);
		const staged = (args) => run(args, { env: { GIT_INDEX_FILE: index } });
		const stage = async (file, content) => {
			const blob = (await run(['hash-object', '-w', '--stdin'], { input: content })).trim();
			await staged(['update-index', '--add', '--cacheinfo', `100644,${blob},${file}`]);
		};
		try {
			await staged(['read-tree', commit]);
			await stage(`packages/${name}/${fileName}`, text);
			if (created) {
				const author = await run(['config', 'user.name']).then((out) => out.trim(), () => '');
				await stage(`packages/${name}/${MANIFEST}`, stringify({ name, title: title.trim(), description: description.trim(), version: '0.1.0', author }, { lineWidth: 0 }));
			}
			const tree = (await staged(['write-tree'])).trim();
			if (tree === (await run(['rev-parse', `${commit}^{tree}`])).trim()) throw fail('INVALID', 'The team package already has this file as it is.');
			const sha = (await run(['commit-tree', tree, '-p', commit, '-m', `${summary.trim()}\n\nProposed with Snippet Editor for Espanso.`], { timeout: 60_000 })).trim();
			// One commit, to one new branch. No "+", no --force.
			await run(['push', '--quiet', 'origin', `${sha}:refs/heads/${proposal}`], { timeout: 60_000 });
			return {
				branch: proposal,
				commit: sha,
				created,
				compareUrl: address.webUrl ? `${address.webUrl}/compare/${branch}...${proposal}?expand=1` : null,
			};
		} finally {
			await fs.rm(index, { force: true });
			await fs.rm(`${index}.lock`, { force: true });
		}
	}

	return {
		dir,
		connect: () => inTurn(connect),
		propose: (input = {}) => inTurn(() => propose(input)),
		fetch: () => inTurn(async () => (await needCloned(), fetch())),
		// Reading does not wait its turn. Git lets a reader work beside a fetch,
		// and a slow network must not hold up a look at what is already here.
		status,
		packages: async () => (({ packages, problems }) => ({ packages, problems }))(await listing()),

		// One package with its files, for installing. Both come from one
		// listing of one commit, and the files are read by their own ids, so a
		// fetch that lands meanwhile cannot mix two versions.
		async packageFiles(name) {
			const { commit, packages, files } = await listing();
			const wanted = files.get(name);
			if (!wanted) throw fail('NOT_FOUND', `The team repository has no package named ${name}.`);
			const blobs = await readBlobs(wanted.map((file) => file.sha));
			return { commit, package: packages.find((pkg) => pkg.name === name), files: wanted.map((file) => ({ name: file.name, bytes: blobs.get(file.sha) })) };
		},

		disconnect: () =>
			inTurn(async () => {
				cache = null;
				await fs.rm(dir, { recursive: true, force: true });
			}),
	};
}
