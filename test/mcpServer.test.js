import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRouter } from '../core/apiRouter.js';
import { openChannel } from '../core/chat/channel.js';
import { startApi } from './helpers/apiFixture.js';

const SERVER = fileURLToPath(new URL('../mcp/server.mjs', import.meta.url));
const META = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {}, 'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1' } };

// The real program, as an AI tool would start it.
function start(t, dataDir, { command = process.execPath, args = [SERVER], env = {} } = {}) {
	const child = spawn(command, args, { env: { PATH: process.env.PATH, SNIPPET_EDITOR_DATA_DIR: dataDir, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
	t.after(() => child.kill());
	let out = '';
	let err = '';
	const waiting = new Map();
	child.stdout.setEncoding('utf8');
	child.stdout.on('data', (chunk) => {
		out += chunk;
		for (const line of out.split('\n').slice(0, -1)) {
			let message;
			try {
				message = JSON.parse(line);
			} catch {
				continue;
			}
			waiting.get(String(message.id))?.(message);
		}
	});
	child.stderr.on('data', (chunk) => (err += chunk));
	const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
	return {
		child,
		exited,
		output: () => out,
		errors: () => err,
		send(message) {
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error(`no answer to ${JSON.stringify(message)}; stderr: ${err}`)), 10_000);
				waiting.set(String(message.id), (reply) => {
					clearTimeout(timer);
					resolve(reply);
				});
				child.stdin.write(`${JSON.stringify(message)}\n`);
			});
		},
		notify: (message) => child.stdin.write(`${JSON.stringify(message)}\n`),
	};
}

test('an older client: handshake, list the tools, search', async (t) => {
	const { dataDir } = await startApi(t);
	const server = start(t, dataDir);
	const hello = await server.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
	assert.deepEqual([hello.result.protocolVersion, hello.result.capabilities, hello.result.serverInfo.name], ['2025-06-18', { tools: {} }, 'snippet-editor']);
	assert.match(hello.result.instructions, /Let AI tools change snippets/);
	server.notify({ jsonrpc: '2.0', method: 'notifications/initialized' });

	const listed = await server.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
	assert.equal(listed.result.tools.length, 12);
	assert.equal(listed.result.tools[0].name, 'snippets_search');

	const found = await server.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'snippets_search', arguments: { query: 'goodbye' } } });
	assert.equal(found.result.isError, false);
	assert.deepEqual(found.result.structuredContent.items.map((item) => item.file_id), ['package:goodbyes:package.yml']);
});

test('a newer client: no handshake, the version on every request', async (t) => {
	const { dataDir } = await startApi(t);
	const server = start(t, dataDir);
	const discovered = await server.send({ jsonrpc: '2.0', id: 'd', method: 'server/discover', params: { _meta: META } });
	assert.deepEqual([discovered.result.resultType, discovered.result.supportedVersions, discovered.result.capabilities], ['complete', ['2026-07-28'], { tools: {} }]);
	const files = await server.send({ jsonrpc: '2.0', id: 'f', method: 'tools/call', params: { name: 'snippets_list_files', arguments: { source: 'local' }, _meta: META } });
	assert.deepEqual([files.result.resultType, files.result.structuredContent.total_count], ['complete', 4]);
	const refused = await server.send({ jsonrpc: '2.0', id: 'x', method: 'tools/list', params: { _meta: { ...META, 'io.modelcontextprotocol/protocolVersion': '2030-01-01' } } });
	assert.equal(refused.error.code, -32022);
});

test('a change is refused while the switch is off, and made once it is on', async (t) => {
	const { dataDir, matchDir, service } = await startApi(t, { aiWrite: false });
	const server = start(t, dataDir);
	await server.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
	const call = async (id, name, args) => (await server.send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })).result;

	const file = (await call(2, 'snippets_get_file', { file_id: 'local:base.yml' })).structuredContent;
	const add = { file_id: 'local:base.yml', snippet: { trigger: ';mcp', replace: 'Added over MCP' }, version: file.version };
	const before = readFileSync(join(matchDir, 'base.yml'), 'utf8');
	const refused = await call(3, 'snippets_add_snippet', add);
	assert.equal(refused.isError, true);
	assert.match(refused.content[0].text, /switched off/);
	assert.equal(readFileSync(join(matchDir, 'base.yml'), 'utf8'), before);

	await service.saveSettings({ aiWrite: true });
	const added = await call(4, 'snippets_add_snippet', add);
	assert.deepEqual([added.isError, added.structuredContent.snippet_count], [false, 4]);
	assert.equal(readFileSync(join(matchDir, 'base.yml'), 'utf8'), `${before}\n  - trigger: ";mcp"\n    replace: "Added over MCP"\n`);
});

test('with the app closed it still starts, lists its tools, and says what is wrong when one is called', async (t) => {
	const { dataDir, listener } = await startApi(t);
	await listener.stop();
	const server = start(t, dataDir);
	await server.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
	assert.equal((await server.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).result.tools.length, 12);
	const result = (await server.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'snippets_search', arguments: { query: 'bye' } } })).result;
	assert.deepEqual([result.isError, result.content[0].text], [true, 'Snippet Editor is not reachable. Open the app and switch on "API for other tools" in its Settings.']);
});

test('only protocol messages reach standard output, the token never does, and it exits when its input closes', async (t) => {
	const { dataDir } = await startApi(t);
	const token = readFileSync(join(dataDir, 'api-token'), 'utf8').trim();
	const server = start(t, dataDir);
	await server.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
	server.child.stdin.write('this is not json\n');
	await server.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'snippets_get_file', arguments: { file_id: 'local:base.yml', detail: 'raw' } } });
	await server.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'snippets_get_file', arguments: { file_id: 'local:missing.yml' } } });
	server.child.stdin.end();
	assert.deepEqual(await server.exited, { code: 0, signal: null });

	const lines = server.output().split('\n');
	assert.equal(lines.pop(), '');
	assert.equal(lines.length, 4);
	for (const line of lines) assert.equal(JSON.parse(line).jsonrpc, '2.0');
	assert.ok(!server.output().includes(token) && !server.errors().includes(token));
});

// --- started for the app's own chat ------------------------------------------------------

test('started for a chat, it reads through that message\'s listener and hands every change over as a proposal', async (t) => {
	// The app's own API is off and the switch for changes is off: chat needs neither.
	const api = await startApi(t, { enabled: false, aiWrite: false });
	const proposals = [];
	const channel = await openChannel({
		dir: join(api.root, 'chat'),
		router: createRouter({ service: api.service, log: () => {} }),
		onProposal: async (proposal) => {
			proposals.push(proposal);
			return { id: 'p1' };
		},
		log: () => {},
	});
	t.after(() => channel.close());
	// The data folder it would otherwise use is empty, so nothing can come from there.
	const server = start(t, mkdtempSync(join(tmpdir(), 'snippet-editor-nodata-')), { env: { SNIPPET_EDITOR_CHAT: channel.file } });

	const hello = await server.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
	assert.match(hello.result.instructions, /card/);
	assert.doesNotMatch(hello.result.instructions, /API for other tools|Let AI tools change snippets/);
	const call = async (id, name, args) => (await server.send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })).result;

	const listed = await server.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
	assert.equal(listed.result.tools.length, 12);
	const add = listed.result.tools.find((tool) => tool.name === 'snippets_add_snippet');
	assert.match(add.description, /In this chat the change is not made at once/);
	assert.equal(Object.hasOwn(add.inputSchema.properties, 'accept_commands'), false);

	const found = await call(3, 'snippets_search', { query: 'hello' });
	assert.equal(found.structuredContent.items[0].file_id, 'local:base.yml');

	const before = readFileSync(join(api.matchDir, 'base.yml'), 'utf8');
	const file = (await call(4, 'snippets_get_file', { file_id: 'local:base.yml' })).structuredContent;
	const args = { file_id: 'local:base.yml', snippet: { trigger: ';chat', replace: 'From chat' }, version: file.version };
	const proposed = await call(5, 'snippets_add_snippet', args);
	assert.deepEqual([proposed.isError, proposed.structuredContent.proposed, proposed.structuredContent.proposal_id], [false, true, 'p1']);
	assert.deepEqual(proposals, [{ tool: 'snippets_add_snippet', args }]);
	assert.equal(readFileSync(join(api.matchDir, 'base.yml'), 'utf8'), before);

	await call(6, 'snippets_create_file', { name: 'chat.yml' });
	assert.equal(existsSync(join(api.matchDir, 'chat.yml')), false);

	// Once the answer is over the listener is gone, and a late call says so.
	await channel.close();
	const late = await call(7, 'snippets_search', { query: 'hello' });
	assert.deepEqual([late.isError, late.content[0].text], [true, 'This chat has ended. The person can send their message again.']);
});
