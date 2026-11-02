import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicFile } from './atomicFile.js';
import { isSafeFileName } from './store.js';
import { parseRepositoryAddress, repositoryKey } from './teamAddress.js';
import { MANIFEST, PACKAGE_NAME } from './teamRepo.js';
import { repositoryLabel } from '../shared/repositoryLabel.js';
import { isPlainObject, toText } from '../shared/text.js';

// Team packages as Espanso sees them: one folder each under match/team/.
// Espanso loads every .yml in there, so what the folder holds is what runs.
//
// Packages are prepared in full outside match/ and activated with directory
// renames. The recovery layout records whether activation reached either
// rename; on restart it restores the old package or retains its predecessor.
// A folder is the app's only if it carries the marker file.
//
// The marker also names the repository the package came from, and the package
// belongs to that one. With several repositories connected, two can offer a
// package of one name. There is one folder for a name, so only the repository
// that holds it may replace it, until it is removed.

export const MARKER = '.snippet-editor.json';

const fail = (code, message) => Object.assign(new Error(message), { code });
const isPackageFile = (name) => name === MANIFEST || isSafeFileName(name);

// What a caller is told when the name is held by another repository's
// package. The holder is named as owner/repo. `connected: false` adds that it
// is not connected now: its package is then found on the Team packages page
// under the repositories that are not connected, and nowhere else. The
// routes and the assistant's cards say it in these words too.
export const heldBy = (name, repository, { connected = true } = {}) =>
	`A package named ${name} is already installed from ${repositoryLabel(repository)}${connected ? '' : ', which is not connected'}. Remove it first, then install this one.`;

// `allowLocal` exists for tests, whose repositories are folders on this
// computer. The app itself never passes it.
export function createTeamPackages({ matchDir, now = () => new Date(), allowLocal = false }) {
	const root = path.join(matchDir, 'team');
	const folder = (name) => path.join(root, name);
	// Outside match/: neither staged files nor rollback copies can expand.
	const recoveryBase = path.join(path.dirname(matchDir), '.snippet-editor-package-recovery');
	const recoveryDir = path.join(recoveryBase, path.basename(matchDir));
	const transactions = path.join(recoveryDir, 'transactions');
	const previousRoot = path.join(recoveryDir, 'previous');
	const exists = async (file) => fs.lstat(file).then(() => true, (error) => { if (error.code === 'ENOENT') return false; throw error; });
	const directory = async (dir) => {
		await fs.mkdir(dir, { recursive: true });
		if (!(await fs.lstat(dir)).isDirectory()) throw fail('READ_ONLY', 'The package recovery folder is not a directory.');
	};

	const checkDirectory = async (dir) => {
		if (await exists(dir) && !(await fs.lstat(dir)).isDirectory()) throw fail('READ_ONLY', 'A package or recovery folder is not a directory.');
	};
	async function checkParents() {
		// Check each ancestor before looking beneath it: lstat on the final
		// component alone still follows symlinks in its parent path.
		for (const dir of [root, recoveryBase, recoveryDir, transactions, previousRoot]) await checkDirectory(dir);
	}

	async function finish(name, transaction) {
		const previous = path.join(transaction, 'previous');
		if (await exists(previous)) {
			await directory(previousRoot);
			await fs.rm(path.join(previousRoot, name), { recursive: true, force: true });
			await fs.rename(previous, path.join(previousRoot, name));
		}
		await fs.rm(transaction, { recursive: true, force: true });
	}

	async function recover() {
		await checkParents();
		if (!(await exists(transactions))) return;
		if (!(await fs.lstat(transactions)).isDirectory()) throw fail('READ_ONLY', 'The package recovery folder is not a directory.');
		for (const entry of await fs.readdir(transactions, { withFileTypes: true })) {
			if (!PACKAGE_NAME.test(entry.name) || !entry.isDirectory()) throw fail('READ_ONLY', 'An unexpected entry is in the package recovery folder.');
			const transaction = path.join(transactions, entry.name);
			const previous = path.join(transaction, 'previous');
			const next = path.join(transaction, 'next');
			const target = folder(entry.name);
			await checkDirectory(target);
			await checkDirectory(next);
			if (await exists(previous)) {
				if (!(await fs.lstat(previous)).isDirectory()) throw fail('READ_ONLY', 'The package recovery copy is not a directory.');
				if (!(await exists(target))) {
					// Interrupted between the two renames: put back the complete old copy.
					await fs.rename(previous, target);
				} else if (!(await exists(next))) {
					// The complete new package is active. Retain its predecessor.
					await finish(entry.name, transaction);
					continue;
				} else throw fail('CONFLICT', 'A package changed during recovery. Its recovery copies were kept.');
			}
			// A preparation that never reached activation has no live effects.
			await fs.rm(transaction, { recursive: true, force: true });
		}
	}

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
			throw fail('EXISTS', heldBy(name, marker.repository));
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


	async function install({ name, files, repository, commit, tree }) {
		checkName(name);
		if (!Array.isArray(files) || !files.length) throw fail('INVALID', 'That package has no files to install.');
		const names = new Set();
		for (const file of files) {
			if (!isPackageFile(file?.name) || !Buffer.isBuffer(file.bytes) || names.has(file.name.toLowerCase())) throw fail('INVALID', 'That package holds a file that cannot be installed.');
			names.add(file.name.toLowerCase());
		}
		await recover();
		const existing = await markerOf(name);
		if (existing === false) throw fail('EXISTS', `A folder named ${name} is already in match/team and was not put there by this app.`);
		refuseIfHeld(name, existing, repository);
		await directory(root);
		await directory(recoveryBase);
		await directory(recoveryDir);
		await directory(transactions);
		const transaction = path.join(transactions, name);
		const next = path.join(transaction, 'next');
		const previous = path.join(transaction, 'previous');
		const marker = { repository: toText(repository), package: name, commit: toText(commit), tree: toText(tree), state: 'installed', installedAt: now().toISOString() };
		try {
			await fs.mkdir(next, { recursive: true });
			for (const file of files) await atomicFile(path.join(next, file.name), file.bytes);
			await atomicFile(path.join(next, MARKER), JSON.stringify(marker, null, '\t') + '\n');
			// Recheck ownership after staging, before changing the active folder.
			const current = await markerOf(name);
			if (current === false) throw fail('EXISTS', 'The package folder changed while preparing the update.');
			refuseIfHeld(name, current, repository);
			if (await exists(folder(name))) await fs.rename(folder(name), previous);
			await fs.rename(next, folder(name));
			await finish(name, transaction);
			return marker;
		} catch (error) {
			// Recovery also works on the next launch if this process is killed.
			await recover().catch(() => {});
			throw error;
		}
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
		recover: () => inTurn(recover),
		installed: () => inTurn(async () => { await recover(); return installed(); }),
		install: (input = {}) => inTurn(() => install(input)),
		checkFree: (name, repository) => inTurn(() => checkFree(name, repository)),
		remove: (name) => inTurn(async () => { await recover(); return remove(name); }),
	};
}
