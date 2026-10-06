import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { LEGACY, MODERN, createProtocol } from '../mcp/protocol.mjs';

const SERVER = { name: 'snippet-editor', title: 'Snippet Editor for Espanso', version: '0.1.0' };
const TOOLS = [{ name: 'snippets_search', description: 'Find snippets.', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } }];
const META = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} };
const SERVER_META = { 'io.modelcontextprotocol/serverInfo': SERVER };

function setup({ call, logged = [] } = {}) {
	const calls = [];
	const protocol = createProtocol({
		serverInfo: SERVER,
		instructions: 'Search before you change anything.',
		tools: {
			list: () => TOOLS,
			call: async (name, args) => {
				calls.push([name, args]);
				if (call) return call(name, args);
				return name === 'snippets_search' ? { content: [{ type: 'text', text: 'found' }], isError: false } : null;
			},
		},
		log: (entry) => logged.push(entry),
	});
	const send = async (message) => {
		const line = await protocol.handleLine(typeof message === 'string' ? message : JSON.stringify(message));
		return line === null ? null : JSON.parse(line);
	};
	return { protocol, send, calls, logged };
}

const request = (id, method, params) => ({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
const modern = (id, method, params = {}) => request(id, method, { ...params, _meta: META });
const initialize = (version = '2025-11-25') => request(1, 'initialize', { protocolVersion: version, capabilities: {}, clientInfo: { name: 'ExampleClient', version: '1.0.0' } });

// --- the older shape: a handshake first ---------------------------------------------

test('initialize answers with the requested version, the tools capability and who the server is', async () => {
	const { send } = setup();
	assert.deepEqual(await send(initialize()), {
		jsonrpc: '2.0',
		id: 1,
		result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: SERVER, instructions: 'Search before you change anything.' },
	});
});

test('each older version is spoken, and an unknown one is answered with the newest older one', async () => {
	assert.deepEqual(LEGACY, ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);
	for (const version of LEGACY) assert.equal((await setup().send(initialize(version))).result.protocolVersion, version);
	for (const version of ['1.0.0', '2026-07-28', undefined, 42]) assert.equal((await setup().send(initialize(version))).result.protocolVersion, '2025-11-25', String(version));
});

test('after the handshake, requests need no version and results are in the older form', async () => {
	const { send, calls } = setup();
	await send(initialize());
	assert.equal(await send({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
	assert.deepEqual(await send(request(2, 'tools/list')), { jsonrpc: '2.0', id: 2, result: { tools: TOOLS } });
	assert.deepEqual(await send(request(3, 'tools/call', { name: 'snippets_search', arguments: { query: 'bye' } })), {
		jsonrpc: '2.0',
		id: 3,
		result: { content: [{ type: 'text', text: 'found' }], isError: false },
	});
	assert.deepEqual(calls, [['snippets_search', { query: 'bye' }]]);
	assert.deepEqual(await send(request('p', 'ping')), { jsonrpc: '2.0', id: 'p', result: {} });
	assert.deepEqual((await send(request(4, 'server/discover'))).error.code, -32601);
});

test('before the handshake, a request with no version is refused with the versions the server speaks, but a ping is answered', async () => {
	const { send, calls } = setup();
	const refused = await send(request(1, 'tools/list'));
	assert.equal(refused.error.code, -32602);
	assert.match(refused.error.message, /2026-07-28/);
	assert.match(refused.error.message, /initialize/);
	assert.deepEqual(refused.error.data, { supported: [...MODERN, ...LEGACY] });
	assert.equal((await send(request(2, 'tools/call', { name: 'snippets_search', arguments: {} }))).error.code, -32602);
	assert.deepEqual(calls, []);
	assert.deepEqual(await send(request(3, 'ping')), { jsonrpc: '2.0', id: 3, result: {} });
});

// --- the newer shape: every request carries its version --------------------------------

test('server/discover answers with the version, capabilities, instructions and the server name', async () => {
	const { send } = setup();
	assert.deepEqual(await send(modern('discover-1', 'server/discover')), {
		jsonrpc: '2.0',
		id: 'discover-1',
		result: {
			resultType: 'complete',
			supportedVersions: ['2026-07-28'],
			capabilities: { tools: {} },
			instructions: 'Search before you change anything.',
			ttlMs: 3600000,
			cacheScope: 'public',
			_meta: SERVER_META,
		},
	});
});

test('a request that carries the newer version is served with no handshake', async () => {
	const { send, calls } = setup();
	// The list of tools never changes, so a client may keep it; the newer shape must say so.
	assert.deepEqual(await send(modern(1, 'tools/list')), { jsonrpc: '2.0', id: 1, result: { resultType: 'complete', tools: TOOLS, ttlMs: 3600000, cacheScope: 'public', _meta: SERVER_META } });
	assert.deepEqual(await send(modern(2, 'tools/call', { name: 'snippets_search', arguments: { query: 'bye' } })), {
		jsonrpc: '2.0',
		id: 2,
		result: { resultType: 'complete', content: [{ type: 'text', text: 'found' }], isError: false, _meta: SERVER_META },
	});
	assert.deepEqual(calls, [['snippets_search', { query: 'bye' }]]);
	assert.deepEqual(await send(modern(3, 'ping')), { jsonrpc: '2.0', id: 3, result: { resultType: 'complete', _meta: SERVER_META } });
});

test('a version the server does not speak is refused with the list of those it does', async () => {
	const { send } = setup();
	const reply = await send(request(1, 'tools/list', { _meta: { ...META, 'io.modelcontextprotocol/protocolVersion': '1900-01-01' } }));
	assert.deepEqual(reply, {
		jsonrpc: '2.0',
		id: 1,
		// Only the versions this path serves: naming an older one here would send the client round in a circle.
		error: { code: -32022, message: 'Unsupported protocol version', data: { supported: MODERN, requested: '1900-01-01' } },
	});
});

test('the newer shape needs the client capabilities on every request', async () => {
	const { send } = setup();
	const reply = await send(request(1, 'tools/list', { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } }));
	assert.equal(reply.error.code, -32602);
	assert.match(reply.error.message, /clientCapabilities/);
});

test('both shapes can be served by one process', async () => {
	const { send } = setup();
	await send(initialize());
	assert.equal((await send(request(2, 'tools/list'))).result.resultType, undefined);
	assert.equal((await send(modern(3, 'tools/list'))).result.resultType, 'complete');
});

// --- what both shapes share ------------------------------------------------------------

test('an unknown tool and malformed call parameters are protocol errors', async () => {
	const { send } = setup();
	await send(initialize());
	assert.deepEqual((await send(request(2, 'tools/call', { name: 'no_such_tool', arguments: {} }))).error, { code: -32602, message: 'Unknown tool: no_such_tool' });
	for (const params of [undefined, {}, { name: 5 }, { name: 'snippets_search', arguments: 'text' }, { name: 'snippets_search', arguments: [1] }]) {
		assert.equal((await send(request(3, 'tools/call', params))).error.code, -32602, JSON.stringify(params));
	}
	// No arguments at all means none.
	assert.equal((await send(request(4, 'tools/call', { name: 'snippets_search' }))).result.isError, false);
});

test('an unknown method is -32601, in either shape', async () => {
	const { send } = setup();
	assert.deepEqual((await send(modern(1, 'resources/list'))).error, { code: -32601, message: 'Method not found: resources/list' });
	await send(initialize());
	assert.equal((await send(request(2, 'prompts/list'))).error.code, -32601);
});

test('what is not a request gets the right error, and never stops the server', async () => {
	const { send } = setup();
	assert.deepEqual(await send('{ not json'), { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
	assert.deepEqual(await send('[]'), { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
	assert.equal((await send('"text"')).error.code, -32600);
	assert.deepEqual(await send({ jsonrpc: '2.0', id: 7 }), { jsonrpc: '2.0', id: 7, error: { code: -32600, message: 'Invalid Request' } });
	assert.equal((await send({ jsonrpc: '1.0', id: 8, method: 'ping' })).error.code, -32600);
	assert.equal((await send({ jsonrpc: '2.0', id: null, method: 'ping' })).error.code, -32600);
	assert.equal((await send({ jsonrpc: '2.0', id: { nested: 1 }, method: 'ping' })).error.code, -32600);
	assert.deepEqual(await send(request(9, 'ping')), { jsonrpc: '2.0', id: 9, result: {} });
});

test('notifications and stray replies get no answer', async () => {
	const { send } = setup();
	for (const message of [
		{ jsonrpc: '2.0', method: 'notifications/initialized' },
		{ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 99 } },
		{ jsonrpc: '2.0', method: 'notifications/something/else' },
		{ jsonrpc: '2.0', id: 1, result: {} },
		{ jsonrpc: '2.0', id: 1, error: { code: 1, message: 'x' } },
	]) {
		assert.equal(await send(message), null, JSON.stringify(message));
	}
	assert.equal(await send(''), null);
	assert.equal(await send('   '), null);
});

test('a tool that throws is an internal error, logged, with nothing of the cause in the reply', async () => {
	const logged = [];
	const { send } = setup({
		logged,
		call: () => {
			throw new Error('secret path /Users/someone/token');
		},
	});
	await send(initialize());
	const reply = await send(request(2, 'tools/call', { name: 'snippets_search', arguments: {} }));
	assert.deepEqual(reply, { jsonrpc: '2.0', id: 2, error: { code: -32603, message: 'Internal error' } });
	assert.equal(logged.length, 1);
});

test('a cancelled call gets no reply, and other calls are unaffected', async () => {
	let release;
	const held = new Promise((resolve) => (release = resolve));
	const { protocol, send } = setup({ call: async (name, args) => (args.slow ? (await held, { content: [], isError: false }) : { content: [{ type: 'text', text: 'quick' }], isError: false }) });
	await send(initialize());
	const slow = protocol.handleLine(JSON.stringify(request(2, 'tools/call', { name: 'snippets_search', arguments: { slow: true } })));
	const quick = await send(request(3, 'tools/call', { name: 'snippets_search', arguments: {} }));
	assert.equal(quick.result.content[0].text, 'quick');
	assert.equal(await send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 2 } }), null);
	release();
	assert.equal(await slow, null);
});

test('served over streams: one JSON object per line, in whatever order the answers are ready, and it ends when the input ends', async () => {
	let release;
	const held = new Promise((resolve) => (release = resolve));
	const { protocol } = setup({ call: async (name, args) => (args.slow ? (await held, { content: [{ type: 'text', text: 'slow' }], isError: false }) : { content: [{ type: 'text', text: 'a\nb' }], isError: false }) });
	const input = new PassThrough();
	const output = new PassThrough();
	let written = '';
	output.on('data', (chunk) => (written += chunk));
	const done = protocol.serve({ input, output });

	input.write(JSON.stringify(initialize()) + '\n');
	input.write(JSON.stringify(request(2, 'tools/call', { name: 'snippets_search', arguments: { slow: true } })) + '\n');
	input.write('not json\n\n');
	input.write(JSON.stringify(request(3, 'tools/call', { name: 'snippets_search', arguments: {} })) + '\r\n');
	await new Promise((resolve) => setTimeout(resolve, 50));
	release();
	input.end();
	await done;

	const lines = written.split('\n');
	assert.equal(lines.pop(), '');
	const replies = lines.map((line) => JSON.parse(line));
	// Each answer is found by its id; only the held call is sure to be last.
	assert.deepEqual(replies.map((reply) => String(reply.id)).sort(), ['1', '2', '3', 'null']);
	const byId = Object.fromEntries(replies.map((reply) => [String(reply.id), reply]));
	assert.equal(byId['3'].result.content[0].text, 'a\nb');
	assert.equal(byId['null'].error.code, -32700);
	assert.equal(replies.at(-1).result.content[0].text, 'slow');
});

// --- added after review -----------------------------------------------------------

const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);

test('a request may hold the two Unicode line separators, and no reply ever does', async () => {
	// JSON allows both characters raw inside a string, and JavaScript's own
	// JSON writer leaves them raw. A line reader that treats them as line
	// ends would cut such a request in two.
	const seen = [];
	const { protocol } = setup({ call: async (name, args) => (seen.push(args.query), { content: [{ type: 'text', text: `found ${args.query}` }], isError: false }) });
	const input = new PassThrough();
	const output = new PassThrough();
	let written = '';
	output.on('data', (chunk) => (written += chunk));
	const done = protocol.serve({ input, output });
	input.write(JSON.stringify(initialize()) + '\n');
	const query = `good${LS}bye${PS}now`;
	const line = JSON.stringify(request(2, 'tools/call', { name: 'snippets_search', arguments: { query } }));
	assert.ok(line.includes(LS), 'the test needs the raw character on the line');
	input.write(line + '\n');
	input.end();
	await done;

	assert.deepEqual(seen, [query]);
	assert.ok(!written.includes(LS) && !written.includes(PS), 'a reply carried a raw line separator');
	const replies = written.trimEnd().split('\n').map((text) => JSON.parse(text));
	assert.deepEqual(replies.map((reply) => reply.id).sort(), [1, 2]);
	assert.equal(replies.find((reply) => reply.id === 2).result.content[0].text, `found ${query}`);
});

test('the 2025-03-26 version takes several requests in one message, and answers them in one', async () => {
	const { send } = setup();
	await send(initialize('2025-03-26'));
	const replies = await send([request(2, 'tools/list'), { jsonrpc: '2.0', method: 'notifications/initialized' }, request(3, 'ping'), request(4, 'no/such')]);
	assert.deepEqual(replies.map((reply) => [reply.id, Boolean(reply.result), reply.error?.code]), [[2, true, undefined], [3, true, undefined], [4, false, -32601]]);
	// Nothing but notifications: nothing to answer.
	assert.equal(await send([{ jsonrpc: '2.0', method: 'notifications/initialized' }]), null);
	assert.deepEqual(await send([]), { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
});

test('every other version refuses several requests in one message', async () => {
	for (const version of ['2025-11-25', '2025-06-18', '2024-11-05']) {
		const { send } = setup();
		await send(initialize(version));
		assert.deepEqual(await send([request(2, 'ping')]), { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } }, version);
	}
	assert.equal((await setup().send([request(1, 'ping')])).error.code, -32600);
});

test('a cancellation for a call that is not running is ignored, and a later call with that id is answered', async () => {
	const { send } = setup();
	await send(initialize());
	assert.equal(await send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 7 } }), null);
	assert.equal((await send(request(7, 'tools/call', { name: 'snippets_search', arguments: {} }))).result.isError, false);
	// And once a cancelled call has ended, its id is free again.
	let release;
	const held = new Promise((resolve) => (release = resolve));
	const slow = setup({ call: async (name, args) => (args.slow ? (await held, { content: [], isError: false }) : { content: [{ type: 'text', text: 'again' }], isError: false }) });
	await slow.send(initialize());
	const first = slow.protocol.handleLine(JSON.stringify(request(9, 'tools/call', { name: 'snippets_search', arguments: { slow: true } })));
	await slow.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 9 } });
	release();
	assert.equal(await first, null);
	assert.equal((await slow.send(request(9, 'tools/call', { name: 'snippets_search', arguments: {} }))).result.content[0].text, 'again');
});

test('when the input ends, the server does not wait long for a call that is stuck', async () => {
	const { protocol } = setup({ call: () => new Promise(() => {}) });
	const input = new PassThrough();
	const output = new PassThrough();
	output.resume();
	const done = protocol.serve({ input, output, grace: 200 });
	input.write(JSON.stringify(initialize()) + '\n');
	input.write(JSON.stringify(request(2, 'tools/call', { name: 'snippets_search', arguments: {} })) + '\n');
	const started = Date.now();
	input.end();
	await done;
	assert.ok(Date.now() - started >= 150 && Date.now() - started < 2000, `ended after ${Date.now() - started} ms`);
});
