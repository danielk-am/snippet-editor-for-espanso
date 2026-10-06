import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRouter } from '../core/apiRouter.js';
import { createApiServer } from '../core/apiServer.js';
import { createService } from '../core/service.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/match', import.meta.url));
const TOKEN = 'a'.repeat(64);

// A raw request, so each test controls every header itself.
function send(port, { method = 'GET', path = '/api/v1/state', token = TOKEN, headers = {}, body, chunked = false } = {}) {
	return new Promise((resolve, reject) => {
		const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
		const request = http.request(
			{
				host: '127.0.0.1',
				port,
				method,
				path,
				headers: {
					...(token ? { Authorization: `Bearer ${token}` } : {}),
					...(payload === undefined ? {} : { 'Content-Type': 'application/json' }),
					// Without a length, Node sends the body in chunks.
					...(payload === undefined || chunked ? {} : { 'Content-Length': Buffer.byteLength(payload) }),
					...headers,
				},
			},
			(response) => {
				let text = '';
				response.setEncoding('utf8');
				response.on('data', (chunk) => (text += chunk));
				response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: text ? JSON.parse(text) : null }));
			}
		);
		request.on('error', reject);
		if (payload !== undefined) request.write(payload);
		request.end();
	});
}

// A listener over a stand-in router that records what reached it.
async function listening(t, options = {}) {
	const seen = [];
	let token = TOKEN;
	const server = createApiServer({
		handle: async (request) => {
			seen.push(request);
			return { status: 200, body: { ok: true } };
		},
		getToken: () => token,
		...options,
	});
	const { port, address } = await server.start(0);
	t.after(() => server.stop());
	return { server, port, address, seen, setToken: (next) => (token = next) };
}

const code = (reply) => [reply.status, reply.body?.error?.code];

test('the listener binds to 127.0.0.1 and nothing else', async (t) => {
	const { address, server } = await listening(t);
	assert.equal(address, '127.0.0.1');
	assert.equal(server.running, true);
});

test('a request with the token reaches the router with its method, path, query and body', async (t) => {
	const { port, seen } = await listening(t);
	const reply = await send(port, { method: 'PUT', path: '/api/v1/files/local%3Abase.yml/raw?x=1&y=two', body: { text: 'matches: []\n', version: 'v' } });
	assert.deepEqual([reply.status, reply.body], [200, { ok: true }]);
	assert.deepEqual(seen, [{ method: 'PUT', path: '/api/v1/files/local%3Abase.yml/raw', query: { x: '1', y: 'two' }, body: { text: 'matches: []\n', version: 'v' } }]);
	assert.match(reply.headers['content-type'], /^application\/json/);
	assert.equal(reply.headers['access-control-allow-origin'], undefined);
});

test('no token, a wrong token or a malformed header is 401 and never reaches the router', async (t) => {
	const { port, seen } = await listening(t);
	assert.deepEqual(code(await send(port, { token: null })), [401, 'UNAUTHORIZED']);
	assert.deepEqual(code(await send(port, { token: 'b'.repeat(64) })), [401, 'UNAUTHORIZED']);
	assert.deepEqual(code(await send(port, { token: null, headers: { Authorization: TOKEN } })), [401, 'UNAUTHORIZED']);
	assert.deepEqual(code(await send(port, { token: null, headers: { Authorization: `Basic ${TOKEN}` } })), [401, 'UNAUTHORIZED']);
	assert.equal((await send(port, { token: null })).headers['www-authenticate'], 'Bearer');
	assert.equal(seen.length, 0);
});

test('a request from a web page is refused, even with the right token', async (t) => {
	const { port, seen } = await listening(t);
	for (const origin of ['https://example.com', 'null', 'http://127.0.0.1:' + port]) {
		assert.deepEqual(code(await send(port, { headers: { Origin: origin } })), [403, 'FORBIDDEN'], origin);
	}
	assert.equal(seen.length, 0);
});

test('a request a browser made is refused even when it carries no Origin', async (t) => {
	// Browsers leave Origin off a plain cross-site GET, such as an image tag,
	// but they still label the request.
	const { port, seen } = await listening(t);
	for (const site of ['cross-site', 'same-site', 'same-origin', 'none']) {
		assert.deepEqual(code(await send(port, { headers: { 'Sec-Fetch-Site': site } })), [403, 'FORBIDDEN'], site);
	}
	assert.equal(seen.length, 0);
});

test('a request addressed to any other host name is refused', async (t) => {
	const { port, seen } = await listening(t);
	assert.deepEqual(code(await send(port, { headers: { Host: 'evil.example:' + port } })), [403, 'FORBIDDEN']);
	assert.deepEqual(code(await send(port, { headers: { Host: '127.0.0.1:1' } })), [403, 'FORBIDDEN']);
	assert.equal((await send(port, { headers: { Host: 'localhost:' + port } })).status, 200);
	assert.equal(seen.length, 1);
});

test('a body that is too large is 413', async (t) => {
	const { port, seen } = await listening(t, { maxBody: 1024 });
	assert.deepEqual(code(await send(port, { method: 'POST', path: '/api/v1/files', body: { name: 'x'.repeat(2000) } })), [413, 'TOO_LARGE']);
	assert.equal(seen.length, 0);
});

test('a body that grows past the limit without announcing its size is also 413', async (t) => {
	const { port, seen } = await listening(t, { maxBody: 1024 });
	const reply = await send(port, { method: 'POST', path: '/api/v1/files', body: { name: 'x'.repeat(2000) }, chunked: true });
	assert.deepEqual(code(reply), [413, 'TOO_LARGE']);
	assert.equal(seen.length, 0);
});

test('a body that is not JSON is 415, and broken JSON or a non-object is 400', async (t) => {
	const { port, seen } = await listening(t);
	assert.deepEqual(code(await send(port, { method: 'POST', path: '/api/v1/files', body: 'name=x', headers: { 'Content-Type': 'text/plain' } })), [415, 'UNSUPPORTED_TYPE']);
	assert.deepEqual(code(await send(port, { method: 'POST', path: '/api/v1/files', body: '{ broken' })), [400, 'INVALID']);
	assert.deepEqual(code(await send(port, { method: 'POST', path: '/api/v1/files', body: '[1, 2]' })), [400, 'INVALID']);
	assert.equal(seen.length, 0);
});

test('an address that cannot be read is 400, and a failure inside the listener is 500 and logged', async (t) => {
	const logged = [];
	const { port } = await listening(t, {
		handle: async () => {
			throw new Error('secret detail');
		},
		log: (error) => logged.push(error),
	});
	assert.deepEqual(code(await send(port, { path: '//%zz' })), [400, 'INVALID']);
	const reply = await send(port);
	assert.deepEqual(code(reply), [500, 'ERROR']);
	assert.ok(!JSON.stringify(reply.body).includes('secret detail'));
	assert.equal(logged.length, 1);
});

test('a client that never finishes its headers is cut off', async (t) => {
	const { port } = await listening(t, { headersTimeout: 300, checkInterval: 100 });
	const closed = await new Promise((resolve) => {
		const socket = net.connect(port, '127.0.0.1', () => socket.write('GET /api/v1/state HTTP/1.1\r\nHost: 127.0.0.1\r\n'));
		const giveUp = setTimeout(() => {
			socket.destroy();
			resolve(false);
		}, 4000);
		socket.on('data', () => {});
		socket.on('error', () => {});
		socket.on('close', () => {
			clearTimeout(giveUp);
			resolve(true);
		});
	});
	assert.equal(closed, true);
});

test('starting on a port that is taken fails with a clear message and leaves nothing running', async (t) => {
	const blocker = net.createServer();
	await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
	t.after(() => blocker.close());
	const taken = blocker.address().port;
	const server = createApiServer({ handle: async () => ({ status: 200, body: {} }), getToken: () => TOKEN });
	t.after(() => server.stop());
	await assert.rejects(server.start(taken), (error) => error.code === 'PORT_IN_USE' && error.message === `Port ${taken} is in use.`);
	assert.equal(server.running, false);
});

test('after the token is replaced the old one stops working at once', async (t) => {
	const { port, setToken } = await listening(t);
	assert.equal((await send(port)).status, 200);
	setToken('c'.repeat(64));
	assert.deepEqual(code(await send(port)), [401, 'UNAUTHORIZED']);
	assert.equal((await send(port, { token: 'c'.repeat(64) })).status, 200);
});

test('stopping the listener closes the port', async (t) => {
	const { server, port } = await listening(t);
	await server.stop();
	assert.equal(server.running, false);
	await assert.rejects(send(port), (error) => error.code === 'ECONNREFUSED');
});

test('a full write over HTTP reaches the file, through the real router', async (t) => {
	const root = mkdtempSync(join(tmpdir(), 'snippet-editor-server-'));
	const matchDir = join(root, 'match');
	cpSync(FIXTURES, matchDir, { recursive: true });
	const service = await createService({ userDataDir: join(root, 'data'), env: { SNIPPET_EDITOR_MATCH_DIR: matchDir } });
	const server = createApiServer({ handle: createRouter({ service }), getToken: () => TOKEN });
	const { port } = await server.start(0);
	t.after(async () => {
		await server.stop();
		service.dispose();
	});
	const file = '/api/v1/files/' + encodeURIComponent('local:base.yml');
	const before = readFileSync(join(matchDir, 'base.yml'), 'utf8');
	const { version } = (await send(port, { path: file })).body;
	const saved = await send(port, { method: 'PUT', path: file + '/snippets/0', body: { match: { trigger: ';hello', replace: 'Over HTTP' }, version } });
	assert.equal(saved.status, 200);
	assert.equal(readFileSync(join(matchDir, 'base.yml'), 'utf8'), before.replace('"Hello there"', '"Over HTTP"'));
	const stale = await send(port, { method: 'PUT', path: file + '/snippets/0', body: { match: { trigger: ';hello', replace: 'Again' }, version } });
	assert.deepEqual(code(stale), [409, 'CONFLICT']);
	assert.deepEqual(code(await send(port, { method: 'DELETE', path: file + '/snippets/0' })), [409, 'CONFLICT']);
});
