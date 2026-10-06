import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSettings, saveSettings } from '../core/settings.js';

const file = () => join(mkdtempSync(join(tmpdir(), 'snippet-editor-settings-')), 'nested', 'settings.json');
const DEFAULTS = { matchDirOverride: null, maxBackups: 20, apiEnabled: false, apiPort: 27187, teamRepository: null, aiWrite: false };

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
	await saveSettings(path, { matchDirOverride: 42, maxBackups: -3, apiEnabled: 'yes', apiPort: 80, teamRepository: ['x'], aiWrite: 'yes', surprise: true });
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
