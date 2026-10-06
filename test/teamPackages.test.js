import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MARKER, createTeamPackages } from '../core/teamPackages.js';

const AT = () => new Date(Date.UTC(2026, 9, 6, 10, 15, 0));
const file = (name, text) => ({ name, bytes: Buffer.from(text) });
const GOODBYES = [file('_manifest.yml', 'name: goodbyes\n'), file('package.yml', 'matches: []\n'), file('extra.yml', 'matches:\n  - trigger: ":x"\n    replace: "x"\n')];
const SOURCE = { repository: 'https://github.com/acme/team.git', commit: 'c'.repeat(40), tree: 't'.repeat(40) };

function setup() {
	const matchDir = join(mkdtempSync(join(tmpdir(), 'snippet-editor-teampkg-')), 'match');
	mkdirSync(matchDir);
	const packages = createTeamPackages({ matchDir, now: AT });
	const dir = (name) => join(matchDir, 'team', name);
	const read = (name, entry) => readFileSync(join(dir(name), entry), 'utf8');
	return { matchDir, packages, dir, read };
}

const rejectsWith = async (promise, code) => {
	let caught;
	await promise.catch((error) => (caught = error));
	assert.equal(caught?.code, code, caught?.message ?? 'expected a failure');
	return caught;
};

test('installing writes exactly the package files and a marker', async () => {
	const { packages, dir, read } = setup();
	const marker = await packages.install({ name: 'goodbyes', files: GOODBYES, ...SOURCE });
	assert.deepEqual(marker, { ...SOURCE, package: 'goodbyes', state: 'installed', installedAt: '2026-10-06T10:15:00.000Z' });
	assert.deepEqual(readdirSync(dir('goodbyes')).sort(), [MARKER, '_manifest.yml', 'extra.yml', 'package.yml']);
	assert.equal(read('goodbyes', 'extra.yml'), 'matches:\n  - trigger: ":x"\n    replace: "x"\n');
	assert.deepEqual(JSON.parse(read('goodbyes', MARKER)), marker);
	assert.deepEqual([...(await packages.installed())], [['goodbyes', marker]]);
});

test('updating replaces what changed, removes what was dropped, and records the new commit', async () => {
	const { packages, dir, read } = setup();
	await packages.install({ name: 'goodbyes', files: GOODBYES, ...SOURCE });
	writeFileSync(join(dir('goodbyes'), 'stray.yml'), 'matches: []\n');
	mkdirSync(join(dir('goodbyes'), 'stray-folder'));
	const next = [file('_manifest.yml', 'name: goodbyes\nversion: 0.2.0\n'), file('package.yml', 'matches:\n  - trigger: ":new"\n    replace: "new"\n')];
	const marker = await packages.install({ name: 'goodbyes', files: next, repository: SOURCE.repository, commit: 'd'.repeat(40), tree: 'u'.repeat(40) });
	assert.deepEqual([marker.commit, marker.tree, marker.state], ['d'.repeat(40), 'u'.repeat(40), 'installed']);
	assert.deepEqual(readdirSync(dir('goodbyes')).sort(), [MARKER, '_manifest.yml', 'package.yml']);
	assert.equal(read('goodbyes', 'package.yml'), 'matches:\n  - trigger: ":new"\n    replace: "new"\n');
});

test('a folder the app did not put there is refused and left exactly as it was', async () => {
	const { packages, dir, matchDir } = setup();
	mkdirSync(dir('goodbyes'), { recursive: true });
	writeFileSync(join(dir('goodbyes'), 'mine.yml'), 'matches: []\n');
	const error = await rejectsWith(packages.install({ name: 'goodbyes', files: GOODBYES, ...SOURCE }), 'EXISTS');
	assert.equal(error.message, 'A folder named goodbyes is already in match/team and was not put there by this app.');
	assert.deepEqual(readdirSync(dir('goodbyes')), ['mine.yml']);
	await rejectsWith(packages.remove('goodbyes'), 'READ_ONLY');
	assert.deepEqual(readdirSync(dir('goodbyes')), ['mine.yml']);
	assert.deepEqual([...(await packages.installed())], []);

	// A link is refused too, whatever it points at.
	const elsewhere = join(matchDir, '..', 'elsewhere');
	mkdirSync(elsewhere);
	writeFileSync(join(elsewhere, MARKER), '{}');
	symlinkSync(elsewhere, dir('support'));
	await rejectsWith(packages.install({ name: 'support', files: GOODBYES, ...SOURCE }), 'EXISTS');
	await rejectsWith(packages.remove('support'), 'READ_ONLY');
	assert.deepEqual(readdirSync(elsewhere), [MARKER]);
});

test('an install that was cut short shows as unfinished and is finished by installing again', async () => {
	const { packages, dir } = setup();
	mkdirSync(dir('goodbyes'), { recursive: true });
	writeFileSync(join(dir('goodbyes'), MARKER), JSON.stringify({ ...SOURCE, package: 'goodbyes', state: 'installing', installedAt: 'x' }));
	writeFileSync(join(dir('goodbyes'), '_incoming-package.yml'), 'matches: [');
	writeFileSync(join(dir('goodbyes'), '_manifest.yml'), 'name: goodbyes\n');
	assert.equal((await packages.installed()).get('goodbyes').state, 'installing');
	await packages.install({ name: 'goodbyes', files: GOODBYES, ...SOURCE });
	assert.deepEqual(readdirSync(dir('goodbyes')).sort(), [MARKER, '_manifest.yml', 'extra.yml', 'package.yml']);
	assert.equal((await packages.installed()).get('goodbyes').state, 'installed');
});

test('a marker that cannot be read still makes the folder the app\'s, as an unfinished install', async () => {
	const { packages, dir } = setup();
	mkdirSync(dir('goodbyes'), { recursive: true });
	writeFileSync(join(dir('goodbyes'), MARKER), '{ not json');
	assert.deepEqual((await packages.installed()).get('goodbyes'), { repository: '', package: 'goodbyes', commit: '', tree: '', state: 'installing', installedAt: '' });
	await packages.install({ name: 'goodbyes', files: GOODBYES, ...SOURCE });
	assert.equal((await packages.installed()).get('goodbyes').state, 'installed');
});

test('removing deletes the folder; a package that is not installed says so', async () => {
	const { packages, dir } = setup();
	await packages.install({ name: 'goodbyes', files: GOODBYES, ...SOURCE });
	await packages.remove('goodbyes');
	assert.equal(existsSync(dir('goodbyes')), false);
	const error = await rejectsWith(packages.remove('goodbyes'), 'NOT_FOUND');
	assert.equal(error.message, 'That package is not installed.');
});

test('names that could leave the folder are refused before anything is written', async () => {
	const { packages, matchDir } = setup();
	for (const name of ['../escape', 'Bad_Name', '', '.hidden', 'a/b', 42]) {
		await rejectsWith(packages.install({ name, files: GOODBYES, ...SOURCE }), 'INVALID');
		await rejectsWith(packages.remove(name), 'INVALID');
	}
	for (const bad of ['../../evil.yml', 'sub/dir.yml', 'notes.txt', '.hidden.yml', MARKER, '_incoming.tmp']) {
		await rejectsWith(packages.install({ name: 'goodbyes', files: [file(bad, 'matches: []\n')], ...SOURCE }), 'INVALID');
	}
	await rejectsWith(packages.install({ name: 'goodbyes', files: [{ name: 'package.yml', bytes: 'text, not bytes' }], ...SOURCE }), 'INVALID');
	await rejectsWith(packages.install({ name: 'goodbyes', files: [], ...SOURCE }), 'INVALID');
	assert.equal(existsSync(join(matchDir, 'team', 'goodbyes')), false);
	assert.deepEqual(readdirSync(join(matchDir, '..')), ['match']);
});

test('only folders that carry the marker and a package name count as installed', async () => {
	const { packages, dir, matchDir } = setup();
	await packages.install({ name: 'goodbyes', files: GOODBYES, ...SOURCE });
	mkdirSync(dir('unmarked'));
	mkdirSync(dir('Not_A_Name'));
	writeFileSync(join(dir('Not_A_Name'), MARKER), '{}');
	writeFileSync(join(matchDir, 'team', 'loose.yml'), 'matches: []\n');
	assert.deepEqual([...(await packages.installed()).keys()], ['goodbyes']);
	assert.deepEqual([...(await createTeamPackages({ matchDir: join(matchDir, 'nowhere') }).installed())], []);
});

test('two installs of one package at once leave a whole folder', async () => {
	const { packages, dir } = setup();
	const other = [file('_manifest.yml', 'name: goodbyes\nversion: 9\n'), file('other.yml', 'matches: []\n')];
	await Promise.all([packages.install({ name: 'goodbyes', files: GOODBYES, ...SOURCE }), packages.install({ name: 'goodbyes', files: other, ...SOURCE, tree: 'v'.repeat(40) })]);
	assert.deepEqual(readdirSync(dir('goodbyes')).sort(), [MARKER, '_manifest.yml', 'other.yml']);
	assert.deepEqual([(await packages.installed()).get('goodbyes').tree, (await packages.installed()).get('goodbyes').state], ['v'.repeat(40), 'installed']);
});

test('a match folder that cannot be written fails cleanly', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async () => {
	const { packages, matchDir } = setup();
	chmodSync(matchDir, 0o555);
	try {
		await rejectsWith(packages.install({ name: 'goodbyes', files: GOODBYES, ...SOURCE }), 'EACCES');
		assert.deepEqual(readdirSync(matchDir), []);
	} finally {
		chmodSync(matchDir, 0o755);
	}
});

test('if writing fails partway, the folder is still the app\'s and shows as unfinished', async () => {
	const { packages, dir } = setup();
	// The second file's bytes can be checked once, then fail when written.
	let reads = 0;
	const failing = {
		name: 'extra.yml',
		get bytes() {
			reads += 1;
			if (reads > 1) throw Object.assign(new Error('the disk gave up'), { code: 'EIO' });
			return Buffer.from('matches: []\n');
		},
	};
	await rejectsWith(packages.install({ name: 'goodbyes', files: [GOODBYES[1], failing], ...SOURCE }), 'EIO');
	assert.equal(existsSync(join(dir('goodbyes'), 'package.yml')), true);
	const marker = (await packages.installed()).get('goodbyes');
	assert.deepEqual([marker?.state, marker?.tree], ['installing', SOURCE.tree]);
	await packages.install({ name: 'goodbyes', files: GOODBYES, ...SOURCE });
	assert.equal((await packages.installed()).get('goodbyes').state, 'installed');
});

test('a file with the longest name a disk allows can be installed', async () => {
	const { packages, dir } = setup();
	const long = `${'n'.repeat(251)}.yml`;
	await packages.install({ name: 'goodbyes', files: [file(long, 'matches: []\n')], ...SOURCE });
	assert.deepEqual(readdirSync(dir('goodbyes')).sort(), [MARKER, long]);
});
