import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
import { createRouter } from '../core/apiRouter.js';
import { openChannel } from '../core/chat/channel.js';
import { startApi } from './helpers/apiFixture.js';

// One request to the listener, as the MCP server would send it.
function ask(port, { method = 'GET', path, token, body }) {
	return new Promise((resolve, reject) => {
		const payload = body === undefined ? undefined : JSON.stringify(body);
		const request = http.request(
			{
				host: '127.0.0.1',
				port,
				method,
				path,
				agent: false,
				headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(payload === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }) },
			},
			(response) => {
				let text = '';
				response.setEncoding('utf8');
				response.on('data', (chunk) => (text += chunk));
				response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(text) }));
			}
		);
		request.on('error', reject);
		request.end(payload);
	});
}

async function setup(t, onProposal = async () => ({ id: 'p1' })) {
	// The app's own API stays off: chat does not depend on that switch.
	const api = await startApi(t, { enabled: false });
	const errors = [];
	const router = createRouter({ service: api.service, log: () => {} });
	const dir = join(api.root, 'chat');
	const channel = await openChannel({ dir, router, onProposal, log: (error) => errors.push(error) });
	t.after(() => channel.close());
	const session = JSON.parse(readFileSync(channel.file, 'utf8'));
	return { ...api, dir, channel, session, errors, read: (name) => readFileSync(join(api.matchDir, name), 'utf8') };
}

test('a channel is a listener on this computer, and a file only its owner can read says where', async (t) => {
	const { dir, channel, session } = await setup(t);
	assert.deepEqual(Object.keys(session), ['port', 'token']);
	assert.equal(session.port, channel.port);
	assert.match(session.token, /^[a-f0-9]{64}$/);
	assert.match(channel.file, /chat-[a-f0-9]{16}\.json$/);
	assert.deepEqual(readdirSync(dir).length, 1);
	if (process.platform !== 'win32') assert.equal(statSync(channel.file).mode & 0o777, 0o600);

	const other = await setup(t);
	assert.notEqual(other.session.token, session.token);
	assert.notEqual(other.session.port, session.port);
});

test('it answers what the app can read, to a caller with the token and to nobody else', async (t) => {
	const { session } = await setup(t);
	const { port, token } = session;
	const state = await ask(port, { path: '/api/v1/state', token });
	assert.equal(state.status, 200);
	assert.ok(state.body.files.some((file) => file.id === 'local:base.yml'));
	assert.equal((await ask(port, { path: '/api/v1/files/local%3Abase.yml', token })).body.name, 'base.yml');
	assert.equal((await ask(port, { path: '/api/v1/search?q=hello', token })).body[0].fileId, 'local:base.yml');
	assert.equal((await ask(port, { path: '/api/v1/team', token })).body.connected, false);

	assert.equal((await ask(port, { path: '/api/v1/state' })).status, 401);
	assert.equal((await ask(port, { path: '/api/v1/state', token: 'f'.repeat(64) })).status, 401);
	assert.equal((await ask(port, { method: 'POST', path: '/api/v1/chat/proposals', body: { tool: 'snippets_create_file', args: { name: 'x.yml' } } })).status, 401);
});

test('it proves it holds the token before the token is sent to it', async (t) => {
	const { session } = await setup(t);
	const nonce = 'ab'.repeat(16);
	const reply = await ask(session.port, { path: `/api/v1/proof?nonce=${nonce}` });
	assert.equal(reply.status, 200);
	assert.equal(reply.body.proof, createHmac('sha256', session.token).update(nonce).digest('hex'));
});

test('nothing can be written through it: every route that changes something is closed', async (t) => {
	const { session, read, matchDir, service } = await setup(t);
	const { port, token } = session;
	await service.saveSettings({ aiWrite: true });
	const before = read('base.yml');
	const version = (await ask(port, { path: '/api/v1/files/local%3Abase.yml', token })).body.version;
	const closed = [
		['POST', '/api/v1/files', { name: 'new.yml' }],
		['DELETE', `/api/v1/files/local%3Abase.yml?version=${version}`],
		['PUT', '/api/v1/files/local%3Abase.yml/details', { description: 'x', prefix: '', version }],
		['PUT', '/api/v1/files/local%3Abase.yml/raw', { text: 'matches: []\n', version }],
		['POST', '/api/v1/files/local%3Abase.yml/snippets', { match: { trigger: ';x', replace: 'X' }, version }],
		['PUT', '/api/v1/files/local%3Abase.yml/snippets/0', { match: { trigger: ';x', replace: 'X' }, version }],
		['DELETE', `/api/v1/files/local%3Abase.yml/snippets/0?version=${version}`],
		['POST', '/api/v1/team/refresh', {}],
		['PUT', '/api/v1/team/packages/goodbyes/installed', {}],
		['DELETE', '/api/v1/team/packages/goodbyes/installed'],
		['POST', '/api/v1/team/proposals', { fileId: 'local:base.yml', package: 'goodbyes', summary: 'x' }],
		['POST', '/api/v1/yaml/preview', { match: { trigger: ';x', replace: 'X' } }],
		['POST', '/api/v1/yaml/parse', { text: 'a: 1' }],
		['POST', '/api/v1/yaml/stringify', { value: 1 }],
		['PUT', '/api/v1/state', {}],
		['PATCH', '/api/v1/files/local%3Abase.yml'],
	];
	for (const [method, path, body] of closed) {
		const reply = await ask(port, { method, path, token, body });
		assert.deepEqual(
			reply,
			{ status: 405, body: { error: { code: 'METHOD_NOT_ALLOWED', message: 'In chat a change is a proposal. Nothing is written through this listener.' } } },
			`${method} ${path}`
		);
	}
	assert.equal(read('base.yml'), before);
	assert.equal(existsSync(join(matchDir, 'new.yml')), false);
});

test('a proposal reaches the app as a tool and its inputs, and the app\'s answer comes back', async (t) => {
	const seen = [];
	const { session, errors } = await setup(t, async (proposal) => {
		seen.push(proposal);
		if (proposal.tool === 'snippets_delete_snippet') throw Object.assign(new Error('base.yml changed since you read it.'), { code: 'REFUSED' });
		if (proposal.tool === 'snippets_create_file') throw new Error('a fault with /private/detail in it');
		return { id: `p${seen.length}` };
	});
	const { port, token } = session;
	const path = '/api/v1/chat/proposals';
	const args = { file_id: 'local:base.yml', snippet: { trigger: ';x', replace: 'X' }, version: 'v' };

	assert.deepEqual(await ask(port, { method: 'POST', path, token, body: { tool: 'snippets_add_snippet', args, extra: 'dropped' } }), { status: 201, body: { id: 'p1' } });
	assert.deepEqual(seen, [{ tool: 'snippets_add_snippet', args }]);

	assert.deepEqual(await ask(port, { method: 'POST', path, token, body: { tool: 'snippets_delete_snippet', args: { file_id: 'local:base.yml', index: 0, version: 'old' } } }), {
		status: 422,
		body: { error: { code: 'REFUSED', message: 'base.yml changed since you read it.' } },
	});

	for (const body of [{}, { tool: 7, args: {} }, { tool: 'snippets_add_snippet' }, { tool: 'snippets_add_snippet', args: [] }, { tool: '', args: {} }]) {
		assert.deepEqual(await ask(port, { method: 'POST', path, token, body }), { status: 400, body: { error: { code: 'INVALID', message: '`tool` must be text and `args` a mapping.' } } }, JSON.stringify(body));
	}
	assert.equal(seen.length, 2);

	assert.equal((await ask(port, { path, token })).status, 405);

	// A fault inside the app is not described to the caller.
	const fault = await ask(port, { method: 'POST', path, token, body: { tool: 'snippets_create_file', args: { name: 'x.yml' } } });
	assert.deepEqual(fault, { status: 500, body: { error: { code: 'ERROR', message: 'Something went wrong inside the app.' } } });
	assert.equal(errors.length, 1);
});

test('closing it shuts the port and removes the file, and closing twice is fine', async (t) => {
	const { channel, session } = await setup(t);
	await channel.close();
	assert.equal(existsSync(channel.file), false);
	await assert.rejects(ask(session.port, { path: '/api/v1/state', token: session.token }), (error) => error.code === 'ECONNREFUSED');
	await channel.close();
});
