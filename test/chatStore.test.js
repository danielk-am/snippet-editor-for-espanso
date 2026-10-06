import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KEY, LIMITS, createChatStore, emptyState, titleOf } from '../renderer/lib/chatStore.js';
import { diffLines } from '../renderer/lib/diff.js';

function storage({ quota = Infinity, broken = false } = {}) {
	const kept = new Map();
	return {
		kept,
		writes: 0,
		getItem(key) {
			if (broken) throw new Error('storage is not available');
			return kept.has(key) ? kept.get(key) : null;
		},
		setItem(key, value) {
			this.writes += 1;
			if (broken) throw new Error('storage is not available');
			if (value.length > quota) throw Object.assign(new Error('quota'), { name: 'QuotaExceededError' });
			kept.set(key, value);
		},
	};
}

const message = (id, role, text, extra = {}) => ({ id, role, text, ...(role === 'assistant' ? { backend: 'codex', tools: [], cards: [], ending: 'done', error: null } : {}), ...extra });
const conversation = (id, updatedAt, messages = [message(`${id}-1`, 'user', `Question ${id}`), message(`${id}-2`, 'assistant', `Answer ${id}`)]) => ({ id, title: `Conversation ${id}`, updatedAt, messages });
const card = (extra = {}) => ({ id: 'abc123', tool: 'snippets_add_snippet', kind: 'add', title: 'Add a snippet to base.yml', subject: ';x', fileId: 'local:base.yml', fileName: 'base.yml', before: null, after: '- trigger: ";x"\n', lines: [], warnings: [], status: 'applied', message: null, code: null, link: null, ...extra });

// --- history -------------------------------------------------------------------------------

test('with nothing saved, the chat starts closed, 400 wide, with no conversations', () => {
	const state = createChatStore(storage()).load();
	assert.deepEqual(state, { prefs: { open: false, width: 400, wide: false, backend: null, model: '', told: [] }, conversations: [], current: null });
	assert.deepEqual(state, emptyState());
	assert.equal(KEY, 'snippet-editor.chat.v1');
});

test('what is saved comes back as it was', () => {
	const store = createChatStore(storage());
	const state = {
		prefs: { open: true, width: 520, wide: true, backend: 'ollama', model: 'qwen3:8b', told: ['codex'] },
		conversations: [conversation('b', 200, [message('m1', 'user', 'Add a snippet'), message('m2', 'assistant', 'Proposed.', { tools: [{ id: 't1', name: 'snippets_add_snippet', status: 'done' }], cards: [card()] })]), conversation('a', 100)],
		current: 'b',
	};
	assert.equal(store.save(state), true);
	assert.deepEqual(store.load(), state);
});

test('only the 20 newest conversations and the last 100 messages of each are kept', () => {
	const store = createChatStore(storage());
	const many = Array.from({ length: 130 }, (_, index) => message(`m${index}`, index % 2 ? 'assistant' : 'user', `text ${index}`));
	const conversations = [...Array.from({ length: 24 }, (_, index) => conversation(`c${index}`, 1000 + index)), conversation('long', 5000, many)];
	store.save({ ...emptyState(), conversations, current: 'c0' });
	const loaded = store.load();
	assert.deepEqual(LIMITS, { conversations: 20, messages: 100, cardText: 4000 });
	assert.equal(loaded.conversations.length, 20);
	assert.deepEqual(loaded.conversations.slice(0, 3).map((item) => item.id), ['long', 'c23', 'c22']);
	assert.equal(loaded.conversations.at(-1).id, 'c5');
	assert.equal(loaded.conversations[0].messages.length, 100);
	assert.equal(loaded.conversations[0].messages[0].id, 'm30');
	// The open conversation was among those dropped.
	assert.equal(loaded.current, null);
});

test('a card is kept small, and one that was still waiting when the app closed comes back as expired', () => {
	const store = createChatStore(storage());
	const long = 'x'.repeat(10_000);
	const cards = [card({ id: 'a', status: 'pending', before: long, after: long }), card({ id: 'b', status: 'applying' }), card({ id: 'c', status: 'applied' }), card({ id: 'd', status: 'stale', message: 'This changed after the proposal was made. Ask again.', code: 'STALE' }), card({ id: 'e', status: 'dismissed' })];
	store.save({ ...emptyState(), conversations: [conversation('a', 1, [message('m1', 'user', 'Go'), message('m2', 'assistant', 'Done.', { cards })])] });
	const loaded = store.load().conversations[0].messages[1].cards;
	assert.deepEqual(loaded.map((item) => [item.id, item.status]), [['a', 'expired'], ['b', 'expired'], ['c', 'applied'], ['d', 'stale'], ['e', 'dismissed']]);
	assert.equal(loaded[0].before, `${'x'.repeat(4000)}\n[cut: 10,000 characters in all]`);
	assert.equal(loaded[0].after, loaded[0].before);
	assert.equal(loaded[3].message, 'This changed after the proposal was made. Ask again.');
	assert.deepEqual(Object.keys(loaded[2]).sort(), Object.keys(card()).sort());
});

test('an answer that was under way when the app closed comes back as stopped', () => {
	const store = createChatStore(storage());
	store.save({ ...emptyState(), conversations: [conversation('a', 1, [message('m1', 'user', 'Go'), message('m2', 'assistant', 'Half an ans', { ending: null, tools: [{ id: 't', name: 'snippets_search', status: 'started' }] })])] });
	const answer = store.load().conversations[0].messages[1];
	assert.deepEqual([answer.ending, answer.text, answer.tools], ['stopped', 'Half an ans', [{ id: 't', name: 'snippets_search', status: 'failed' }]]);
});

test('damaged history is dropped piece by piece: what is sound is kept', () => {
	const fake = storage();
	const store = createChatStore(fake);
	const load = (value) => {
		fake.kept.set(KEY, typeof value === 'string' ? value : JSON.stringify(value));
		return store.load();
	};
	for (const broken of ['', 'not json', 'null', '[]', '"text"', '{"conversations":"many"}']) assert.deepEqual(load(broken), emptyState(), broken);

	const loaded = load({
		prefs: { open: 'yes', width: 5, wide: 1, backend: 'gpt', model: 7, told: ['claude', 'evil', 3] },
		conversations: [
			conversation('good', 5),
			{ id: 7, title: 'no', updatedAt: 1, messages: [] },
			{ id: 'no-messages', title: 't', updatedAt: 1 },
			null,
			{ id: 'mixed', title: 99, updatedAt: 'soon', messages: [message('ok', 'user', 'Kept'), { id: 'bad', role: 'system', text: 'x' }, { role: 'user', text: 'no id' }, message('odd', 'assistant', 'A', { tools: 'none', cards: [null, { id: 1 }, card({ id: 'fine' })], ending: 'exploded', error: 'text' })] },
			{ id: 'empty', title: 'e', updatedAt: 3, messages: [] },
		],
		current: 'mixed',
	});
	assert.deepEqual(loaded.prefs, { open: false, width: 320, wide: false, backend: null, model: '', told: ['claude'] });
	assert.deepEqual(loaded.conversations.map((item) => item.id), ['good', 'mixed']);
	const mixed = loaded.conversations[1];
	assert.deepEqual([mixed.title, mixed.updatedAt], ['Kept', 0]);
	assert.deepEqual(mixed.messages.map((item) => item.id), ['ok', 'odd']);
	assert.deepEqual([mixed.messages[1].tools, mixed.messages[1].cards.map((item) => item.id), mixed.messages[1].ending, mixed.messages[1].error], [[], ['fine'], 'stopped', null]);
	assert.equal(loaded.current, 'mixed');
	assert.equal(load({ prefs: { width: 99_999 } }).prefs.width, 1200);
});

test('a storage that cannot be read or written does not stop the chat', () => {
	const store = createChatStore(storage({ broken: true }));
	assert.deepEqual(store.load(), emptyState());
	assert.equal(store.save({ ...emptyState(), conversations: [conversation('a', 1)] }), false);
	assert.deepEqual(createChatStore(null).load(), emptyState());
	assert.equal(createChatStore(undefined).save(emptyState()), false);
});

test('when there is not room for everything, the oldest conversations give way', () => {
	const fake = storage({ quota: 2500 });
	const store = createChatStore(fake);
	const conversations = Array.from({ length: 10 }, (_, index) => conversation(`c${index}`, index, [message(`u${index}`, 'user', 'q'.repeat(300)), message(`a${index}`, 'assistant', 'a'.repeat(300))]));
	assert.equal(store.save({ ...emptyState(), conversations, current: 'c9' }), true);
	const loaded = store.load();
	assert.ok(loaded.conversations.length >= 1 && loaded.conversations.length < 10);
	assert.equal(loaded.conversations[0].id, 'c9');
	assert.equal(loaded.current, 'c9');
	// Not even the preferences fit: nothing is saved, and nothing is thrown.
	assert.equal(createChatStore(storage({ quota: 10 })).save({ ...emptyState(), conversations }), false);
});

test('a conversation is named after its first message', () => {
	assert.equal(titleOf('Find my signature'), 'Find my signature');
	assert.equal(titleOf('  Make\n  it   warmer  '), 'Make it warmer');
	assert.equal(titleOf('x'.repeat(100)), `${'x'.repeat(59)}…`);
	assert.equal(titleOf(''), 'New conversation');
	assert.equal(titleOf(null), 'New conversation');
});

// --- what changed, line by line ------------------------------------------------------------

const row = (kind, text) => ({ kind, text });
const skip = (count) => ({ kind: 'skip', count });

test('the lines that differ are marked, with a little of what is around them', () => {
	assert.deepEqual(diffLines('a\nb\nc\n', 'a\nB\nc\n'), [row('same', 'a'), row('remove', 'b'), row('add', 'B'), row('same', 'c')]);
	assert.deepEqual(diffLines('a\nb\n', 'a\nb\nc\n'), [row('same', 'a'), row('same', 'b'), row('add', 'c')]);
	assert.deepEqual(diffLines('a\nb\nc\n', 'a\nc\n'), [row('same', 'a'), row('remove', 'b'), row('same', 'c')]);
	assert.deepEqual(diffLines('same\n', 'same\n'), []);
	assert.deepEqual(diffLines('', ''), []);
});

test('something new is all added, something going is all removed', () => {
	assert.deepEqual(diffLines(null, '- trigger: ";x"\n  replace: "X"\n'), [row('add', '- trigger: ";x"'), row('add', '  replace: "X"')]);
	assert.deepEqual(diffLines('- trigger: ";x"\n', null), [row('remove', '- trigger: ";x"')]);
	assert.deepEqual(diffLines('', 'one'), [row('add', 'one')]);
});

test('long stretches that did not change are folded, and say how many lines they hold', () => {
	const lines = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`);
	const changed = lines.map((line, index) => (index === 14 ? 'line fifteen' : line));
	assert.deepEqual(diffLines(`${lines.join('\n')}\n`, `${changed.join('\n')}\n`), [skip(12), row('same', 'line 13'), row('same', 'line 14'), row('remove', 'line 15'), row('add', 'line fifteen'), row('same', 'line 16'), row('same', 'line 17'), skip(13)]);
	assert.deepEqual(diffLines(`${lines.join('\n')}\n`, `${changed.join('\n')}\n`, { context: 0 }), [skip(14), row('remove', 'line 15'), row('add', 'line fifteen'), skip(15)]);
	// Two changes close together share the lines between them.
	const two = lines.map((line, index) => (index === 10 || index === 13 ? `${line}!` : line));
	const rows = diffLines(lines.join('\n'), two.join('\n'));
	assert.deepEqual(rows.filter((item) => item.kind === 'skip'), [skip(8), skip(14)]);
	assert.deepEqual(rows.filter((item) => item.kind === 'same').map((item) => item.text), ['line 9', 'line 10', 'line 12', 'line 13', 'line 15', 'line 16']);
});

test('a difference only in the line end at the bottom is said in words', () => {
	assert.deepEqual(diffLines('a\nb', 'a\nb\n'), [{ kind: 'note', text: 'Only the line end at the bottom differs.' }]);
});

test('two very long and very different texts are shown whole, old then new, without a long wait', () => {
	const before = Array.from({ length: 20_000 }, (_, index) => `old ${index}`).join('\n');
	const after = Array.from({ length: 20_000 }, (_, index) => `new ${index}`).join('\n');
	const began = Date.now();
	const rows = diffLines(before, after);
	assert.ok(Date.now() - began < 2000);
	assert.deepEqual([rows.length, rows[0], rows[19_999], rows[20_000], rows.at(-1)], [40_000, row('remove', 'old 0'), row('remove', 'old 19999'), row('add', 'new 0'), row('add', 'new 19999')]);
	// Past the limit nothing is matched up, even where lines are shared in the middle.
	const shared = ['one', 'two', 'three'];
	const a = ['top', ...shared, 'bottom'].join('\n');
	const b = ['TOP', ...shared, 'BOTTOM'].join('\n');
	assert.deepEqual(diffLines(a, b).map((item) => item.kind), ['remove', 'add', 'same', 'same', 'same', 'remove', 'add']);
	assert.deepEqual(diffLines(a, b, { budget: 24 }).map((item) => item.kind), ['remove', 'remove', 'remove', 'remove', 'remove', 'add', 'add', 'add', 'add', 'add']);
	// Long but nearly the same is still compared line by line.
	const near = before.replace('old 1500\n', 'OLD 1500\n');
	assert.deepEqual(diffLines(before, near, { context: 0 }), [skip(1500), row('remove', 'old 1500'), row('add', 'OLD 1500'), skip(18_499)]);
});
