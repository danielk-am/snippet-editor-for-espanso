import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApiClient, dataDirFor } from '../mcp/client.mjs';
import { sparePort, startApi } from './helpers/apiFixture.js';

const unreachable = async (promise, pattern) => {
	let caught;
	await promise.catch((error) => (caught = error));
	assert.equal(caught?.code, 'UNREACHABLE', caught?.message ?? 'expected a failure');
	if (pattern) assert.match(caught.message, pattern);
	return caught;
};

test('the data folder is the one the app uses on each platform, unless it is named outright', () => {
	assert.equal(dataDirFor({ env: {}, platform: 'darwin', home: '/Users/someone' }), '/Users/someone/Library/Application Support/Snippet Editor');
	assert.equal(dataDirFor({ env: { APPDATA: 'C:\\Users\\someone\\AppData\\Roaming' }, platform: 'win32', home: 'C:\\Users\\someone' }), 'C:\\Users\\someone\\AppData\\Roaming\\Snippet Editor');
	assert.equal(dataDirFor({ env: {}, platform: 'win32', home: 'C:\\Users\\someone' }), 'C:\\Users\\someone\\AppData\\Roaming\\Snippet Editor');
	assert.equal(dataDirFor({ env: {}, platform: 'linux', home: '/home/someone' }), '/home/someone/.config/Snippet Editor');
	assert.equal(dataDirFor({ env: { XDG_CONFIG_HOME: '/custom' }, platform: 'linux', home: '/home/someone' }), '/custom/Snippet Editor');
	assert.equal(dataDirFor({ env: { SNIPPET_EDITOR_DATA_DIR: '/elsewhere', XDG_CONFIG_HOME: '/custom' }, platform: 'linux', home: '/home/someone' }), '/elsewhere');
});

test('the settings are read from the app\'s file, with safe values when it is missing or damaged', async (t) => {
	const { dataDir, port } = await startApi(t, { aiWrite: true });
	assert.deepEqual(await createApiClient({ dataDir }).settings(), { apiEnabled: true, apiPort: port, aiWrite: true });
	const empty = mkdtempSync(join(tmpdir(), 'snippet-editor-mcpclient-'));
	assert.deepEqual(await createApiClient({ dataDir: empty }).settings(), { apiEnabled: false, apiPort: 27187, aiWrite: false });
	writeFileSync(join(empty, 'settings.json'), '{ not json');
	assert.deepEqual(await createApiClient({ dataDir: empty }).settings(), { apiEnabled: false, apiPort: 27187, aiWrite: false });
	writeFileSync(join(empty, 'settings.json'), JSON.stringify({ apiEnabled: 'yes', apiPort: '80', aiWrite: 1 }));
	assert.deepEqual(await createApiClient({ dataDir: empty }).settings(), { apiEnabled: false, apiPort: 27187, aiWrite: false });
});

test('a request reaches the API with the token and comes back as a status and a body', async (t) => {
	const { dataDir } = await startApi(t);
	const client = createApiClient({ dataDir });
	const state = await client.request('GET', '/state');
	assert.deepEqual([state.status, state.body.files.length], [200, 4]);
	const hits = await client.request('GET', '/search', { query: { q: 'goodbye', limit: 5, skipped: undefined } });
	assert.deepEqual(hits.body.map((hit) => hit.fileId), ['package:goodbyes:package.yml']);
	const missing = await client.request('GET', `/files/${encodeURIComponent('local:missing.yml')}`);
	assert.deepEqual([missing.status, missing.body.error.code], [404, 'NOT_FOUND']);
	const preview = await client.request('POST', '/yaml/preview', { body: { match: { trigger: ':a', replace: 'A' } } });
	assert.deepEqual([preview.status, preview.body], [200, { yaml: '- trigger: ":a"\n  replace: "A"\n' }]);
});

test('with the API switched off, no token, or nothing listening, the app is "not reachable"', async (t) => {
	const off = await startApi(t, { enabled: false });
	await unreachable(createApiClient({ dataDir: off.dataDir }).request('GET', '/state'), /^Snippet Editor is not reachable\. Open the app and switch on "API for other tools" in its Settings\.$/);

	const on = await startApi(t);
	rmSync(join(on.dataDir, 'api-token'));
	await unreachable(createApiClient({ dataDir: on.dataDir }).request('GET', '/state'), /not reachable/);

	const nobody = mkdtempSync(join(tmpdir(), 'snippet-editor-mcpclient-'));
	writeFileSync(join(nobody, 'settings.json'), JSON.stringify({ apiEnabled: true, apiPort: await sparePort() }));
	writeFileSync(join(nobody, 'api-token'), 'a'.repeat(64) + '\n');
	await unreachable(createApiClient({ dataDir: nobody }).request('GET', '/state'), /not reachable/);
	await unreachable(createApiClient({ dataDir: join(nobody, 'no-such-folder') }).request('GET', '/state'), /not reachable/);
});

test('an app that does not answer in time is reported, not waited for', async (t) => {
	const silent = net.createServer(() => {});
	await new Promise((resolve) => silent.listen(0, '127.0.0.1', resolve));
	t.after(() => silent.close());
	const dataDir = mkdtempSync(join(tmpdir(), 'snippet-editor-mcpclient-'));
	writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ apiEnabled: true, apiPort: silent.address().port }));
	writeFileSync(join(dataDir, 'api-token'), 'a'.repeat(64) + '\n');
	const started = Date.now();
	await unreachable(createApiClient({ dataDir }).request('GET', '/state', { timeout: 300 }), /^Snippet Editor did not answer in time\.$/);
	assert.ok(Date.now() - started < 3000);
});

test('a token replaced while the client runs is picked up, and one the app refuses is reported without being shown', async (t) => {
	const { dataDir, listener } = await startApi(t);
	const client = createApiClient({ dataDir });
	assert.equal((await client.request('GET', '/state')).status, 200);
	const before = readFileSync(join(dataDir, 'api-token'), 'utf8').trim();
	await listener.replaceToken();
	assert.notEqual(readFileSync(join(dataDir, 'api-token'), 'utf8').trim(), before);
	assert.equal((await client.request('GET', '/state')).status, 200);

	// A token file the app no longer honours.
	writeFileSync(join(dataDir, 'api-token'), 'b'.repeat(64) + '\n');
	const error = await unreachable(client.request('GET', '/state'), /refused/);
	assert.ok(!error.message.includes('b'.repeat(64)) && !JSON.stringify(error).includes('b'.repeat(64)));
});

test('a reply that is not what the API sends is treated as the app not being there', async (t) => {
	const impostor = net.createServer((socket) => socket.end('HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 12\r\n\r\n<html></html'));
	await new Promise((resolve) => impostor.listen(0, '127.0.0.1', resolve));
	t.after(() => impostor.close());
	const dataDir = mkdtempSync(join(tmpdir(), 'snippet-editor-mcpclient-'));
	mkdirSync(dataDir, { recursive: true });
	writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ apiEnabled: true, apiPort: impostor.address().port }));
	writeFileSync(join(dataDir, 'api-token'), 'a'.repeat(64) + '\n');
	await unreachable(createApiClient({ dataDir }).request('GET', '/state'), /not reachable/);
});

test('with the API switched off, the token is not sent to whatever else holds that port', async (t) => {
	let arrived = 0;
	const other = net.createServer((socket) => {
		arrived += 1;
		socket.end('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}');
	});
	await new Promise((resolve) => other.listen(0, '127.0.0.1', resolve));
	t.after(() => other.close());
	const dataDir = mkdtempSync(join(tmpdir(), 'snippet-editor-mcpclient-'));
	writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ apiEnabled: false, apiPort: other.address().port }));
	writeFileSync(join(dataDir, 'api-token'), 'a'.repeat(64) + '\n');
	await unreachable(createApiClient({ dataDir }).request('GET', '/state'), /not reachable/);
	assert.equal(arrived, 0);
});
