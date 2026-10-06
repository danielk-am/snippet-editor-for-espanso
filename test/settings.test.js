import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSettings, saveSettings } from '../core/settings.js';

const file = () => join(mkdtempSync(join(tmpdir(), 'snippet-editor-settings-')), 'nested', 'settings.json');

test('settings default to the Espanso folder and twenty backups', async () => {
	assert.deepEqual(await loadSettings(file()), { matchDirOverride: null, maxBackups: 20 });
});

test('a saved setting is read back, and unsaved ones keep their defaults', async () => {
	const path = file();
	const saved = await saveSettings(path, { matchDirOverride: '/Volumes/work/match' });
	assert.deepEqual(saved, { matchDirOverride: '/Volumes/work/match', maxBackups: 20 });
	assert.deepEqual(await loadSettings(path), saved);
});

test('saving one setting keeps the others', async () => {
	const path = file();
	await saveSettings(path, { maxBackups: 5 });
	await saveSettings(path, { matchDirOverride: '/tmp/m' });
	assert.deepEqual(await loadSettings(path), { matchDirOverride: '/tmp/m', maxBackups: 5 });
});

test('a damaged settings file falls back to defaults instead of failing', async () => {
	const path = file();
	await saveSettings(path, { maxBackups: 5 });
	writeFileSync(path, '{ not json');
	assert.deepEqual(await loadSettings(path), { matchDirOverride: null, maxBackups: 20 });
});

test('values of the wrong shape are ignored', async () => {
	const path = file();
	await saveSettings(path, { matchDirOverride: 42, maxBackups: -3, surprise: true });
	assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { matchDirOverride: null, maxBackups: 20 });
});
