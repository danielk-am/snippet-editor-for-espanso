import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRouter } from '../core/apiRouter.js';
import { openChannel } from '../core/chat/channel.js';
import { createApiClient, createChatClient, dataDirFor } from '../mcp/client.mjs';
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

	// A token file that is not the app's token: the listener cannot prove it
	// holds it, so nothing is sent.
	writeFileSync(join(dataDir, 'api-token'), 'b'.repeat(64) + '\n');
	const error = await unreachable(client.request('GET', '/state'), /not reachable/);
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

// --- added after review -----------------------------------------------------------

test('another program on the app\'s port is never sent the token, whatever it answers', async (t) => {
	// The app is closed, or could not open its port, and something else has it.
	for (const answer of [
		(response) => response.end('{"files":[]}'),
		(response) => response.end('{"proof":"' + 'a'.repeat(64) + '"}'),
		(response) => response.writeHead(401).end('{"error":{"code":"UNAUTHORIZED","message":"Send the API token"}}'),
		(response) => response.writeHead(404).end('{}'),
	]) {
		const received = [];
		const impostor = http.createServer((request, response) => {
			received.push({ url: request.url, authorization: request.headers.authorization });
			response.setHeader('Content-Type', 'application/json');
			answer(response);
		});
		await new Promise((resolve) => impostor.listen(0, '127.0.0.1', resolve));
		t.after(() => impostor.close());
		const dataDir = mkdtempSync(join(tmpdir(), 'snippet-editor-mcpclient-'));
		writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ apiEnabled: true, apiPort: impostor.address().port }));
		writeFileSync(join(dataDir, 'api-token'), 'a'.repeat(64) + '\n');

		await unreachable(createApiClient({ dataDir }).request('GET', '/state'), /not reachable/);
		await unreachable(createApiClient({ dataDir }).request('POST', '/files', { body: { name: 'x.yml' } }), /not reachable/);
		assert.ok(received.length >= 2, 'the client should have asked for proof');
		assert.ok(received.every((request) => request.authorization === undefined && request.url.startsWith('/api/v1/proof?nonce=')), JSON.stringify(received));
		assert.ok(!JSON.stringify(received).includes('a'.repeat(64)));
	}
});

test('a proxy set in the environment is not used: the token and the snippets stay on this computer', async (t) => {
	const { dataDir } = await startApi(t);
	let viaProxy = 0;
	const proxy = net.createServer((socket) => {
		viaProxy += 1;
		socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
	});
	await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
	t.after(() => proxy.close());
	const address = `http://127.0.0.1:${proxy.address().port}`;
	const script = join(mkdtempSync(join(tmpdir(), 'snippet-editor-mcpclient-')), 'call.mjs');
	writeFileSync(
		script,
		`import { createApiClient } from ${JSON.stringify(fileURLToPath(new URL('../mcp/client.mjs', import.meta.url)))};
const reply = await createApiClient({ dataDir: process.env.DATA }).request('GET', '/state');
console.log(reply.status, reply.body.files.length);
`
	);
	const output = await new Promise((resolve) =>
		execFile(process.execPath, [script], { env: { PATH: process.env.PATH, DATA: dataDir, NODE_USE_ENV_PROXY: '1', HTTP_PROXY: address, http_proxy: address, HTTPS_PROXY: address, ALL_PROXY: address }, timeout: 20_000 }, (error, stdout, stderr) =>
			resolve(`${stdout.trim()}${error ? ` | ${stderr.trim().split('\n').at(-1)}` : ''}`)
		)
	);
	assert.equal(output, '200 4');
	assert.equal(viaProxy, 0);
});

test('if the app goes away in the middle of a call, the call fails plainly', async (t) => {
	const { createHmac } = await import('node:crypto');
	const token = 'a'.repeat(64);
	// Proves itself like the app, then drops the connection on the real request.
	const quitting = http.createServer((request, response) => {
		if (request.url.startsWith('/api/v1/proof?nonce=')) {
			response.setHeader('Content-Type', 'application/json');
			return response.end(JSON.stringify({ proof: createHmac('sha256', token).update(request.url.split('=')[1]).digest('hex') }));
		}
		request.socket.destroy();
	});
	await new Promise((resolve) => quitting.listen(0, '127.0.0.1', resolve));
	t.after(() => quitting.close());
	const dataDir = mkdtempSync(join(tmpdir(), 'snippet-editor-mcpclient-'));
	writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ apiEnabled: true, apiPort: quitting.address().port }));
	writeFileSync(join(dataDir, 'api-token'), token + '\n');
	await unreachable(createApiClient({ dataDir }).request('PUT', '/files/x/raw', { body: { text: 'matches: []\n', version: 'v' } }), /^Snippet Editor is not reachable\./);
});

// --- in chat: the listener a message is given --------------------------------------------

const ENDED = /^This chat has ended\. The person can send their message again\.$/;

async function chat(t, onProposal = async () => ({ id: 'p1' })) {
	const api = await startApi(t, { enabled: false });
	const channel = await openChannel({ dir: join(api.root, 'chat'), router: createRouter({ service: api.service, log: () => {} }), onProposal, log: () => {} });
	t.after(() => channel.close());
	return { ...api, channel, client: createChatClient({ sessionFile: channel.file }) };
}

test('in chat, the client finds the app through the file it is given, with the app\'s own API off', async (t) => {
	const { client } = await chat(t);
	const state = await client.request('GET', '/state');
	assert.equal(state.status, 200);
	assert.ok(state.body.files.some((file) => file.id === 'local:base.yml'));
	assert.equal((await client.request('GET', '/search', { query: { q: 'hello', limit: 5, unused: undefined } })).body[0].fileId, 'local:base.yml');
	assert.equal((await client.request('GET', '/files/local%3Anone.yml')).status, 404);
});

test('in chat, the file is read for every call, so the client follows the listener it names', async (t) => {
	const first = await chat(t);
	const second = await chat(t);
	const sessionFile = join(first.root, 'session.json');
	writeFileSync(sessionFile, readFileSync(first.channel.file));
	const client = createChatClient({ sessionFile });
	assert.equal((await client.request('GET', '/state')).body.matchDir, first.matchDir);
	writeFileSync(sessionFile, readFileSync(second.channel.file));
	assert.equal((await client.request('GET', '/state')).body.matchDir, second.matchDir);
});

test('in chat, a proposal is handed to the app, and its id or the app\'s objection comes back', async (t) => {
	const seen = [];
	const { client } = await chat(t, async (proposal) => {
		seen.push(proposal);
		if (proposal.args.name === 'taken.yml') throw Object.assign(new Error('A file named taken.yml exists. Choose another name, or change the existing file.'), { code: 'REFUSED' });
		if (proposal.args.name === 'fault.yml') throw new Error('disk on fire');
		return { id: 'p7' };
	});
	assert.deepEqual(await client.propose({ tool: 'snippets_create_file', args: { name: 'new.yml' } }), { id: 'p7' });
	assert.deepEqual(seen, [{ tool: 'snippets_create_file', args: { name: 'new.yml' } }]);
	assert.deepEqual(await client.propose({ tool: 'snippets_create_file', args: { name: 'taken.yml' } }), { error: 'A file named taken.yml exists. Choose another name, or change the existing file.' });
	assert.deepEqual(await client.propose({ tool: 'snippets_create_file', args: { name: 'fault.yml' } }), { error: 'Something went wrong inside the app.' });
});

test('in chat, a file that is gone, damaged or not a session means the chat has ended', async (t) => {
	const { channel, root } = await chat(t);
	const sessionFile = join(root, 'session.json');
	const client = createChatClient({ sessionFile });
	await unreachable(client.request('GET', '/state'), ENDED);
	// Some of these name the live listener, so only the check on the file stands between them and a call.
	const live = (rest) => JSON.stringify({ port: channel.port, ...rest });
	for (const content of ['', 'not json', '[]', '{"port":"80","token":"x"}', '{"port":80}', '{"port":70000,"token":"x"}', live({}), live({ token: '' }), live({ token: 5 })]) {
		writeFileSync(sessionFile, content);
		await unreachable(client.request('GET', '/state'), ENDED);
		await unreachable(client.propose({ tool: 'snippets_create_file', args: { name: 'x.yml' } }), ENDED);
	}
	// The answer is over: the listener has closed, and its file with it.
	const direct = createChatClient({ sessionFile: channel.file });
	writeFileSync(sessionFile, readFileSync(channel.file));
	await channel.close();
	await unreachable(direct.request('GET', '/state'), ENDED);
	await unreachable(client.request('GET', '/state'), ENDED);
});

test('in chat, the token is not sent to a listener that cannot prove it holds it', async (t) => {
	const received = [];
	const impostor = http.createServer((request, response) => {
		received.push({ url: request.url, authorization: request.headers.authorization });
		response.setHeader('Content-Type', 'application/json');
		response.end('{"proof":"' + 'b'.repeat(64) + '"}');
	});
	await new Promise((resolve) => impostor.listen(0, '127.0.0.1', resolve));
	t.after(() => impostor.close());
	const dir = mkdtempSync(join(tmpdir(), 'snippet-editor-chatclient-'));
	const sessionFile = join(dir, 'session.json');
	writeFileSync(sessionFile, JSON.stringify({ port: impostor.address().port, token: 'c'.repeat(64) }));
	const client = createChatClient({ sessionFile });
	await unreachable(client.request('GET', '/state'), ENDED);
	await unreachable(client.propose({ tool: 'snippets_create_file', args: { name: 'x.yml' } }), ENDED);
	assert.equal(received.length, 2);
	assert.ok(received.every((request) => request.authorization === undefined && request.url.startsWith('/api/v1/proof?nonce=')), JSON.stringify(received));
});

test('in chat, the switch is not the client\'s to answer for: it reports nothing it cannot know', async (t) => {
	const { client } = await chat(t);
	assert.deepEqual(await client.settings(), { apiEnabled: true, apiPort: null, aiWrite: false });
});
