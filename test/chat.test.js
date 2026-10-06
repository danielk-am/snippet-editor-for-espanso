import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
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

async function setup(t, { status = {}, answers = [{ chunks: [said('From Ollama.'), END] }], limits, aiWrite = true, program = FAKE, tap = () => {} } = {}) {
	const api = await startApi(t, { enabled: false, aiWrite });
	const ollama = await standIn(t, { answers });
	const events = [];
	const backends = {
		claude: ready('claude', 'Claude Code', { sendsTo: 'Anthropic' }),
		codex: ready('codex', 'Codex', { sendsTo: 'OpenAI' }),
		ollama: ready('ollama', 'Ollama', { models: [{ name: 'qwen3:8b', cloud: false }] }),
		...status,
	};
	const checks = { count: 0 };
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
			status: async () => {
				checks.count += 1;
				return Object.values(backends);
			},
			locate: async () => program,
		},
		ollama: ollama.ollama,
		log: () => {},
		...(limits ? { limits } : {}),
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
		{ type: 'text', text: 'Looking.' },
		{ type: 'tool', id: 'call-1-1', name: 'snippets_search', status: 'started' },
		{ type: 'tool', id: 'call-1-1', name: 'snippets_search', status: 'done' },
		{ type: 'text', text: '\n\nFound `;hello`.' },
		{ type: 'done' },
	]);
	const sent = api.ollama.requests[0].body;
	assert.equal(sent.model, 'qwen3:8b');
	assert.match(sent.messages[0].content, /^You are the assistant inside Snippet Editor/);
	assert.equal(sent.messages.at(-1).content, '[Open in the app: The person has the file base.yml open (file id local:base.yml).]\n\nFind hello');
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

	// With no memory at all, every message looks first.
	const fresh = await setup(t, { limits: { statusMs: 0 } });
	await fresh.answer(hello);
	await fresh.answer(hello);
	assert.equal(fresh.checks.count, 2);
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
