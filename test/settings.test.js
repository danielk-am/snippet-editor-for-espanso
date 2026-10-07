import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { MAX_TEAM_REPOSITORIES, loadSettings, saveSettings } from '../core/settings.js';

const file = () => join(mkdtempSync(join(tmpdir(), 'snippet-editor-settings-')), 'nested', 'settings.json');
const DEFAULTS = { matchDirOverride: null, maxBackups: 20, apiEnabled: false, apiPort: 27187, teamRepositories: [], aiWrite: false };

test('settings default to the Espanso folder, twenty backups and the API listener off', async () => {
	assert.deepEqual(await loadSettings(file()), DEFAULTS);
});

test('a saved setting is read back, and unsaved ones keep their defaults', async () => {
	const path = file();
	const saved = await saveSettings(path, { matchDirOverride: '/Volumes/work/match' });
	assert.deepEqual(saved, { ...DEFAULTS, matchDirOverride: '/Volumes/work/match' });
	assert.deepEqual(await loadSettings(path), saved);
});

test('saving one setting keeps the others', async () => {
	const path = file();
	await saveSettings(path, { maxBackups: 5 });
	await saveSettings(path, { matchDirOverride: '/tmp/m' });
	assert.deepEqual(await loadSettings(path), { ...DEFAULTS, matchDirOverride: '/tmp/m', maxBackups: 5 });
});

test('a damaged settings file falls back to defaults instead of failing', async () => {
	const path = file();
	await saveSettings(path, { maxBackups: 5 });
	writeFileSync(path, '{ not json');
	assert.deepEqual(await loadSettings(path), DEFAULTS);
});

test('values of the wrong shape are ignored', async () => {
	const path = file();
	await saveSettings(path, { matchDirOverride: 42, maxBackups: -3, apiEnabled: 'yes', apiPort: 80, teamRepository: ['x'], teamRepositories: 'x', aiWrite: 'yes', surprise: true });
	assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), DEFAULTS);
});

test('the API listener can be switched on and given another port', async () => {
	const path = file();
	await saveSettings(path, { apiEnabled: true, apiPort: 30000 });
	assert.deepEqual(await loadSettings(path), { ...DEFAULTS, apiEnabled: true, apiPort: 30000 });
});

test('a port outside 1024 to 65535, or one that is not a whole number, is refused', async () => {
	const path = file();
	for (const apiPort of [0, 1023, 65536, 3.5, '27187', null]) {
		assert.equal((await saveSettings(path, { apiPort })).apiPort, 27187, String(apiPort));
	}
});

test('AI tools may change snippets only once that is switched on', async () => {
	const path = file();
	assert.equal((await loadSettings(path)).aiWrite, false);
	assert.equal((await saveSettings(path, { aiWrite: true })).aiWrite, true);
	for (const value of [1, 'true', null, {}]) assert.equal((await saveSettings(path, { aiWrite: value })).aiWrite, false, String(value));
});

// --- several team repositories ------------------------------------------------

const write = (path, raw) => {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(raw));
};
const onDisk = (path) => JSON.parse(readFileSync(path, 'utf8'));

test('the defaults are a fresh list each time, so one caller cannot change another\'s', async () => {
	const first = await loadSettings(file());
	first.teamRepositories.push('acme/team');
	assert.deepEqual((await loadSettings(file())).teamRepositories, []);
	const path = file();
	write(path, '{ not json');
	assert.deepEqual((await loadSettings(path)).teamRepositories, []);
});

test('team repositories are saved as a list and read back in order', async () => {
	const path = file();
	const saved = await saveSettings(path, { teamRepositories: ['https://github.com/acme/team.git', 'git@github.com:acme/other.git'] });
	assert.deepEqual(saved.teamRepositories, ['https://github.com/acme/team.git', 'git@github.com:acme/other.git']);
	assert.deepEqual(await loadSettings(path), { ...DEFAULTS, teamRepositories: ['https://github.com/acme/team.git', 'git@github.com:acme/other.git'] });
	assert.deepEqual((await saveSettings(path, { teamRepositories: [] })).teamRepositories, []);
});

test('a settings file from before, with one team repository, is read as a list of one', async () => {
	const path = file();
	write(path, { maxBackups: 7, teamRepository: 'https://github.com/acme/team.git' });
	assert.deepEqual(await loadSettings(path), { ...DEFAULTS, maxBackups: 7, teamRepositories: ['https://github.com/acme/team.git'] });
	// Reading changes nothing on disk.
	assert.deepEqual(onDisk(path), { maxBackups: 7, teamRepository: 'https://github.com/acme/team.git' });
});

test('the old key is gone after the next save, and the repository is kept', async () => {
	const path = file();
	write(path, { teamRepository: 'https://github.com/acme/team.git' });
	const saved = await saveSettings(path, { maxBackups: 5 });
	assert.deepEqual(saved, { ...DEFAULTS, maxBackups: 5, teamRepositories: ['https://github.com/acme/team.git'] });
	assert.deepEqual(onDisk(path), saved);
	assert.equal('teamRepository' in onDisk(path), false);
});

test('the old key is not a setting any more: the list wins over it, and saving it changes nothing', async () => {
	const path = file();
	write(path, { teamRepository: 'acme/old', teamRepositories: ['acme/new'] });
	assert.deepEqual((await loadSettings(path)).teamRepositories, ['acme/new']);
	write(path, { teamRepository: 'acme/old', teamRepositories: [] });
	assert.deepEqual((await loadSettings(path)).teamRepositories, []);
	const saved = await saveSettings(path, { teamRepository: 'acme/again' });
	assert.deepEqual([saved.teamRepositories, 'teamRepository' in saved, 'teamRepository' in onDisk(path)], [[], false, false]);
});

test('an old key of the wrong shape is ignored', async () => {
	for (const teamRepository of [null, '', 42, ['acme/team'], { url: 'acme/team' }, 'x'.repeat(301)]) {
		const path = file();
		write(path, { teamRepository });
		assert.deepEqual((await loadSettings(path)).teamRepositories, [], JSON.stringify(teamRepository).slice(0, 40));
	}
});

test('a list of the wrong shape is ignored, and the old key beside it is still read', async () => {
	for (const teamRepositories of ['x', 42, null, { 0: 'acme/team' }, true]) {
		const path = file();
		write(path, { teamRepositories });
		assert.deepEqual((await loadSettings(path)).teamRepositories, [], JSON.stringify(teamRepositories));
		write(path, { teamRepositories, teamRepository: 'acme/team' });
		assert.deepEqual((await loadSettings(path)).teamRepositories, ['acme/team'], JSON.stringify(teamRepositories));
	}
});

test('entries that are not text, are empty or are over 300 characters are left out, and the rest keep their order', async () => {
	const path = file();
	const long = `acme/${'x'.repeat(295)}`;
	assert.equal(long.length, 300);
	const saved = await saveSettings(path, { teamRepositories: ['acme/one', 42, null, '', ['acme/nested'], { url: 'acme/object' }, `${long}y`, long, 'acme/two'] });
	assert.deepEqual(saved.teamRepositories, ['acme/one', long, 'acme/two']);
	assert.deepEqual(onDisk(path).teamRepositories, ['acme/one', long, 'acme/two']);
});

test('a repeat is dropped and the first keeps its place', async () => {
	const path = file();
	const saved = await saveSettings(path, { teamRepositories: ['acme/one', 'acme/two', 'acme/one', 'acme/three', 'acme/two'] });
	assert.deepEqual(saved.teamRepositories, ['acme/one', 'acme/two', 'acme/three']);
});

test('ten repositories are kept and an eleventh is dropped', async () => {
	assert.equal(MAX_TEAM_REPOSITORIES, 10);
	const path = file();
	const eleven = Array.from({ length: 11 }, (_, index) => `acme/team-${index + 1}`);
	assert.deepEqual((await saveSettings(path, { teamRepositories: eleven.slice(0, 10) })).teamRepositories, eleven.slice(0, 10));
	assert.deepEqual((await saveSettings(path, { teamRepositories: eleven })).teamRepositories, eleven.slice(0, 10));
	// Entries that are left out do not use up a place.
	assert.deepEqual((await saveSettings(path, { teamRepositories: [7, 'acme/team-1', ...eleven] })).teamRepositories, eleven.slice(0, 10));
});
