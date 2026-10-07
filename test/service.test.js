import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createService } from '../core/service.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/match', import.meta.url));

async function setup(t) {
	const root = mkdtempSync(join(tmpdir(), 'snippet-editor-service-'));
	const matchDir = join(root, 'match');
	cpSync(FIXTURES, matchDir, { recursive: true });
	const service = await createService({ userDataDir: join(root, 'data'), env: { SNIPPET_EDITOR_MATCH_DIR: matchDir } });
	t.after(() => service.dispose());
	return { root, matchDir, service };
}

test('state names the folder, where it came from, and a backups folder inside the data folder', async (t) => {
	const { root, matchDir, service } = await setup(t);
	const state = await service.state();
	assert.equal(state.matchDir, matchDir);
	assert.equal(state.matchDirSource, 'env');
	assert.equal(state.files.length, 4);
	assert.equal(state.maxBackups, 20);
	assert.deepEqual([state.teamConnected, state.team], [false, []]);
	assert.deepEqual([service.teams(), service.team()], [[], null]);
	assert.ok(state.backupDir.startsWith(join(root, 'data', 'backups')));
});

test('settings are handed out as a copy and saved through the service', async (t) => {
	const { root, service } = await setup(t);
	const copy = service.settings();
	copy.apiPort = 1;
	assert.equal(service.settings().apiPort, 27187);
	const saved = await service.saveSettings({ apiEnabled: true, apiPort: 30123 });
	assert.deepEqual([saved.apiEnabled, saved.apiPort], [true, 30123]);
	assert.deepEqual([service.settings().apiEnabled, service.settings().apiPort], [true, 30123]);
	assert.equal(service.tokenFile, join(root, 'data', 'api-token'));
});

test('the list of team repositories in the settings is handed out as a copy too', async (t) => {
	const { service } = await setup(t);
	await service.saveSettings({ teamRepositories: ['https://github.com/acme/team.git'] });
	const saved = await service.saveSettings({ maxBackups: 9 });
	saved.teamRepositories.push('https://github.com/acme/other.git');
	service.settings().teamRepositories.length = 0;
	assert.deepEqual(service.settings().teamRepositories, ['https://github.com/acme/team.git']);
});

test('with no team repository, the team status lists none and nothing is waited for', async (t) => {
	const { service } = await setup(t);
	assert.equal(await service.teamFetched(), undefined);
	const empty = { connected: false, repositories: [], installedOnly: [], problem: '' };
	assert.deepEqual(await service.teamStatus(), empty);
	// Checking for updates with none connected is not a failure: it answers the
	// same. So does disconnecting one that is not there.
	assert.deepEqual([await service.refreshTeam(), await service.disconnectTeam('0123456789ab')], [empty, empty]);
	// Disconnecting has to say which. With none said, it says so.
	await assert.rejects(service.disconnectTeam(), { code: 'INVALID', message: 'No repository was named, so nothing was disconnected.' });
});

test('choosing another match folder switches the files and the backups folder', async (t) => {
	const { root, service } = await setup(t);
	const before = (await service.state()).backupDir;
	const other = join(root, 'other');
	mkdirSync(other);
	writeFileSync(join(other, 'solo.yml'), 'matches: []\n');
	await service.setMatchDir(other);
	const state = await service.state();
	assert.deepEqual([state.matchDir, state.matchDirSource], [other, 'settings']);
	assert.deepEqual(state.files.map((file) => file.name), ['solo.yml']);
	assert.notEqual(state.backupDir, before);
});
