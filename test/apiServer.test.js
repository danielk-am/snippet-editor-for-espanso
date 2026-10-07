import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRouter } from '../core/apiRouter.js';
import { LIMITS, createApiServer } from '../core/apiServer.js';
import { createService } from '../core/service.js';
import { localGit } from './helpers/teamRemote.js';

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
	const service = await createService({ userDataDir: join(root, 'data'), env: { SNIPPET_EDITOR_MATCH_DIR: matchDir }, git: localGit(root) });
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

// --- added after review ---------------------------------------------------------

// One request written by hand, for what an HTTP library would not send.
function raw(port, text, { hold = 0 } = {}) {
	return new Promise((resolve) => {
		let received = '';
		const socket = net.connect(port, '127.0.0.1', () => {
			socket.write(text);
			// Hang up after `hold`, or give up after five seconds so a listener
			// that never answers fails the test instead of stalling it.
			setTimeout(() => socket.destroy(), hold || 5000).unref();
		});
		socket.setEncoding('utf8');
		socket.on('data', (chunk) => (received += chunk));
		socket.on('error', () => {});
		socket.on('close', () => resolve(received));
	});
}

test('the limits are the ones the design promises', () => {
	assert.deepEqual(LIMITS, { maxBody: 4 * 1024 * 1024, headersTimeout: 10_000, requestTimeout: 30_000 });
});

test('with no limit given, a body just under 4 MB is taken and one just over is 413', async (t) => {
	const { port, seen } = await listening(t);
	const under = await send(port, { method: 'POST', path: '/api/v1/files', body: { name: 'x'.repeat(4 * 1024 * 1024 - 100) } });
	assert.equal(under.status, 200);
	assert.equal(seen.length, 1);
	const over = await send(port, { method: 'POST', path: '/api/v1/files', body: { name: 'x'.repeat(4 * 1024 * 1024 + 100) } });
	assert.deepEqual(code(over), [413, 'TOO_LARGE']);
	assert.equal(seen.length, 1);
});

test('a body far over the limit still gets an answer the sender can read', async (t) => {
	// Twice the real limit, several times over: a listener that hangs up as
	// soon as it has seen enough leaves the sender with a broken connection.
	const { port, seen } = await listening(t);
	const body = { name: 'x'.repeat(8 * 1024 * 1024) };
	for (const chunked of [false, true, false, true]) {
		const reply = await send(port, { method: 'POST', path: '/api/v1/files', body, chunked }).catch((error) => ({ status: error.code }));
		assert.deepEqual(code(reply), [413, 'TOO_LARGE'], chunked ? 'in chunks' : 'with a length');
	}
	assert.equal(seen.length, 0);
});

test('a sender that stalls partway through its body is cut off', async (t) => {
	// Node takes the shorter of the two timeouts for the headers, so both are set.
	const { port, seen } = await listening(t, { headersTimeout: 200, requestTimeout: 300, checkInterval: 100 });
	const started = Date.now();
	const received = await raw(
		port,
		`POST /api/v1/files HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${TOKEN}\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{"name":`
	);
	assert.ok(Date.now() - started < 4000, 'the connection stayed open');
	assert.match(received, /^HTTP\/1\.1 408 /);
	assert.equal(seen.length, 0);
});

test('a request with no Host at all is refused', async (t) => {
	const { port, seen } = await listening(t);
	const received = await raw(port, `GET /api/v1/state HTTP/1.0\r\nAuthorization: Bearer ${TOKEN}\r\n\r\n`);
	assert.match(received, /^HTTP\/1\.[01] 403 /);
	assert.equal(seen.length, 0);
});

test('no refusal carries a cross-origin header', async (t) => {
	const { port } = await listening(t, { maxBody: 1024 });
	const refusals = [
		await send(port, { token: null }),
		await send(port, { headers: { Origin: 'https://example.com' } }),
		await send(port, { headers: { Host: 'evil.example' } }),
		await send(port, { method: 'POST', path: '/api/v1/files', body: { name: 'x'.repeat(2000) } }),
		await send(port, { method: 'POST', path: '/api/v1/files', body: 'x', headers: { 'Content-Type': 'text/plain' } }),
	];
	assert.deepEqual(refusals.map((reply) => reply.status), [401, 403, 403, 413, 415]);
	for (const reply of refusals) {
		const cors = Object.keys(reply.headers).filter((name) => name.startsWith('access-control-'));
		assert.deepEqual(cors, [], String(reply.status));
	}
});

test('a reply JSON cannot carry is refused as a whole, never sent altered', async (t) => {
	const logged = [];
	const self = [];
	self.push(self);
	for (const value of [Infinity, -Infinity, NaN, self]) {
		const { port } = await listening(t, { handle: async () => ({ status: 200, body: { value: [{ priority: value }] } }), log: (error) => logged.push(error) });
		const reply = await send(port);
		assert.deepEqual(code(reply), [422, 'UNREPRESENTABLE'], String(value));
		assert.match(reply.body.error.message, /JSON cannot carry/);
	}
	assert.equal(logged.length, 0);
});

test('a sender that hangs up partway is not recorded as a fault of the app', async (t) => {
	const logged = [];
	const { port, seen } = await listening(t, { log: (error) => logged.push(error) });
	await raw(
		port,
		`POST /api/v1/files HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${TOKEN}\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{"name":`,
		{ hold: 50 }
	);
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.deepEqual([logged.length, seen.length], [0, 0]);
	assert.equal((await send(port)).status, 200);
});

test('a port another program holds on every address counts as taken', async (t) => {
	const blocker = net.createServer();
	await new Promise((resolve) => blocker.listen(0, '0.0.0.0', resolve));
	t.after(() => blocker.close());
	const taken = blocker.address().port;
	const server = createApiServer({ handle: async () => ({ status: 200, body: {} }), getToken: () => TOKEN });
	t.after(() => server.stop());
	await assert.rejects(server.start(taken), (error) => error.code === 'PORT_IN_USE' && error.message === `Port ${taken} is in use.`);
	assert.equal(server.running, false);
});

test('the reply to a failure inside the listener is exactly the plain error', async (t) => {
	const { port } = await listening(t, { handle: async () => { throw new Error('secret detail'); }, log: () => {} });
	assert.deepEqual((await send(port)).body, { error: { code: 'ERROR', message: 'Something went wrong inside the app.' } });
});

test('a listener can prove it is this app without being sent the token', async (t) => {
	const { port, seen, setToken } = await listening(t);
	const nonce = 'ab'.repeat(16);
	const expected = (token) => createHmac('sha256', token).update(nonce).digest('hex');
	const reply = await send(port, { token: null, path: `/api/v1/proof?nonce=${nonce}` });
	assert.deepEqual([reply.status, reply.body], [200, { proof: expected(TOKEN) }]);
	setToken('c'.repeat(64));
	assert.deepEqual((await send(port, { token: null, path: `/api/v1/proof?nonce=${nonce}` })).body, { proof: expected('c'.repeat(64)) });
	// The proof is asked for before any token is sent, so it must never reach the routes.
	assert.equal(seen.length, 0);

	for (const bad of ['', 'short', 'zz'.repeat(16), 'ab'.repeat(40), `${nonce}&nonce=${nonce}`]) {
		assert.deepEqual(code(await send(port, { token: null, path: `/api/v1/proof?nonce=${bad}` })), [400, 'INVALID'], bad);
	}
	assert.deepEqual(code(await send(port, { token: null, path: `/api/v1/proof?nonce=${nonce}`, headers: { Origin: 'https://example.com' } })), [403, 'FORBIDDEN']);
	assert.deepEqual(code(await send(port, { token: null, path: `/api/v1/proof?nonce=${nonce}`, headers: { Host: 'evil.example' } })), [403, 'FORBIDDEN']);
	assert.deepEqual(code(await send(port, { token: null, method: 'POST', path: `/api/v1/proof?nonce=${nonce}`, body: {} })), [401, 'UNAUTHORIZED']);
	assert.deepEqual(code(await send(port, { token: null, path: '/api/v1/state' })), [401, 'UNAUTHORIZED']);
});

test('one file holding a value JSON cannot carry is marked, and the rest of the reply still arrives', async (t) => {
	const self = [];
	self.push(self);
	const NOTE = 'This file holds a value JSON cannot carry (a number that is not finite, or a list or mapping that contains itself), so its snippets are not listed here. Its text can still be read.';
	const good = { id: 'local:base.yml', name: 'base.yml', matchCount: 1, parseErrors: [], matches: [{ trigger: ':a', replace: 'A' }] };
	const odd = { id: 'local:odd.yml', name: 'odd.yml', matchCount: 1, parseErrors: [], matches: [{ trigger: ':o', replace: 'O', weight: Infinity }], text: 'matches:\n  - trigger: ":o"\n    replace: "O"\n    weight: .inf\n' };
	const marked = { ...odd, matchCount: null, parseErrors: [NOTE], matches: null, notCarried: true };
	const answer = async (body) => {
		const { port } = await listening(t, { handle: async () => ({ status: 200, body }) });
		return send(port);
	};

	// The list of everything.
	const state = await answer({ matchDir: '/m', files: [good, odd], packages: [{ name: 'p', files: [{ ...odd, id: 'package:p:odd.yml' }] }], team: [{ name: 't', files: [good] }] });
	assert.equal(state.status, 200);
	assert.deepEqual(state.body.files, [good, marked]);
	assert.deepEqual(state.body.packages[0].files, [{ ...marked, id: 'package:p:odd.yml' }]);
	assert.deepEqual(state.body.team[0].files, [good]);

	// One file on its own: its text is plain, and still sent.
	assert.deepEqual((await answer(odd)).body, marked);
	assert.deepEqual((await answer({ ...odd, matches: [{ trigger: ':c', vars: self }] })).body, { ...marked });

	// Search: hits that cannot be carried are left out.
	const hits = await answer([{ fileId: 'local:base.yml', index: 0, match: good.matches[0] }, { fileId: 'local:odd.yml', index: 0, match: odd.matches[0] }]);
	assert.deepEqual([hits.status, hits.body], [200, [{ fileId: 'local:base.yml', index: 0, match: good.matches[0] }]]);
});
