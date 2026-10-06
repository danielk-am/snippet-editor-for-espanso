import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { setTimeout as wait } from 'node:timers/promises';
import { createRouter } from '../core/apiRouter.js';
import { createOllama, ollamaTurn } from '../core/chat/ollama.js';
import { createProposals } from '../core/chat/proposals.js';
import { sparePort, startApi } from './helpers/apiFixture.js';

// A stand-in for Ollama, answering in the shapes its API reference gives.
// Ollama is not installed on the computer this was built on.
async function standIn(t, { answers = [], version = '0.12.3', models = ['qwen3:8b', 'gpt-oss:120b-cloud', 'llama3.2:latest'], chunkDelay = 0 } = {}) {
	const requests = [];
	const closed = [];
	const server = http.createServer(async (request, response) => {
		let text = '';
		for await (const chunk of request) text += chunk;
		const body = text ? JSON.parse(text) : null;
		requests.push({ method: request.method, url: request.url, body, headers: request.headers });
		response.on('close', () => closed.push(request.url));
		if (request.url === '/api/version') return response.end(JSON.stringify({ version }));
		if (request.url === '/api/tags') return response.end(JSON.stringify({ models: models.map((name) => ({ name, model: name, size: 1 })) }));
		if (request.url === '/api/chat') {
			const answer = answers.length > 1 ? answers.shift() : answers[0];
			if (answer.status) return response.writeHead(answer.status, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: answer.error }));
			response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
			for (const chunk of answer.chunks) {
				if (chunk === 'HANG') return;
				response.write(`${JSON.stringify(chunk)}\n`);
				if (chunkDelay) await wait(chunkDelay);
			}
			return response.end();
		}
		response.writeHead(404).end('{}');
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	t.after(() => {
		server.closeAllConnections();
		server.close();
	});
	return { port: server.address().port, requests, closed, ollama: createOllama({ port: server.address().port }) };
}

const said = (content, extra = {}) => ({ model: 'm', created_at: 'now', message: { role: 'assistant', content, ...extra }, done: false });
const END = { model: 'm', created_at: 'now', message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop' };
const calls = (...list) => said('', { tool_calls: list.map(([name, args], index) => ({ type: 'function', function: { index, name, arguments: args } })) });

const TOOLS = [
	{ name: 'snippets_search', description: 'Find snippets.', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false } },
	{ name: 'snippets_add_snippet', description: 'Add a snippet.', inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false } },
];
function fakeTools() {
	const called = [];
	return {
		called,
		list: () => TOOLS,
		async call(name, args) {
			called.push([name, args]);
			if (name === 'snippets_search') return typeof args.query === 'string' ? { content: [{ type: 'text', text: `{"items":["${args.query}"]}` }], structuredContent: {}, isError: false } : { content: [{ type: 'text', text: 'Missing `query`.' }], isError: true };
			if (name === 'snippets_add_snippet') return { content: [{ type: 'text', text: '{"proposed":true}' }], structuredContent: { proposed: true }, isError: false };
			return null;
		},
	};
}

async function turn(context, { tools = fakeTools(), messages = [{ role: 'system', content: 'Help.' }, { role: 'user', content: 'Hi' }], ...rest } = {}) {
	const events = [];
	await ollamaTurn({ ollama: context.ollama, model: 'qwen3:8b', messages, tools, onEvent: (event) => events.push(event), ...rest });
	return { events, tools };
}

// --- is it there ---------------------------------------------------------------------------

test('whether Ollama is running, and which models it has', async (t) => {
	const { ollama, requests } = await standIn(t);
	assert.equal(await ollama.version(), '0.12.3');
	assert.deepEqual(await ollama.models(), ['gpt-oss:120b-cloud', 'llama3.2:latest', 'qwen3:8b']);
	assert.deepEqual(requests.map((request) => [request.method, request.url]), [['GET', '/api/version'], ['GET', '/api/tags']]);
	assert.deepEqual((await standIn(t, { models: [] })).ollama && (await (await standIn(t, { models: [] })).ollama.models()), []);
});

test('nothing listening, or something that is not Ollama, is "not answering"', async (t) => {
	const closed = createOllama({ port: await sparePort() });
	const notRunning = (promise) => assert.rejects(promise, (error) => error.code === 'NOT_RUNNING' && error.message === 'Ollama is not answering on this computer.');
	await notRunning(closed.version());
	await notRunning(closed.models());

	const other = http.createServer((request, response) => response.end('<html>hello</html>'));
	await new Promise((resolve) => other.listen(0, '127.0.0.1', resolve));
	t.after(() => other.close());
	await notRunning(createOllama({ port: other.address().port }).version());
	await notRunning(createOllama({ port: other.address().port }).models());

	// JSON, but not what Ollama sends.
	for (const body of ['null', '[]', '"ollama"', '{"version":7}', '{"models":{}}']) {
		const odd = http.createServer((request, response) => response.end(body));
		await new Promise((resolve) => odd.listen(0, '127.0.0.1', resolve));
		t.after(() => odd.close());
		await notRunning(createOllama({ port: odd.address().port }).version());
		await notRunning(createOllama({ port: odd.address().port }).models());
	}

	const silent = http.createServer(() => {});
	await new Promise((resolve) => silent.listen(0, '127.0.0.1', resolve));
	t.after(() => {
		silent.closeAllConnections();
		silent.close();
	});
	const began = Date.now();
	await notRunning(createOllama({ port: silent.address().port, quickMs: 200 }).version());
	assert.ok(Date.now() - began < 2000);
});

// --- an answer -----------------------------------------------------------------------------

test('an answer is passed on as it arrives, and the request is what Ollama\'s API asks for', async (t) => {
	const context = await standIn(t, { answers: [{ chunks: [said('Hel'), said('lo', { thinking: 'hm' }), said(''), END] }] });
	const { events } = await turn(context);
	assert.deepEqual(events, [{ type: 'text', text: 'Hel' }, { type: 'text', text: 'lo' }, { type: 'done' }]);
	const sent = context.requests[0];
	assert.deepEqual([sent.method, sent.url, sent.headers['content-type']], ['POST', '/api/chat', 'application/json']);
	assert.deepEqual(Object.keys(sent.body).sort(), ['messages', 'model', 'options', 'stream', 'tools']);
	assert.deepEqual([sent.body.model, sent.body.stream, sent.body.options], ['qwen3:8b', true, { num_ctx: 16384 }]);
	assert.deepEqual(sent.body.messages, [{ role: 'system', content: 'Help.' }, { role: 'user', content: 'Hi' }]);
	assert.deepEqual(sent.body.tools[0], { type: 'function', function: { name: 'snippets_search', description: 'Find snippets.', parameters: TOOLS[0].inputSchema } });
	assert.equal(sent.body.tools.length, 2);
});

test('a tool the model asks for is run inside the app, and its result goes back as a tool message', async (t) => {
	const context = await standIn(t, { answers: [{ chunks: [said('Let me look.'), calls(['snippets_search', { query: 'refund' }]), END] }, { chunks: [said('Found it.'), END] }] });
	const { events, tools } = await turn(context);
	assert.deepEqual(events, [
		{ type: 'text', text: 'Let me look.' },
		{ type: 'tool', id: 'call-1-1', name: 'snippets_search', status: 'started' },
		{ type: 'tool', id: 'call-1-1', name: 'snippets_search', status: 'done' },
		{ type: 'text', text: '\n\nFound it.' },
		{ type: 'done' },
	]);
	assert.deepEqual(tools.called, [['snippets_search', { query: 'refund' }]]);
	assert.equal(context.requests.length, 2);
	assert.deepEqual(context.requests[1].body.messages.slice(2), [
		{ role: 'assistant', content: 'Let me look.', tool_calls: [{ type: 'function', function: { index: 0, name: 'snippets_search', arguments: { query: 'refund' } } }] },
		{ role: 'tool', tool_name: 'snippets_search', content: '{"items":["refund"]}' },
	]);
});

test('two tools asked for at once are both run, in order, and thinking is sent back with them', async (t) => {
	const context = await standIn(t, { answers: [{ chunks: [said('', { thinking: 'two things' }), calls(['snippets_search', { query: 'a' }], ['snippets_add_snippet', {}]), END] }, { chunks: [said('Both done.'), END] }] });
	const { events, tools } = await turn(context);
	assert.deepEqual(events.filter((event) => event.type === 'tool').map((event) => [event.id, event.name, event.status]), [
		['call-1-1', 'snippets_search', 'started'],
		['call-1-1', 'snippets_search', 'done'],
		['call-1-2', 'snippets_add_snippet', 'started'],
		['call-1-2', 'snippets_add_snippet', 'done'],
	]);
	assert.deepEqual(tools.called.map(([name]) => name), ['snippets_search', 'snippets_add_snippet']);
	const [assistant, first, second] = context.requests[1].body.messages.slice(2);
	assert.deepEqual([assistant.thinking, assistant.tool_calls.length], ['two things', 2]);
	assert.deepEqual([first, second].map((message) => [message.role, message.tool_name]), [['tool', 'snippets_search'], ['tool', 'snippets_add_snippet']]);
	// With no text before the tools, the answer does not start with a gap.
	assert.deepEqual(events.at(-2), { type: 'text', text: 'Both done.' });
});

test('a tool that does not exist, and inputs in an odd shape, are answered so the model can put it right', async (t) => {
	const context = await standIn(t, {
		answers: [{ chunks: [calls(['made_up_tool', {}], ['snippets_search', '{"query":"as text"}'], ['snippets_search', 'not json'], ['snippets_search', null]), END] }, { chunks: [said('OK.'), END] }],
	});
	const { events, tools } = await turn(context);
	assert.deepEqual(events.filter((event) => event.type === 'tool' && event.status !== 'started').map((event) => event.status), ['failed', 'done', 'failed', 'failed']);
	assert.deepEqual(tools.called, [['made_up_tool', {}], ['snippets_search', { query: 'as text' }], ['snippets_search', {}], ['snippets_search', {}]]);
	assert.deepEqual(context.requests[1].body.messages.slice(3).map((message) => message.content), ['There is no tool named made_up_tool.', '{"items":["as text"]}', 'Missing `query`.', 'Missing `query`.']);
});

test('a change the model asks for becomes a card, with the real tools, and the model is told nothing has changed', async (t) => {
	const api = await startApi(t, { enabled: false });
	const cards = [];
	const proposals = createProposals({ router: createRouter({ service: api.service, log: () => {} }), aiWrite: () => false, onCard: (card) => cards.push(card) });
	const version = (await proposals.tools.call('snippets_get_file', { file_id: 'local:base.yml' })).structuredContent.version;
	const context = await standIn(t, { answers: [{ chunks: [calls(['snippets_add_snippet', { file_id: 'local:base.yml', snippet: { trigger: ';o', replace: 'From Ollama' }, version }]), END] }, { chunks: [said('Proposed.'), END] }] });
	const { events } = await turn(context, { tools: proposals.tools });
	assert.deepEqual(events.map((event) => event.status ?? event.type), ['started', 'done', 'text', 'done']);
	assert.deepEqual(cards.map((card) => [card.kind, card.subject, card.status]), [['add', ';o', 'pending']]);
	const told = JSON.parse(context.requests[1].body.messages.at(-1).content);
	assert.deepEqual([told.proposed, told.proposal_id], [true, cards[0].id]);
	assert.match(told.note, /Nothing has changed yet/);
	// The real tool list goes out whole, in the shape Ollama takes.
	assert.equal(context.requests[0].body.tools.length, 12);
	assert.ok(context.requests[0].body.tools.every((tool) => tool.type === 'function' && tool.function.parameters.type === 'object'));
});

// --- when it does not end well -------------------------------------------------------------

test('a model that keeps asking for tools is stopped after 8 rounds', async (t) => {
	const context = await standIn(t, { answers: [{ chunks: [said('Again. '), calls(['snippets_search', { query: 'x' }]), END] }] });
	const { events } = await turn(context);
	assert.equal(context.requests.length, 8);
	assert.deepEqual(events.at(-1), { type: 'error', code: 'STEPS', message: 'The assistant used tools 8 times without finishing, so it was stopped.' });
	assert.equal(events.filter((event) => event.type === 'done').length, 0);
});

test('what Ollama refuses is said in words the person can act on', async (t) => {
	const failure = async (answer) => (await turn(await standIn(t, { answers: [answer] }))).events;
	assert.deepEqual(await failure({ status: 400, error: 'registry.ollama.ai/library/gemma3:4b does not support tools' }), [{ type: 'error', code: 'NO_TOOLS', message: 'This model cannot use tools, so it cannot read your snippets. Pick another model.' }]);
	assert.deepEqual(await failure({ status: 404, error: 'model "nope" not found, try pulling it first' }), [{ type: 'error', code: 'FAILED', message: 'Ollama said: model "nope" not found, try pulling it first' }]);
	assert.deepEqual(await failure({ status: 401, error: 'unauthorized' }), [{ type: 'error', code: 'SIGNED_OUT', message: 'Ollama says you are not signed in. Sign in to Ollama, then try again.' }]);
	assert.deepEqual(await failure({ status: 500, error: 'x'.repeat(2000) }).then((events) => [events[0].code, events[0].message.length]), ['FAILED', 500]);
	assert.deepEqual(await failure({ chunks: [said('Half an '), { error: 'the model ran out of memory' }] }), [{ type: 'text', text: 'Half an ' }, { type: 'error', code: 'FAILED', message: 'Ollama said: the model ran out of memory' }]);
	// It closes the connection without saying it is done.
	assert.deepEqual(await failure({ chunks: [said('Cut off')] }), [{ type: 'text', text: 'Cut off' }, { type: 'error', code: 'FAILED', message: 'Ollama stopped before the answer was complete.' }]);
	// Not running at all.
	const events = [];
	await ollamaTurn({ ollama: createOllama({ port: await sparePort() }), model: 'm', messages: [], tools: fakeTools(), onEvent: (event) => events.push(event) });
	assert.deepEqual(events, [{ type: 'error', code: 'NOT_RUNNING', message: 'Ollama is not answering on this computer.' }]);
});

test('an Ollama that goes silent is not waited for, and an answer with no end is cut off', async (t) => {
	const silent = await standIn(t, { answers: [{ chunks: [said('Started'), 'HANG'] }] });
	const { events } = await turn(silent, { idleMs: 200 });
	assert.deepEqual(events, [{ type: 'text', text: 'Started' }, { type: 'error', code: 'IDLE', message: 'Ollama stopped answering, so it was stopped.' }]);

	const endless = await standIn(t, { answers: [{ chunks: Array.from({ length: 50 }, () => said('y'.repeat(1000))) }] });
	const cut = (await turn(endless, { maxText: 10_000 })).events;
	assert.deepEqual(cut.at(-1), { type: 'error', code: 'TOO_LONG', message: 'The answer was too long, so it was stopped.' });
	assert.ok(cut.length <= 12);
});

test('stopped by the person: the request is dropped, and nothing more is passed on', async (t) => {
	const context = await standIn(t, { answers: [{ chunks: [said('One. '), said('Two. '), said('Three. '), said('Four. '), END] }], chunkDelay: 80 });
	const stopper = new AbortController();
	const events = [];
	const running = ollamaTurn({
		ollama: context.ollama,
		model: 'm',
		messages: [],
		tools: fakeTools(),
		signal: stopper.signal,
		onEvent: (event) => {
			events.push(event);
			if (events.length === 2) stopper.abort();
		},
	});
	await running;
	await wait(200);
	assert.deepEqual(events, [{ type: 'text', text: 'One. ' }, { type: 'text', text: 'Two. ' }]);
	assert.deepEqual(context.closed, ['/api/chat']);
});

test('stopped while a tool is running: no further request is made', async (t) => {
	const context = await standIn(t, { answers: [{ chunks: [calls(['snippets_search', { query: 'x' }]), END] }, { chunks: [said('never'), END] }] });
	const stopper = new AbortController();
	const tools = fakeTools();
	const call = tools.call;
	tools.call = async (...args) => {
		stopper.abort();
		return call(...args);
	};
	const events = [];
	await ollamaTurn({ ollama: context.ollama, model: 'm', messages: [], tools, signal: stopper.signal, onEvent: (event) => events.push(event) });
	assert.equal(context.requests.length, 1);
	assert.deepEqual(events, [{ type: 'tool', id: 'call-1-1', name: 'snippets_search', status: 'started' }]);
});
