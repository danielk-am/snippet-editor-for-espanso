import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from '../core/store.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/match', import.meta.url));

function sandbox({ copy = true, maxBackups = 20 } = {}) {
	const root = mkdtempSync(join(tmpdir(), 'snippet-editor-'));
	const matchDir = join(root, 'match');
	const backupDir = join(root, 'backups');
	if (copy) cpSync(FIXTURES, matchDir, { recursive: true });
	let tick = 0;
	const store = createStore({
		matchDir,
		backupDir,
		maxBackups,
		// Distinct, ordered backup names without waiting on the clock.
		now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)),
	});
	return { root, matchDir, backupDir, store };
}

const local = (name) => ({ source: 'local', name });
const read = (dir, name) => readFileSync(join(dir, name), 'utf8');

async function rejectsWithCode(promise, code) {
	await assert.rejects(promise, (error) => {
		assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
		return true;
	});
}

test('the inventory lists local files with counts, header metadata and problems', async () => {
	const { store } = sandbox();
	const inv = await store.inventory();
	assert.equal(inv.exists, true);
	const byName = Object.fromEntries(inv.files.map((f) => [f.name, f]));
	assert.deepEqual(Object.keys(byName), ['_shared.yml', 'base.yml', 'broken.yml', 'dates.yml']);
	assert.equal(byName['base.yml'].id, 'local:base.yml');
	assert.equal(byName['base.yml'].matchCount, 3);
	assert.equal(byName['base.yml'].description, 'Greetings for support replies');
	assert.equal(byName['base.yml'].prefix, ';');
	assert.equal(byName['base.yml'].readOnly, false);
	assert.equal(byName['base.yml'].importOnly, false);
	assert.equal(byName['_shared.yml'].importOnly, true);
	assert.equal(byName['broken.yml'].matchCount, null);
	assert.ok(byName['broken.yml'].parseErrors.length > 0);
	assert.equal(byName['dates.yml'].matchCount, 4);
});

test('the inventory lists installed packages as read-only with their manifest', async () => {
	const { store } = sandbox();
	const inv = await store.inventory();
	assert.equal(inv.packages.length, 1);
	const pkg = inv.packages[0];
	assert.equal(pkg.name, 'goodbyes');
	assert.equal(pkg.title, 'Goodbyes');
	assert.equal(pkg.version, '0.2.0');
	assert.equal(pkg.author, 'Example Author');
	assert.equal(pkg.matchCount, 2);
	assert.deepEqual(
		pkg.files.map((f) => [f.id, f.readOnly, f.matchCount]),
		[['package:goodbyes:package.yml', true, 2]]
	);
});

test('a missing match folder reads as empty and is not created by looking', async () => {
	const { store, matchDir } = sandbox({ copy: false });
	const inv = await store.inventory();
	assert.deepEqual([inv.exists, inv.files, inv.packages], [false, [], []]);
	assert.equal(existsSync(matchDir), false);
});

test('reading a file returns its text, matches and a version token', async () => {
	const { store, matchDir } = sandbox();
	const file = await store.readFile(local('base.yml'));
	assert.equal(file.text, read(matchDir, 'base.yml'));
	assert.equal(file.matches.length, 3);
	assert.equal(typeof file.version, 'string');
	assert.ok(file.version.length > 0);
});

test('updating a snippet writes the file and backs up what was there', async () => {
	const { store, matchDir, backupDir } = sandbox();
	const before = read(matchDir, 'base.yml');
	const file = await store.readFile(local('base.yml'));
	const saved = await store.updateMatch(local('base.yml'), {
		index: 0,
		match: { trigger: ';hello', replace: 'Hello again' },
		version: file.version,
	});
	assert.equal(read(matchDir, 'base.yml'), before.replace('"Hello there"', '"Hello again"'));
	assert.equal(saved.matches[0].replace, 'Hello again');
	assert.notEqual(saved.version, file.version);
	const backups = readdirSync(join(backupDir, 'local', 'base.yml'));
	assert.equal(backups.length, 1);
	assert.equal(read(join(backupDir, 'local', 'base.yml'), backups[0]), before);
});

test('a write against a stale version is refused and changes nothing', async () => {
	const { store, matchDir } = sandbox();
	const file = await store.readFile(local('base.yml'));
	writeFileSync(join(matchDir, 'base.yml'), file.text + '\n# edited elsewhere\n');
	const onDisk = read(matchDir, 'base.yml');
	await rejectsWithCode(
		store.updateMatch(local('base.yml'), {
			index: 0,
			match: { trigger: ';hello', replace: 'Mine' },
			version: 'stale-version-token',
		}),
		'CONFLICT'
	);
	assert.equal(read(matchDir, 'base.yml'), onDisk);
});

test('a write without a version is refused', async () => {
	const { store } = sandbox();
	await rejectsWithCode(
		store.deleteMatch(local('base.yml'), { index: 0 }),
		'CONFLICT'
	);
});

test('two writes racing on one version: the first lands, the second is refused', async () => {
	const { store } = sandbox();
	const file = await store.readFile(local('base.yml'));
	const results = await Promise.allSettled([
		store.createMatch(local('base.yml'), { match: { trigger: ';one', replace: '1' }, version: file.version }),
		store.createMatch(local('base.yml'), { match: { trigger: ';two', replace: '2' }, version: file.version }),
	]);
	assert.deepEqual(
		results.map((r) => r.status),
		['fulfilled', 'rejected']
	);
	assert.equal(results[1].reason.code, 'CONFLICT');
	const after = await store.readFile(local('base.yml'));
	assert.equal(after.matches.length, 4);
	assert.equal(after.matches[3].trigger, ';one');
});

test('creating a snippet after a position inserts it there', async () => {
	const { store } = sandbox();
	const file = await store.readFile(local('base.yml'));
	const saved = await store.createMatch(local('base.yml'), {
		match: { trigger: ';copy', replace: 'Hello there' },
		index: 1,
		version: file.version,
	});
	assert.equal(saved.matches[1].trigger, ';copy');
	assert.equal(saved.matches.length, 4);
});

test('deleting a snippet removes only that snippet', async () => {
	const { store } = sandbox();
	const file = await store.readFile(local('dates.yml'));
	const saved = await store.deleteMatch(local('dates.yml'), { index: 1, version: file.version });
	assert.deepEqual(
		saved.matches.map((m) => m.trigger ?? m.regex),
		[':today', ':ticket(?P<id>\\d+)', ':shrug']
	);
});

test('package files cannot be edited', async () => {
	const { store, matchDir } = sandbox();
	const ref = { source: 'package', package: 'goodbyes', name: 'package.yml' };
	const file = await store.readFile(ref);
	assert.equal(file.readOnly, true);
	const before = read(join(matchDir, 'packages', 'goodbyes'), 'package.yml');
	await rejectsWithCode(
		store.updateMatch(ref, { index: 0, match: { trigger: ':bye', replace: 'x' }, version: file.version }),
		'READ_ONLY'
	);
	await rejectsWithCode(store.saveRaw(ref, { text: 'matches: []\n', version: file.version }), 'READ_ONLY');
	await rejectsWithCode(store.deleteFile(ref, { version: file.version }), 'READ_ONLY');
	assert.equal(read(join(matchDir, 'packages', 'goodbyes'), 'package.yml'), before);
});

test('file names that leave the match folder are refused', async () => {
	const { store, root } = sandbox();
	for (const name of ['../escape.yml', 'sub/dir.yml', '..', 'notes.txt', '.hidden.yml', 'a\\b.yml', '']) {
		await rejectsWithCode(store.createFile({ name }), 'INVALID_NAME');
		await rejectsWithCode(store.readFile(local(name)), 'INVALID_NAME');
	}
	await rejectsWithCode(
		store.readFile({ source: 'package', package: '../..', name: 'package.yml' }),
		'INVALID_NAME'
	);
	assert.equal(existsSync(join(root, 'escape.yml')), false);
});

test('creating a file writes its header and refuses to overwrite', async () => {
	const { store, matchDir } = sandbox();
	const created = await store.createFile({ name: 'work.yml', description: 'Work replies', prefix: ':' });
	assert.equal(read(matchDir, 'work.yml'), '# Work replies\n# prefix: ":"\n\nmatches: []\n');
	assert.equal(created.id, 'local:work.yml');
	assert.equal(created.matchCount, 0);
	await rejectsWithCode(store.createFile({ name: 'work.yml' }), 'EXISTS');
	await rejectsWithCode(store.createFile({ name: 'BASE.yml' }), 'EXISTS');
});

test('creating the first file creates the match folder', async () => {
	const { store, matchDir } = sandbox({ copy: false });
	await store.createFile({ name: 'base.yml' });
	assert.equal(read(matchDir, 'base.yml'), 'matches: []\n');
});

test('deleting a file removes it and keeps a backup copy', async () => {
	const { store, matchDir, backupDir } = sandbox();
	const before = read(matchDir, 'dates.yml');
	const file = await store.readFile(local('dates.yml'));
	await store.deleteFile(local('dates.yml'), { version: file.version });
	assert.equal(existsSync(join(matchDir, 'dates.yml')), false);
	const backups = readdirSync(join(backupDir, 'local', 'dates.yml'));
	assert.equal(read(join(backupDir, 'local', 'dates.yml'), backups[0]), before);
});

test('saving raw YAML with errors is refused and leaves the file alone', async () => {
	const { store, matchDir } = sandbox();
	const before = read(matchDir, 'base.yml');
	const file = await store.readFile(local('base.yml'));
	await rejectsWithCode(
		store.saveRaw(local('base.yml'), { text: 'matches:\n  - trigger: "open\n', version: file.version }),
		'PARSE_ERROR'
	);
	assert.equal(read(matchDir, 'base.yml'), before);
});

test('a broken file can be repaired through the raw editor', async () => {
	const { store } = sandbox();
	const file = await store.readFile(local('broken.yml'));
	assert.equal(file.matches, null);
	await rejectsWithCode(
		store.createMatch(local('broken.yml'), { match: { trigger: ':a', replace: 'A' }, version: file.version }),
		'PARSE_ERROR'
	);
	const saved = await store.saveRaw(local('broken.yml'), {
		text: 'matches:\n  - trigger: ":oops"\n    replace: "fixed"\n',
		version: file.version,
	});
	assert.deepEqual(saved.matches, [{ trigger: ':oops', replace: 'fixed' }]);
	assert.deepEqual(saved.parseErrors, []);
});

test('saving header metadata rewrites only the header', async () => {
	const { store, matchDir } = sandbox();
	const before = read(matchDir, 'base.yml');
	const file = await store.readFile(local('base.yml'));
	const saved = await store.setHeader(local('base.yml'), {
		description: 'Replies',
		prefix: ':',
		version: file.version,
	});
	assert.equal(saved.description, 'Replies');
	assert.equal(saved.prefix, ':');
	assert.equal(
		read(matchDir, 'base.yml'),
		before.replace('# Greetings for support replies\n# prefix: ";"', '# Replies\n# prefix: ":"')
	);
});

test('writing through a symlinked file keeps the link and updates its target', async () => {
	const { store, matchDir, root } = sandbox();
	const target = join(root, 'elsewhere.yml');
	writeFileSync(target, 'matches:\n  - trigger: ":l"\n    replace: "linked"\n');
	symlinkSync(target, join(matchDir, 'linked.yml'));
	const file = await store.readFile(local('linked.yml'));
	await store.updateMatch(local('linked.yml'), {
		index: 0,
		match: { trigger: ':l', replace: 'changed' },
		version: file.version,
	});
	assert.equal(lstatSync(join(matchDir, 'linked.yml')).isSymbolicLink(), true);
	assert.equal(readFileSync(target, 'utf8'), 'matches:\n  - trigger: ":l"\n    replace: "changed"\n');
});

test('only the newest backups are kept', async () => {
	const { store, backupDir } = sandbox({ maxBackups: 2 });
	let file = await store.readFile(local('base.yml'));
	for (const text of ['one', 'two', 'three', 'four']) {
		file = await store.updateMatch(local('base.yml'), {
			index: 0,
			match: { trigger: ';hello', replace: text },
			version: file.version,
		});
	}
	const dir = join(backupDir, 'local', 'base.yml');
	const backups = readdirSync(dir).sort();
	assert.equal(backups.length, 2);
	// The two newest backups hold the states just before the last two writes.
	assert.ok(read(dir, backups[0]).includes('replace: "two"'));
	assert.ok(read(dir, backups[1]).includes('replace: "three"'));
});

test('search finds snippets across local files and packages', async () => {
	const { store } = sandbox();
	const hits = await store.search('goodbye');
	assert.deepEqual(
		hits.map((h) => [h.fileId, h.index, h.source]),
		[['package:goodbyes:package.yml', 0, 'package']]
	);
});

test('a file that is not valid UTF-8 is listed but never rewritten', async () => {
	const { store, matchDir } = sandbox();
	const bytes = Buffer.concat([Buffer.from('matches:\n  - trigger: ":c"\n    replace: "caf'), Buffer.from([0xe9]), Buffer.from('"\n')]);
	writeFileSync(join(matchDir, 'latin.yml'), bytes);
	const file = (await store.inventory()).files.find((candidate) => candidate.name === 'latin.yml');
	assert.equal(file.unreadable, true);
	assert.match(file.parseErrors[0], /UTF-8/);
	await rejectsWithCode(store.saveRaw(local('latin.yml'), { text: 'matches: []\n', version: file.version }), 'READ_ONLY');
	assert.ok(readFileSync(join(matchDir, 'latin.yml')).equals(bytes));
});

test('two names for one file cannot both write on the same version', async () => {
	const { store, matchDir } = sandbox();
	symlinkSync(join(matchDir, 'base.yml'), join(matchDir, 'alias-of-base.yml'));
	const viaName = await store.readFile(local('base.yml'));
	const viaLink = await store.readFile(local('alias-of-base.yml'));
	assert.equal(viaName.version, viaLink.version);
	const results = await Promise.allSettled([
		store.createMatch(local('base.yml'), { match: { trigger: ';one', replace: '1' }, version: viaName.version }),
		store.createMatch(local('alias-of-base.yml'), { match: { trigger: ';two', replace: '2' }, version: viaLink.version }),
	]);
	assert.deepEqual(results.map((result) => result.status).sort(), ['fulfilled', 'rejected']);
	assert.equal(results.find((result) => result.status === 'rejected').reason.code, 'CONFLICT');
	assert.equal((await store.readFile(local('base.yml'))).matches.length, 4);
});

test('the version follows the content, not the clock', async () => {
	const { store, matchDir } = sandbox();
	const path = join(matchDir, 'base.yml');
	const file = await store.readFile(local('base.yml'));
	const { atime, mtime } = statSync(path);
	writeFileSync(path, file.text.replace('Hello there', 'HELLO THERE'));
	utimesSync(path, atime, mtime);
	await rejectsWithCode(
		store.updateMatch(local('base.yml'), { index: 0, match: { trigger: ';hello', replace: 'Mine' }, version: file.version }),
		'CONFLICT'
	);
	assert.ok(read(matchDir, 'base.yml').includes('HELLO THERE'));
});

test('a write-protected file is read-only here too', async () => {
	const { store, matchDir } = sandbox();
	const path = join(matchDir, 'base.yml');
	const before = read(matchDir, 'base.yml');
	chmodSync(path, 0o444);
	const file = await store.readFile(local('base.yml'));
	assert.equal(file.readOnly, true);
	assert.equal(file.matchCount, 3);
	await rejectsWithCode(
		store.updateMatch(local('base.yml'), { index: 0, match: { trigger: ';hello', replace: 'Mine' }, version: file.version }),
		'READ_ONLY'
	);
	assert.equal(read(matchDir, 'base.yml'), before);
});

test('a saved file keeps its permissions', async () => {
	const { store, matchDir } = sandbox();
	const path = join(matchDir, 'base.yml');
	chmodSync(path, 0o664);
	const file = await store.readFile(local('base.yml'));
	await store.updateMatch(local('base.yml'), { index: 0, match: { trigger: ';hello', replace: 'Mine' }, version: file.version });
	assert.equal(statSync(path).mode & 0o777, 0o664);
});

test('backups made in the same instant are still kept newest-first', async () => {
	const root = mkdtempSync(join(tmpdir(), 'snippet-editor-'));
	const matchDir = join(root, 'match');
	cpSync(FIXTURES, matchDir, { recursive: true });
	const store = createStore({ matchDir, backupDir: join(root, 'backups'), maxBackups: 2, now: () => new Date(Date.UTC(2026, 0, 1)) });
	let file = await store.readFile(local('base.yml'));
	for (const text of ['one', 'two', 'three']) {
		file = await store.updateMatch(local('base.yml'), { index: 0, match: { trigger: ';hello', replace: text }, version: file.version });
	}
	const dir = join(root, 'backups', 'local', 'base.yml');
	const backups = readdirSync(dir).sort();
	assert.equal(backups.length, 2);
	assert.ok(read(dir, backups[0]).includes('replace: "one"'));
	assert.ok(read(dir, backups[1]).includes('replace: "two"'));
});

test('a write that would make the file too large to open again is refused', async () => {
	const { matchDir, backupDir } = sandbox();
	const store = createStore({ matchDir, backupDir, maxFileBytes: 2048 });
	const before = read(matchDir, 'base.yml');
	const file = await store.readFile(local('base.yml'));
	const big = 'x'.repeat(3000);
	await rejectsWithCode(store.saveRaw(local('base.yml'), { text: `matches:\n  - trigger: ":a"\n    replace: "${big}"\n`, version: file.version }), 'TOO_LARGE');
	await rejectsWithCode(store.createMatch(local('base.yml'), { match: { trigger: ':big', replace: big }, version: file.version }), 'TOO_LARGE');
	await rejectsWithCode(store.updateMatch(local('base.yml'), { index: 0, match: { trigger: ';hello', replace: big }, version: file.version }), 'TOO_LARGE');
	assert.equal(read(matchDir, 'base.yml'), before);
	assert.equal(existsSync(join(backupDir, 'local', 'base.yml')), false);
	// Still open, still editable: the refusal left nothing behind.
	const again = await store.readFile(local('base.yml'));
	assert.deepEqual([again.unreadable, again.version], [undefined, file.version]);
});

test('a description the header cannot hold is refused when creating a file, with the reason', async () => {
	const { store, matchDir } = sandbox();
	await assert.rejects(store.createFile({ name: 'work.yml', description: 'prefix: x' }), (error) => {
		assert.equal(error.code, 'INVALID');
		assert.match(error.message, /description cannot start with/);
		return true;
	});
	assert.equal(existsSync(join(matchDir, 'work.yml')), false);
});

test('reading one file that cannot be opened describes it instead of failing', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async () => {
	const { store, matchDir } = sandbox();
	const path = join(matchDir, 'base.yml');
	chmodSync(path, 0o000);
	try {
		const file = await store.readFile(local('base.yml'));
		assert.deepEqual([file.unreadable, file.readOnly, file.matches, file.parseErrors], [true, true, null, ['This file cannot be read: permission denied.']]);
		await rejectsWithCode(store.saveRaw(local('base.yml'), { text: 'matches: []\n', version: file.version }), 'READ_ONLY');
		await rejectsWithCode(store.deleteFile(local('base.yml'), { version: file.version }), 'READ_ONLY');
	} finally {
		chmodSync(path, 0o644);
	}
});

test('a folder with a file name is described, not opened', async () => {
	const { store, matchDir } = sandbox();
	mkdirSync(join(matchDir, 'folder.yml'));
	const file = await store.readFile(local('folder.yml'));
	assert.deepEqual([file.unreadable, file.parseErrors], [true, ['This is a folder, not a file.']]);
	await rejectsWithCode(store.saveRaw(local('folder.yml'), { text: 'matches: []\n', version: '' }), 'READ_ONLY');
	assert.equal(statSync(join(matchDir, 'folder.yml')).isDirectory(), true);
});

test('file names with control characters are refused', async () => {
	const { store, matchDir } = sandbox();
	const before = readdirSync(matchDir).sort();
	// A line break, a tab, an escape and a delete character.
	for (const code of [10, 9, 27, 127]) {
		const name = `a${String.fromCharCode(code)}b.yml`;
		await rejectsWithCode(store.createFile({ name }), 'INVALID_NAME');
		await rejectsWithCode(store.readFile(local(name)), 'INVALID_NAME');
	}
	assert.deepEqual(readdirSync(matchDir).sort(), before);
});

// --- team packages: a third, read-only source ------------------------------------

function withTeam() {
	const context = sandbox();
	const dir = join(context.matchDir, 'team', 'farewells');
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, '_manifest.yml'), 'name: farewells\ntitle: Farewells\ndescription: Ways to part\nversion: 1.0.0\nauthor: Team Lead\n');
	writeFileSync(join(dir, 'package.yml'), 'matches:\n  - trigger: ":farewell"\n    replace: "Farewell, and thank you."\n');
	writeFileSync(join(dir, '.snippet-editor.json'), '{}\n');
	return { ...context, dir };
}
const team = (name, pkg = 'farewells') => ({ source: 'team', package: pkg, name });

test('installed team packages are listed beside packages, in the same shape', async () => {
	const { store } = withTeam();
	const inv = await store.inventory();
	assert.equal(inv.packages.length, 1);
	assert.equal(inv.team.length, 1);
	const [pkg] = inv.team;
	assert.deepEqual([pkg.name, pkg.title, pkg.description, pkg.version, pkg.author, pkg.manifestError, pkg.matchCount], ['farewells', 'Farewells', 'Ways to part', '1.0.0', 'Team Lead', '', 1]);
	assert.deepEqual(pkg.files.map((file) => [file.id, file.source, file.package, file.name, file.readOnly, file.matchCount]), [['team:farewells:package.yml', 'team', 'farewells', 'package.yml', true, 1]]);
	assert.deepEqual((await sandbox().store.inventory()).team, []);
});

test('a team file can be read and searched, and never changed', async () => {
	const { store, dir } = withTeam();
	const before = read(dir, 'package.yml');
	const file = await store.readFile(team('package.yml'));
	assert.deepEqual([file.id, file.text, file.readOnly, file.matches.length], ['team:farewells:package.yml', before, true, 1]);
	const hits = await store.search('farewell');
	assert.deepEqual(hits.map((hit) => [hit.fileId, hit.source, hit.package, hit.index]), [['team:farewells:package.yml', 'team', 'farewells', 0]]);

	const match = { trigger: ':farewell', replace: 'Mine now' };
	for (const write of [
		store.updateMatch(team('package.yml'), { index: 0, match, version: file.version }),
		store.createMatch(team('package.yml'), { match, version: file.version }),
		store.deleteMatch(team('package.yml'), { index: 0, version: file.version }),
		store.saveRaw(team('package.yml'), { text: 'matches: []\n', version: file.version }),
		store.setHeader(team('package.yml'), { description: 'x', prefix: '', version: file.version }),
		store.deleteFile(team('package.yml'), { version: file.version }),
	]) {
		await rejectsWithCode(write, 'READ_ONLY');
	}
	assert.equal(read(dir, 'package.yml'), before);
});

test('a link in a team package, or a team package that is a link, is not read', async () => {
	const { store, root, matchDir, dir } = withTeam();
	writeFileSync(join(root, 'outside.yml'), 'matches:\n  - trigger: ":leak"\n    replace: "outside the folder"\n');
	symlinkSync(join(root, 'outside.yml'), join(dir, 'linked.yml'));
	mkdirSync(join(root, 'elsewhere'));
	writeFileSync(join(root, 'elsewhere', 'package.yml'), 'matches:\n  - trigger: ":elsewhere"\n    replace: "x"\n');
	symlinkSync(join(root, 'elsewhere'), join(matchDir, 'team', 'linked'));

	const inv = await store.inventory();
	assert.deepEqual(inv.team.map((pkg) => [pkg.name, pkg.files.map((file) => file.name)]), [['farewells', ['package.yml']]]);
	await rejectsWithCode(store.readFile(team('linked.yml')), 'NOT_FOUND');
	await rejectsWithCode(store.readFile(team('package.yml', 'linked')), 'NOT_FOUND');
	assert.deepEqual(await store.search('leak'), []);
	assert.deepEqual(await store.search('elsewhere'), []);
});

test('a team file is named by a package name and a file name, nothing else', async () => {
	const { store } = withTeam();
	for (const ref of [team('package.yml', '../packages/goodbyes'), team('../../base.yml'), team('package.yml', ''), { source: 'team', name: 'package.yml' }, { source: 'shared', package: 'farewells', name: 'package.yml' }]) {
		await rejectsWithCode(store.readFile(ref), 'INVALID_NAME');
	}
});
