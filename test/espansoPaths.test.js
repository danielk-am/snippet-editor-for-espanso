import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveMatchDir } from '../core/espansoPaths.js';

const mac = { platform: 'darwin', homedir: '/Users/me', env: {}, exists: () => false };

test('macOS defaults to Application Support', () => {
	assert.deepEqual(resolveMatchDir(mac), {
		matchDir: '/Users/me/Library/Application Support/espanso/match',
		source: 'default',
	});
});

test('a folder chosen in Settings wins over everything else', () => {
	const out = resolveMatchDir({
		...mac,
		override: '/Volumes/work/match',
		env: { SNIPPET_EDITOR_MATCH_DIR: '/tmp/demo', ESPANSO_CONFIG_DIR: '/tmp/espanso' },
	});
	assert.deepEqual(out, { matchDir: '/Volumes/work/match', source: 'settings' });
});

test('SNIPPET_EDITOR_MATCH_DIR points straight at a match folder', () => {
	const out = resolveMatchDir({ ...mac, env: { SNIPPET_EDITOR_MATCH_DIR: '/tmp/demo' } });
	assert.deepEqual(out, { matchDir: '/tmp/demo', source: 'env' });
});

test("Espanso's own ESPANSO_CONFIG_DIR is honoured", () => {
	const out = resolveMatchDir({ ...mac, env: { ESPANSO_CONFIG_DIR: '/tmp/espanso' } });
	assert.deepEqual(out, { matchDir: '/tmp/espanso/match', source: 'env' });
});

test('an existing ~/.config/espanso is used before the platform default', () => {
	const out = resolveMatchDir({ ...mac, exists: (p) => p === '/Users/me/.config/espanso' });
	assert.deepEqual(out, { matchDir: '/Users/me/.config/espanso/match', source: 'legacy' });
});

test('Linux uses XDG_CONFIG_HOME, then ~/.config', () => {
	const linux = { platform: 'linux', homedir: '/home/me', exists: () => false };
	assert.equal(
		resolveMatchDir({ ...linux, env: { XDG_CONFIG_HOME: '/home/me/.cfg' } }).matchDir,
		'/home/me/.cfg/espanso/match'
	);
	assert.equal(resolveMatchDir({ ...linux, env: {} }).matchDir, '/home/me/.config/espanso/match');
});

test('Windows uses the roaming AppData folder', () => {
	const out = resolveMatchDir({
		platform: 'win32',
		homedir: 'C:\\Users\\me',
		env: { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' },
		exists: () => false,
	});
	assert.equal(out.matchDir, 'C:\\Users\\me\\AppData\\Roaming\\espanso\\match');
});
