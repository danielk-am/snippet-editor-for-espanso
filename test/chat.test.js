import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createRouter } from '../core/apiRouter.js';
import { createChat } from '../core/chat/chat.js';
import { startApi } from './helpers/apiFixture.js';
import { END, calls, said, standIn } from './helpers/fakeOllama.js';

// The stand-in is a script started by its first line, which Windows cannot do.
const options = { skip: process.platform === 'win32' };

const SERVER = fileURLToPath(new URL('../mcp/server.mjs', import.meta.url));
const FAKE = fileURLToPath(new URL('./helpers/fakeAgent.mjs', import.meta.url));
const ENDINGS = ['done', 'error', 'stopped'];

const ready = (id, label, extra = {}) => ({ id, label, ready: true, state: 'ready', message: '', command: null, sendsTo: null, models: [], ...extra });

async function setup(t, { status = {}, answers = [{ chunks: [said('From Ollama.'), END] }], limits, aiWrite = true, program = FAKE, tap = () => {}, statusDelay = 0, locateDelay = 0, chunkDelay = 0, lookUp, log = () => {}, statusFault = null } = {}) {
	const api = await startApi(t, { enabled: false, aiWrite });
	const ollama = await standIn(t, { answers, chunkDelay });
	const events = [];
	const backends = {
		claude: ready('claude', 'Claude Code', { sendsTo: 'Anthropic' }),
		codex: ready('codex', 'Codex', { sendsTo: 'OpenAI' }),
		ollama: ready('ollama', 'Ollama', { models: [{ name: 'qwen3:8b', cloud: false }] }),
		...status,
	};
	const checks = { count: 0, located: 0 };
	const chat = createChat({
		service: api.service,
		router: createRouter({ service: api.service, log: () => {} }),
		dataDir: api.dataDir,
		mcp: { command: process.execPath, args: [SERVER], env: {} },
		emit: (event) => {
			events.push(event);
			tap(event);
		},
		backends: {
			// Not an async function: a fault here is thrown at once, as a careless one would.
			status: () => {
				checks.count += 1;
				if (statusFault?.(checks.count)) throw new Error('the look fell over');
				// The backends as they are now, told when the look is over.
				const seen = Object.values(backends);
				return wait(statusDelay).then(() => seen);
			},
			locate: async () => {
				checks.located += 1;
				await wait(locateDelay);
				return program;
			},
		},
		ollama: ollama.ollama,
		log,
		...(limits ? { limits } : {}),
		...(lookUp ? { lookUp } : {}),
	});
	t.after(() => chat.dispose());

	// Every event of one answer, once it has ended.
	async function answer(input) {
		const { turnId } = await chat.send(input);
		const until = Date.now() + 20_000;
		while (!events.some((event) => event.turnId === turnId && ENDINGS.includes(event.type))) {
			if (Date.now() > until) throw new Error(`no ending: ${JSON.stringify(events)}`);
			await wait(20);
		}
		return events.filter((event) => event.turnId === turnId).map(({ turnId: dropped, ...rest }) => rest);
	}
	const ask = (backend, text, extra = {}) => answer({ backend, messages: [{ role: 'user', text }], ...extra });
	const chatDir = join(api.dataDir, 'chat');
	const left = () => (existsSync(chatDir) ? readdirSync(chatDir).filter((name) => name !== 'empty') : []);
	return { ...api, chat, events, answer, ask, ollama, left, chatDir, checks, backends, read: (name) => readFileSync(join(api.matchDir, name), 'utf8') };
}

const textOf = (events) => events.filter((event) => event.type === 'text').map((event) => event.text).join('');
const kinds = (events) => events.map((event) => (event.type === 'tool' ? `${event.name}:${event.status}` : event.type === 'text' ? 'text' : event.type));
const squash = (list) => list.filter((kind, index) => kind !== 'text' || list[index - 1] !== 'text');

// --- an answer, end to end -----------------------------------------------------------------

for (const backend of ['claude', 'codex']) {
	test(`${backend}: a message becomes text, tool lines and a card, and the snippet is written only when the card is applied`, options, async (t) => {
		const { ask, chat, read, left } = await setup(t);
		const before = read('base.yml');
		const events = await ask(backend, 'SAY Let me look.\nSEARCH hello\nADD ;fake=From the stand-in\nSAY I have proposed it.');
		assert.deepEqual(squash(kinds(events)), [
			'text',
			'snippets_search:started',
			'snippets_search:done',
			'snippets_get_file:started',
			'snippets_get_file:done',
			'snippets_add_snippet:started',
			'proposal',
			'snippets_add_snippet:done',
			'text',
			'done',
		]);
		assert.equal(textOf(events), 'Let me look.\n\nI have proposed it.');
		const { card } = events.find((event) => event.type === 'proposal');
		assert.deepEqual([card.kind, card.title, card.subject, card.after, card.status], ['add', 'Add a snippet to base.yml', ';fake', '- trigger: ";fake"\n  replace: "From the stand-in"\n', 'pending']);
		assert.equal(read('base.yml'), before);

		// The listener of that answer is gone, and its files with it.
		assert.deepEqual(left(), []);

		assert.equal((await chat.apply(card.id)).status, 'applied');
		assert.equal(read('base.yml'), `${before}\n  - trigger: ";fake"\n    replace: "From the stand-in"\n`);
	});
}

test('the program is started in an empty folder of the app\'s, with the instructions and without the message among its arguments', options, async (t) => {
	const { ask, chatDir } = await setup(t);
	for (const backend of ['claude', 'codex']) {
		const events = await ask(backend, 'ARGS\nthis is the private message', { context: { fileId: 'local:base.yml', fileName: 'base.yml', index: 1, trigger: ';sig' } });
		const seen = JSON.parse(textOf(events));
		assert.ok(seen.cwd.endsWith(join('chat', 'empty')), seen.cwd);
		assert.deepEqual(readdirSync(join(chatDir, 'empty')), []);
		assert.ok(!seen.args.join('\n').includes('private message'));
		assert.ok(seen.args.join('\n').includes('You are the assistant inside Snippet Editor for Espanso'));
		assert.match(seen.input, /<open_in_the_app>\nThe person has the file base\.yml open \(file id local:base\.yml\), at the snippet in position 1 \(;sig\)\.\n<\/open_in_the_app>/);
		assert.ok(seen.input.endsWith('<new_message>\nARGS\nthis is the private message\n</new_message>\n'));
	}
});

test('ollama: the same message, with the tools run inside the app', async (t) => {
	const api = await setup(t, {
		answers: [{ chunks: [said('Looking.'), calls(['snippets_search', { query: 'hello' }]), END] }, { chunks: [said('Found `;hello`.'), END] }],
	});
	const events = await api.answer({ backend: 'ollama', model: 'qwen3:8b', messages: [{ role: 'user', text: 'Find hello' }], context: { fileId: 'local:base.yml', fileName: 'base.yml' } });
	assert.deepEqual(events, [
		{ type: 'found', hits: [{ fileId: 'local:base.yml', fileName: 'base.yml', source: 'local', index: 0, triggers: [';hello'], label: '', preview: 'Hello there' }] },
		{ type: 'text', text: 'Looking.' },
		{ type: 'tool', id: 'call-1-1', name: 'snippets_search', status: 'started' },
		{ type: 'tool', id: 'call-1-1', name: 'snippets_search', status: 'done' },
		{ type: 'text', text: '\n\nFound `;hello`.' },
		{ type: 'done' },
	]);
	const sent = api.ollama.requests[0].body;
	assert.equal(sent.model, 'qwen3:8b');
	assert.match(sent.messages[0].content, /^You are the assistant inside Snippet Editor/);
	const asked = sent.messages.at(-1).content;
	assert.ok(asked.startsWith('[Open in the app: The person has the file base.yml open (file id local:base.yml).]\n\n<looked_up_by_the_app>\n'), asked);
	assert.ok(asked.endsWith('\n</looked_up_by_the_app>\n\nFind hello'), asked);
	assert.equal(sent.tools.length, 12);
	// The model was given what the search found.
	assert.match(api.ollama.requests[1].body.messages.at(-1).content, /"file_id":"local:base\.yml"/);
	assert.deepEqual(api.left(), []);
});

test('ollama: a change is a card too, and Apply writes it', async (t) => {
	const api = await setup(t, { answers: [{ chunks: [calls(['snippets_create_file', { name: 'from-ollama.yml' }]), END] }, { chunks: [said('Proposed.'), END] }] });
	const events = await api.answer({ backend: 'ollama', model: 'qwen3:8b', messages: [{ role: 'user', text: 'Make a file' }] });
	assert.deepEqual(kinds(events), ['snippets_create_file:started', 'proposal', 'snippets_create_file:done', 'text', 'done']);
	const { card } = events.find((event) => event.type === 'proposal');
	assert.equal(existsSync(join(api.matchDir, 'from-ollama.yml')), false);
	assert.equal((await api.chat.apply(card.id)).status, 'applied');
	assert.equal(existsSync(join(api.matchDir, 'from-ollama.yml')), true);
	assert.equal(api.chat.dismiss(card.id).status, 'applied');
});

test('what a run that crashed left behind is cleared before the first answer, and other files there are let be', options, async (t) => {
	const { ask, chatDir, left } = await setup(t);
	mkdirSync(chatDir, { recursive: true });
	writeFileSync(join(chatDir, 'chat-0123456789abcdef.json'), '{"port":1,"token":"old"}');
	writeFileSync(join(chatDir, 'mcp-0123456789abcdef.json'), '{}');
	writeFileSync(join(chatDir, 'notes.txt'), 'not ours to remove');
	await ask('codex', 'SAY hi');
	assert.deepEqual(left(), ['notes.txt']);
});

// --- what is refused before anything starts ------------------------------------------------

test('a message that cannot be sent is refused with the reason, and nothing is started', options, async (t) => {
	const { chat, events } = await setup(t, {
		status: { claude: { id: 'claude', label: 'Claude Code', ready: false, state: 'signed-out', message: 'Claude Code is not signed in. Run this in a terminal, then press Check again.', command: '/opt/claude auth login', sendsTo: 'Anthropic', models: [] } },
	});
	const refused = (input, code, pattern) => assert.rejects(chat.send(input), (error) => error.code === code && pattern.test(error.message), JSON.stringify(input).slice(0, 80));
	const one = [{ role: 'user', text: 'Hi' }];
	await refused({ backend: 'claude', messages: one }, 'NOT_READY', /^Claude Code is not signed in\./);
	await refused({ backend: 'gpt', messages: one }, 'INVALID', /^Choose Claude Code, Codex or Ollama\.$/);
	await refused({ backend: 'codex', messages: [] }, 'INVALID', /^Write a message first\.$/);
	await refused({ backend: 'codex', messages: [{ role: 'user', text: '   ' }] }, 'INVALID', /^Write a message first\.$/);
	await refused({ backend: 'codex', messages: [{ role: 'user', text: 'Hi' }, { role: 'assistant', text: 'Hello' }] }, 'INVALID', /^Write a message first\.$/);
	await refused({ backend: 'codex', messages: 'Hi' }, 'INVALID', /^Write a message first\.$/);
	await refused({ backend: 'codex', messages: [{ role: 'user', text: 'x'.repeat(20_001) }] }, 'INVALID', /^That message is too long: 20,001 characters, and the most is 20,000\.$/);
	await refused({ backend: 'ollama', messages: one }, 'INVALID', /^Choose one of Ollama's models first\.$/);
	await refused({ backend: 'ollama', model: 'not-installed', messages: one }, 'INVALID', /^Choose one of Ollama's models first\.$/);
	await refused(null, 'INVALID', /^Choose Claude Code/);
	assert.deepEqual(events, []);
});

test('one answer at a time: a second message waits until the first has ended or been stopped', options, async (t) => {
	const { chat, events, ask } = await setup(t);
	const first = await chat.send({ backend: 'codex', messages: [{ role: 'user', text: 'SAY one\nHANG' }] });
	await assert.rejects(chat.send({ backend: 'claude', messages: [{ role: 'user', text: 'SAY two' }] }), (error) => error.code === 'BUSY' && error.message === 'An answer is under way. Wait for it, or stop it first.');
	chat.stop(first.turnId);
	while (!events.some((event) => event.type === 'stopped')) await wait(20);
	assert.equal(textOf(await ask('claude', 'SAY two')), 'two');
});

test('the moment an answer is reported as ended, the next message can be sent', async (t) => {
	const followUps = [];
	const context = await setup(t, {
		tap(event) {
			if (event.type === 'done' && !followUps.length) followUps.push(context.chat.send({ backend: 'ollama', model: 'qwen3:8b', messages: [{ role: 'user', text: 'And again' }] }));
		},
	});
	await context.answer({ backend: 'ollama', model: 'qwen3:8b', messages: [{ role: 'user', text: 'Hi' }] });
	const second = await followUps[0];
	assert.match(second.turnId, /^[a-f0-9]{16}$/);
	while (context.events.filter((event) => event.type === 'done').length < 2) await wait(20);
});

test('the backends are not all checked again for every message: a check from the last minute is used', async (t) => {
	const context = await setup(t);
	const hello = { backend: 'ollama', model: 'qwen3:8b', messages: [{ role: 'user', text: 'Hi' }] };
	await context.answer(hello);
	await context.answer(hello);
	assert.equal(context.checks.count, 1);
	// "Check again" in the panel always looks.
	await context.chat.status();
	assert.equal(context.checks.count, 2);
	await context.answer(hello);
	assert.equal(context.checks.count, 2);
});

test('a message does not wait for the backends to be looked at again: the last look is used, and a new one runs behind the answer', async (t) => {
	const context = await setup(t, { statusDelay: 300, limits: { statusMs: 1 } });
	const hello = { backend: 'ollama', model: 'qwen3:8b', messages: [{ role: 'user', text: 'Hi' }] };
	await context.chat.status();
	assert.equal(context.checks.count, 1);
	await wait(20);

	// The look is stale by now, and sending does not wait 300 ms for a new one.
	const began = Date.now();
	const { turnId } = await context.chat.send(hello);
	assert.ok(Date.now() - began < 250, `sending took ${Date.now() - began} ms`);
	while (!context.events.some((event) => event.turnId === turnId && event.type === 'done')) await wait(10);
	// One new look was started behind it, and only one however many messages follow meanwhile.
	assert.equal(context.checks.count, 2);
	await context.answer(hello);
	assert.equal(context.checks.count, 2);
	await wait(350);
	// That look is now the last one, and it is fresh for a millisecond.
	await wait(20);
	await context.answer(hello);
	assert.equal(context.checks.count, 3);
	// Closing with a look still under way leaves nothing to go wrong.
	await context.chat.dispose();
	await wait(350);
});

test('the first message, with no look yet made, waits for one', async (t) => {
	const context = await setup(t, { statusDelay: 200 });
	const began = Date.now();
	await context.chat.send({ backend: 'ollama', model: 'qwen3:8b', messages: [{ role: 'user', text: 'Hi' }] });
	assert.ok(Date.now() - began >= 190, `sending took ${Date.now() - began} ms`);
	assert.equal(context.checks.count, 1);
});

test('a look made behind an answer that finds the backend gone is what the next message is told', async (t) => {
	const context = await setup(t, { limits: { statusMs: 1 } });
	const hello = { backend: 'ollama', model: 'qwen3:8b', messages: [{ role: 'user', text: 'Hi' }] };
	await context.answer(hello);
	await wait(20);
	context.backends.ollama = { ...context.backends.ollama, ready: false, state: 'not-running', message: 'Ollama is not answering on this computer.' };
	// This one still goes, on the strength of the last look, while a new look is made.
	await context.answer(hello);
	await wait(20);
	await assert.rejects(context.chat.send(hello), (error) => error.code === 'NOT_READY' && error.message === 'Ollama is not answering on this computer.');
});

test('after an answer fails because of the backend itself, the next message looks again', options, async (t) => {
	const context = await setup(t);
	await context.ask('codex', 'SAY fine');
	assert.equal(context.checks.count, 1);
	await context.ask('codex', 'SIGNEDOUT');
	// It is found signed out when looked at again, and the message is refused with what it needs.
	context.backends.codex = { ...context.backends.codex, ready: false, state: 'signed-out', message: 'Codex is not signed in. Run this in a terminal, then press Check again.' };
	await assert.rejects(context.chat.send({ backend: 'codex', messages: [{ role: 'user', text: 'SAY again' }] }), (error) => error.code === 'NOT_READY');
	assert.equal(context.checks.count, 2);
});

// --- stopping ------------------------------------------------------------------------------

test('a window that has just loaded stops whatever answer the last one left under way', options, async (t) => {
	const { chat, events, left } = await setup(t);
	chat.stopAny();
	await chat.send({ backend: 'codex', messages: [{ role: 'user', text: 'SAY one\nHANG' }] });
	while (!events.some((event) => event.type === 'text')) await wait(20);
	chat.stopAny();
	while (!events.some((event) => event.type === 'stopped')) await wait(20);
	assert.deepEqual(left(), []);
	chat.stopAny();
});


test('Stop ends the program and its MCP server, closes the listener, and keeps what was said', options, async (t) => {
	const { chat, events, left } = await setup(t);
	const { turnId } = await chat.send({ backend: 'claude', messages: [{ role: 'user', text: 'SAY Half an answer\nSEARCH hello\nHANG' }] });
	while (!events.some((event) => event.type === 'tool' && event.status === 'done')) await wait(20);
	assert.equal(left().filter((name) => name.startsWith('chat-')).length, 1);
	chat.stop('some-other-answer');
	await wait(50);
	assert.ok(!events.some((event) => event.type === 'stopped'));
	chat.stop(turnId);
	chat.stop(turnId);
	while (!events.some((event) => event.type === 'stopped')) await wait(20);
	assert.deepEqual(squash(kinds(events)), ['text', 'snippets_search:started', 'snippets_search:done', 'stopped']);
	assert.deepEqual(left(), []);
});

test('ollama: Stop drops the request', async (t) => {
	const api = await setup(t, { answers: [{ chunks: [said('Started. '), 'HANG'] }] });
	const { turnId } = await api.chat.send({ backend: 'ollama', model: 'qwen3:8b', messages: [{ role: 'user', text: 'Hi' }] });
	while (!api.events.some((event) => event.type === 'text')) await wait(20);
	api.chat.stop(turnId);
	while (!api.events.some((event) => event.type === 'stopped')) await wait(20);
	assert.deepEqual(kinds(api.events), ['text', 'stopped']);
	await wait(100);
	assert.deepEqual(api.ollama.closed, ['/api/chat']);
});

test('closing the app stops an answer under way and leaves nothing behind', options, async (t) => {
	const { chat, events, left } = await setup(t);
	await chat.send({ backend: 'codex', messages: [{ role: 'user', text: 'SAY one\nSEARCH hello\nHANG' }] });
	while (!events.some((event) => event.type === 'tool' && event.status === 'done')) await wait(20);
	await chat.dispose();
	assert.deepEqual(left(), []);
	await assert.rejects(chat.send({ backend: 'codex', messages: [{ role: 'user', text: 'SAY again' }] }), (error) => error.code === 'CLOSED');
});

test('a stop that arrives while an answer is still starting ends it before any program runs', options, async (t) => {
	// At once: the program is not even looked for.
	const early = await setup(t, { locateDelay: 300 });
	const first = await early.chat.send({ backend: 'codex', messages: [{ role: 'user', text: 'SAY should never be said' }] });
	early.chat.stop(first.turnId);
	while (!early.events.some((event) => ['done', 'error', 'stopped'].includes(event.type))) await wait(20);
	assert.deepEqual(early.events.map((event) => event.type), ['stopped']);
	assert.equal(early.checks.located, 0);
	assert.deepEqual(early.left(), []);

	// A moment later, while the program is being looked for: it is stopped as soon as it starts.
	const later = await setup(t, { locateDelay: 400 });
	const second = await later.chat.send({ backend: 'codex', messages: [{ role: 'user', text: 'SAY should never be said' }] });
	while (later.checks.located === 0) await wait(10);
	later.chat.stop(second.turnId);
	while (!later.events.some((event) => ['done', 'error', 'stopped'].includes(event.type))) await wait(20);
	assert.deepEqual(later.events.map((event) => event.type), ['stopped']);
	assert.deepEqual(later.left(), []);
});

test('closing the app does not wait for a program that ignores a polite stop', options, async (t) => {
	for (const backend of ['claude', 'codex']) {
		const { chat, events, left } = await setup(t);
		await chat.send({ backend, messages: [{ role: 'user', text: 'STUBBORN\nPID\nHANG' }] });
		while (!events.some((event) => event.type === 'text')) await wait(20);
		const pid = Number(events.filter((event) => event.type === 'text').map((event) => event.text).join(''));
		const began = Date.now();
		await chat.dispose();
		const took = Date.now() - began;
		// Asked politely it would be waited on for two seconds.
		assert.ok(took < 1000, `${backend}: closing took ${took} ms`);
		assert.throws(() => process.kill(pid, 0), `${backend}: the program is still running`);
		assert.deepEqual(left(), []);
	}
});

test('closing the app while a message is still being checked means the answer never starts', options, async (t) => {
	const { chat, events, left, chatDir } = await setup(t, { statusDelay: 300 });
	const sending = chat.send({ backend: 'codex', messages: [{ role: 'user', text: 'SAY should never be said' }] });
	await wait(50);
	await chat.dispose();
	await assert.rejects(sending, (error) => error.code === 'CLOSED' && error.message === 'The app is closing.');
	await wait(400);
	assert.deepEqual(events, []);
	assert.deepEqual(left(), []);
	assert.equal(existsSync(join(chatDir, 'empty')), false);
});

test('what tells Claude Code which program to start, and what tells that program where to call, can be read by their owner only', options, async (t) => {
	const { chat, events, left, chatDir } = await setup(t);
	const { turnId } = await chat.send({ backend: 'claude', messages: [{ role: 'user', text: 'SAY started\nHANG' }] });
	while (!events.some((event) => event.type === 'text')) await wait(20);
	const files = left();
	assert.deepEqual(files.map((name) => name.replace(/-[a-f0-9]+/, '')).sort(), ['chat.json', 'mcp.json']);
	for (const name of files) assert.equal(statSync(join(chatDir, name)).mode & 0o777, 0o600, name);
	chat.stop(turnId);
	while (!events.some((event) => event.type === 'stopped')) await wait(20);
});

test('ollama: an answer that never ends is stopped at the same limit as the others', async (t) => {
	const thinking = Array.from({ length: 400 }, () => said('', { thinking: 'still thinking ' }));
	const api = await setup(t, { answers: [{ chunks: thinking }], chunkDelay: 25, limits: { totalMs: 400 } });
	const began = Date.now();
	const events = await api.answer({ backend: 'ollama', model: 'qwen3:8b', messages: [{ role: 'user', text: 'Hi' }] });
	assert.deepEqual(events, [{ type: 'error', code: 'TIMEOUT', message: 'Ollama took too long, so it was stopped.' }]);
	assert.ok(Date.now() - began < 3000);
});

test('a card belongs to the answer that asked for it, and is not made once that answer has ended', async (t) => {
	// The model asks for a file, and the answer is stopped while the card is still being worked out.
	const api = await setup(t, { answers: [{ chunks: [calls(['snippets_create_file', { name: 'late.yml' }]), END] }, { chunks: [said('never'), END] }] });
	const state = api.service.state.bind(api.service);
	let release;
	api.service.state = async () => {
		await new Promise((resolve) => (release = resolve));
		return state();
	};
	const first = await api.chat.send({ backend: 'ollama', model: 'qwen3:8b', messages: [{ role: 'user', text: 'Make a file' }] });
	while (!release) await wait(10);
	api.chat.stop(first.turnId);
	while (!api.events.some((event) => event.type === 'stopped')) await wait(10);
	// The next answer is under way when the first one's card would have been ready.
	api.service.state = state;
	const second = await api.chat.send({ backend: 'ollama', model: 'qwen3:8b', messages: [{ role: 'user', text: 'Hello' }] });
	release();
	while (!api.events.some((event) => event.turnId === second.turnId && event.type === 'done')) await wait(10);
	await wait(100);
	assert.deepEqual(api.events.filter((event) => event.type === 'proposal'), []);
});

// --- answers that do not end well ----------------------------------------------------------

test('a program that ends without an answer is reported with its last words', options, async (t) => {
	const { ask } = await setup(t);
	assert.deepEqual(await ask('claude', 'EXIT 3 the model is on fire'), [{ type: 'error', code: 'FAILED', message: 'Claude Code stopped unexpectedly: the model is on fire' }]);
	assert.deepEqual(await ask('codex', 'EXIT 0'), [{ type: 'error', code: 'FAILED', message: 'Codex stopped unexpectedly.' }]);
	assert.deepEqual(await ask('claude', "EXIT 1 error: unknown option '--restricted'"), [
		{ type: 'error', code: 'OLD', message: 'This Claude Code is older than the app needs. Update Claude Code, then try again.' },
	]);
});

test('a program that is no longer where it was found says so', options, async (t) => {
	const { ask } = await setup(t, { program: '/no/such/place/claude' });
	assert.deepEqual(await ask('claude', 'SAY hi'), [{ type: 'error', code: 'MISSING', message: 'Claude Code could not be started. Press Check again.' }]);
});

test('signed out, found only when it answers: the error carries what the backend needs', options, async (t) => {
	const context = await setup(t);
	const events = await context.ask('claude', 'SIGNEDOUT');
	assert.deepEqual(events, [{ type: 'error', code: 'SIGNED_OUT', message: 'Claude Code is not signed in. Sign it in from a terminal, then press Check again.' }]);
	assert.deepEqual(await context.ask('codex', 'SIGNEDOUT'), [{ type: 'error', code: 'SIGNED_OUT', message: 'Codex is not signed in. Sign it in from a terminal, then press Check again.' }]);
});

test('Claude Code listing a tool the app did not give is stopped before it answers', options, async (t) => {
	const { ask } = await setup(t);
	const events = await ask('claude', 'EXTRATOOL\nSAY should never be said\nHANG');
	assert.equal(events.length, 1);
	assert.deepEqual([events[0].type, events[0].code], ['error', 'UNSAFE']);
	assert.match(events[0].message, /tools this app did not give it \(Bash\)/);
});

test('Codex seen running a command is stopped', options, async (t) => {
	const { ask } = await setup(t);
	const events = await ask('codex', 'SAY before\nSHELL\nSAY after\nHANG');
	assert.deepEqual(events, [{ type: 'text', text: 'before' }, { type: 'error', code: 'UNSAFE', message: 'Codex ran a command, which this app does not allow, so it was stopped.' }]);
});

test('an answer that says nothing for too long, or never ends, or has no end of text, is stopped', options, async (t) => {
	const silent = await setup(t, { limits: { idleMs: 500 } });
	assert.deepEqual((await silent.ask('claude', 'SAY Thinking\nHANG')).at(-1), { type: 'error', code: 'TIMEOUT', message: 'Claude Code took too long, so it was stopped.' });
	const slow = await setup(t, { limits: { totalMs: 700 } });
	assert.deepEqual((await slow.ask('codex', 'FLOOD')).at(-1), { type: 'error', code: 'TIMEOUT', message: 'Codex took too long, so it was stopped.' });
	const endless = await setup(t, { limits: { maxText: 5000 } });
	const events = await endless.ask('codex', 'FLOOD');
	assert.deepEqual(events.at(-1), { type: 'error', code: 'TOO_LONG', message: 'The answer was too long, so it was stopped.' });
	assert.ok(textOf(events).length <= 5000);
	assert.deepEqual(endless.left(), []);
});

test('ollama: what it refuses is passed on as the ending', async (t) => {
	const api = await setup(t, { answers: [{ status: 400, error: 'gemma3:4b does not support tools' }] });
	assert.deepEqual(await api.answer({ backend: 'ollama', model: 'qwen3:8b', messages: [{ role: 'user', text: 'Hi' }] }), [
		{ type: 'error', code: 'NO_TOOLS', message: 'This model cannot use tools, so it cannot read your snippets. Pick another model.' },
	]);
});

// --- status --------------------------------------------------------------------------------

test('status is what the backends report, and applying or dismissing a card that is not there says so', options, async (t) => {
	const { chat } = await setup(t);
	assert.deepEqual((await chat.status()).map((item) => [item.id, item.ready]), [['claude', true], ['codex', true], ['ollama', true]]);
	await assert.rejects(chat.apply('nothing'), (error) => error.code === 'NOT_FOUND');
	assert.throws(() => chat.dismiss('nothing'), (error) => error.code === 'NOT_FOUND');
});

// --- what the app looks up first -----------------------------------------------------------

const THANKS = [
	{ fileId: 'local:base.yml', fileName: 'base.yml', source: 'local', index: 2, triggers: [';ty', ';thanks'], label: '', preview: 'Thank you!' },
	{ fileId: 'package:goodbyes:package.yml', fileName: 'package.yml', source: 'package', package: 'goodbyes', index: 0, triggers: [':bye'], label: 'Friendly goodbye', preview: 'Thanks for reaching out. Have a great day!' },
];

for (const backend of ['claude', 'codex']) {
	test(`${backend}: the closest matches are told first, before the program is even looked for, and go to it with the message`, options, async (t) => {
		let context;
		let locatedThen = null;
		context = await setup(t, {
			tap: (event) => {
				if (event.type === 'found') locatedThen = context.checks.located;
			},
		});
		const events = await context.ask(backend, 'Where is my thanks snippet?\nARGS', { context: { fileId: 'local:base.yml', fileName: 'base.yml', index: 1, trigger: ';sig' } });
		assert.deepEqual(squash(kinds(events)), ['found', 'text', 'done']);
		assert.deepEqual(events[0], { type: 'found', hits: THANKS });
		assert.equal(locatedThen, 0);

		const seen = JSON.parse(textOf(events));
		const block = seen.input.split('</open_in_the_app>\n\n')[1].split('\n\n<new_message>')[0].split('\n');
		assert.equal(block[0], '<looked_up_by_the_app>');
		assert.equal(block.at(-1), '</looked_up_by_the_app>');
		assert.equal(block[2], 'snippets_get_snippet {"file_id":"local:base.yml","index":1} returned:');
		assert.equal(JSON.parse(block[3]).snippet.label, 'Signature');
		assert.match(block[4], /^The snippets closest to the words of the new message \("thanks", "args"\), closest first\./);
		assert.deepEqual(JSON.parse(block[5]).items.map((item) => [item.file_id, item.index]), [['local:base.yml', 2], ['package:goodbyes:package.yml', 0]]);
		assert.equal(block[6], 'snippets_get_file {"file_id":"local:base.yml","limit":25} returned:');
		assert.match(JSON.parse(block[7]).version, /^[a-f0-9]{24}$/);
		assert.equal(block.length, 9);
		assert.ok(seen.input.endsWith('<new_message>\nWhere is my thanks snippet?\nARGS\n</new_message>\n'));
		// Like the message, what was looked up is not among the arguments.
		assert.ok(!seen.args.join('\n').includes('Thank you!'));
	});
}

test('ollama: the closest matches are told first, and go to it ahead of the message', async (t) => {
	const api = await setup(t);
	const events = await api.answer({ backend: 'ollama', model: 'qwen3:8b', messages: [{ role: 'user', text: 'Where is my thanks snippet?' }] });
	assert.deepEqual(events, [{ type: 'found', hits: THANKS }, { type: 'text', text: 'From Ollama.' }, { type: 'done' }]);
	const content = api.ollama.requests[0].body.messages.at(-1).content;
	assert.ok(content.startsWith('<looked_up_by_the_app>\n'));
	assert.ok(content.endsWith('</looked_up_by_the_app>\n\nWhere is my thanks snippet?'));
	assert.ok(content.includes('"triggers":[";ty",";thanks"]'));

	// In a longer conversation it is the new message that is looked up, not an earlier one.
	const later = await api.answer({
		backend: 'ollama',
		model: 'qwen3:8b',
		messages: [
			{ role: 'user', text: 'Where is my hello snippet?' },
			{ role: 'assistant', text: 'It is ;hello.' },
			{ role: 'user', text: 'And my thanks snippet?' },
		],
	});
	assert.deepEqual(later[0], { type: 'found', hits: THANKS });
});

test('a message with nothing to search for, or that nothing matches, tells of no matches', options, async (t) => {
	const { ask } = await setup(t);
	assert.deepEqual(kinds(await ask('codex', 'SAY Hi.')), ['text', 'done']);
	assert.deepEqual(kinds(await ask('codex', 'Where is the zebra crossing rota?\nSAY Nowhere.')), ['text', 'done']);
	// And nothing is put in the message for it.
	const seen = JSON.parse(textOf(await ask('codex', 'ARGS')));
	assert.equal(seen.input, '<new_message>\nARGS\n</new_message>\n');
});

test('looking up is a convenience: when it fails, the answer comes all the same', options, async (t) => {
	const logged = [];
	const { ask } = await setup(t, {
		log: (error) => logged.push(error),
		lookUp: async () => {
			throw new Error('the lookups fell over');
		},
	});
	assert.deepEqual(kinds(await ask('codex', 'Where is my thanks snippet?\nSAY Here.')), ['text', 'done']);
	assert.deepEqual(logged.map((error) => error.message), ['the lookups fell over']);
});

test('Stop while the app is still looking ends the answer before any program runs, and tells of no matches', options, async (t) => {
	const context = await setup(t, {
		lookUp: async () => {
			await wait(300);
			return { found: THANKS, lookups: [] };
		},
	});
	const { turnId } = await context.chat.send({ backend: 'codex', messages: [{ role: 'user', text: 'SAY should never be said' }] });
	await wait(50);
	context.chat.stop(turnId);
	while (!context.events.some((event) => ['done', 'error', 'stopped'].includes(event.type))) await wait(20);
	assert.deepEqual(context.events.map((event) => event.type), ['stopped']);
	assert.equal(context.checks.located, 0);
	assert.deepEqual(context.left(), []);
});

// --- after an independent review ---------------------------------------------------------------

test('a look that began before a backend was found gone does not vouch for it afterwards', options, async (t) => {
	const context = await setup(t, { statusDelay: 400 });
	await context.chat.status();
	// A look is under way (the panel's "Check again", say) when the answer fails.
	const under = context.chat.status();
	assert.equal(context.checks.count, 2);
	const failed = await context.ask('codex', 'SIGNEDOUT');
	assert.equal(failed.at(-1).code, 'SIGNED_OUT');
	context.backends.codex = { ...context.backends.codex, ready: false, state: 'signed-out', message: 'Codex is not signed in.' };
	// "Check again", pressed now, is not handed the look that was already under way: it gets a new one.
	const again = context.chat.status();
	assert.equal(context.checks.count, 3);
	// The older look read the backends before the answer failed, and says "ready".
	assert.equal((await under).find((item) => item.id === 'codex').ready, true);
	assert.equal((await again).find((item) => item.id === 'codex').ready, false);
	// The next message goes on the newer one, and is refused.
	await assert.rejects(context.chat.send({ backend: 'codex', messages: [{ role: 'user', text: 'SAY again' }] }), (error) => error.code === 'NOT_READY' && error.message === 'Codex is not signed in.');
	assert.equal(context.checks.count, 3);
});

test('with no look made since a backend was found gone, the next message makes one, whatever an older look says later', options, async (t) => {
	const context = await setup(t, { statusDelay: 400 });
	await context.chat.status();
	const under = context.chat.status();
	await context.ask('codex', 'SIGNEDOUT');
	context.backends.codex = { ...context.backends.codex, ready: false, state: 'signed-out', message: 'Codex is not signed in.' };
	assert.equal((await under).find((item) => item.id === 'codex').ready, true);
	await assert.rejects(context.chat.send({ backend: 'codex', messages: [{ role: 'user', text: 'SAY again' }] }), (error) => error.code === 'NOT_READY');
	assert.equal(context.checks.count, 3);
});

test('the look behind an answer is made when the answer has ended, not while the backend is starting', async (t) => {
	const context = await setup(t, { limits: { statusMs: 1 }, chunkDelay: 150, answers: [{ chunks: [said('One. '), said('Two. '), said('Three.'), END] }] });
	await context.chat.status();
	await wait(20);
	const { turnId } = await context.chat.send({ backend: 'ollama', model: 'qwen3:8b', messages: [{ role: 'user', text: 'Hi' }] });
	await wait(200);
	assert.equal(context.checks.count, 1);
	while (!context.events.some((event) => event.turnId === turnId && event.type === 'done')) await wait(10);
	assert.equal(context.checks.count, 2);
});

test('a look that falls over at once does not stand in the way of the next one', async (t) => {
	const context = await setup(t, { statusFault: (count) => count === 1 });
	await assert.rejects(context.chat.status(), /the look fell over/);
	assert.equal((await context.chat.status()).length, 3);
	assert.equal((await context.chat.status()).length, 3);
	assert.equal(context.checks.count, 3);
	assert.deepEqual(kinds(await context.answer({ backend: 'ollama', model: 'qwen3:8b', messages: [{ role: 'user', text: 'Hi' }] })), ['text', 'done']);
});

test('Stop does not wait for the app to finish looking: it ends the answer at once, and the next message can be sent', options, async (t) => {
	const context = await setup(t, { lookUp: () => new Promise(() => {}) });
	const { turnId } = await context.chat.send({ backend: 'codex', messages: [{ role: 'user', text: 'SAY should never be said' }] });
	await wait(50);
	const began = Date.now();
	context.chat.stop(turnId);
	while (!context.events.some((event) => ['done', 'error', 'stopped'].includes(event.type))) await wait(5);
	assert.ok(Date.now() - began < 200, `stopping took ${Date.now() - began} ms`);
	assert.deepEqual(context.events.map((event) => event.type), ['stopped']);
	assert.equal(context.checks.located, 0);
	assert.deepEqual(kinds(await context.ask('codex', 'SAY Next.')), ['stopped', 'text', 'done'].slice(1));
});

test('looking up has a time limit: past it the backend is asked without, and what comes late is not shown', options, async (t) => {
	const logged = [];
	const context = await setup(t, {
		limits: { lookupMs: 80 },
		log: (error) => logged.push(error.message),
		lookUp: async () => {
			await wait(400);
			return { found: THANKS, lookups: [{ tool: 'snippets_search', words: ['thanks'], result: { items: [] } }] };
		},
	});
	const events = await context.ask('codex', 'ARGS');
	assert.deepEqual(squash(kinds(events)), ['text', 'done']);
	assert.ok(!JSON.parse(textOf(events)).input.includes('looked_up_by_the_app'));
	assert.deepEqual(logged, ['Looking up took over 80 ms, so the assistant was asked without it.']);
	// The lookups finish at last, and nothing more is told for that answer.
	await wait(450);
	assert.deepEqual(context.events.map((event) => event.type).filter((type) => type === 'found'), []);
});

// --- which model answers ---------------------------------------------------------------------

const QUICK = [{ name: 'quick-one', label: 'Quick One', about: 'Fast.' }, { name: 'big-one', label: 'Big One', about: 'Thorough.' }];
const withModels = { claude: ready('claude', 'Claude Code', { sendsTo: 'Anthropic', models: QUICK }), codex: ready('codex', 'Codex', { sendsTo: 'OpenAI', models: QUICK }) };

test('a chosen model is named to the program, and with none chosen the program is left to choose', options, async (t) => {
	const { ask } = await setup(t, { status: withModels });
	const argsOf = async (backend, extra) => JSON.parse(textOf(await ask(backend, 'ARGS', extra))).args;

	const codex = await argsOf('codex', { model: 'quick-one' });
	assert.deepEqual(codex.slice(0, 3), ['exec', '-m', 'quick-one']);
	const claude = await argsOf('claude', { model: 'big-one' });
	assert.equal(claude[claude.indexOf('--model') + 1], 'big-one');
	assert.equal(claude.filter((arg) => arg === '--model').length, 1);

	for (const none of [{}, { model: undefined }, { model: null }, { model: '' }]) {
		const plain = await argsOf('codex', none);
		assert.ok(!plain.includes('-m') && !plain.includes('--model'), JSON.stringify(none));
		assert.equal(plain[1], '--json');
		assert.ok(!(await argsOf('claude', none)).includes('--model'), JSON.stringify(none));
	}
});

test('a model that is not one of the backend\'s own is refused, and nothing is started', options, async (t) => {
	const context = await setup(t, { status: withModels });
	const send = (backend, model) => context.chat.send({ backend, model, messages: [{ role: 'user', text: 'SAY never' }] });
	for (const model of ['gpt-other', 'Quick-One', 'quick-one ', '--oss', '-m', 7, {}, ['quick-one'], true]) {
		await assert.rejects(send('codex', model), (error) => error.code === 'INVALID' && error.message === "Choose one of Codex's models, or its own choice.", String(model));
		await assert.rejects(send('claude', model), (error) => error.code === 'INVALID' && error.message === "Choose one of Claude Code's models, or its own choice.", String(model));
	}
	assert.equal(context.checks.located, 0);
	assert.deepEqual(context.events, []);
	// The refusal leaves the chat free for the next message.
	assert.deepEqual(kinds(await context.ask('codex', 'SAY Fine.', { model: 'quick-one' })), ['text', 'done']);

	// With no list to choose from, no name is taken on trust.
	const bare = await setup(t);
	await assert.rejects(bare.chat.send({ backend: 'codex', model: 'quick-one', messages: [{ role: 'user', text: 'SAY never' }] }), (error) => error.code === 'INVALID');
	assert.deepEqual(kinds(await bare.ask('codex', 'SAY Fine.')), ['text', 'done']);
});
