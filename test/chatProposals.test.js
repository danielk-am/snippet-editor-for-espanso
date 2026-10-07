import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRouter } from '../core/apiRouter.js';
import { createInProcessApi } from '../core/chat/inProcess.js';
import { createProposals } from '../core/chat/proposals.js';
import { createGit } from '../core/git.js';
import { parseRepositoryAddress } from '../core/teamAddress.js';
import { createApiClient } from '../mcp/client.mjs';
import { startApi } from './helpers/apiFixture.js';
import { MANIFEST, MATCHES, createRemote, gitEnv, seeded } from './helpers/teamRemote.js';

async function setup(t, { aiWrite = true, serviceOptions, limit } = {}) {
	const api = await startApi(t, { enabled: false, aiWrite, serviceOptions });
	const router = createRouter({ service: api.service, log: () => {} });
	const cards = [];
	const proposals = createProposals({ router, aiWrite: () => api.service.settings().aiWrite, onCard: (card) => cards.push(card), ...(limit ? { limit } : {}) });
	const read = (name) => readFileSync(join(api.matchDir, name), 'utf8');
	const route = async (method, path, extra = {}) => (await router({ method, path: `/api/v1${path}`, ...extra })).body;
	const file = (id) => route('GET', `/files/${encodeURIComponent(id)}`);
	const version = async (id) => (await file(id)).version;
	const yaml = async (match) => (await route('POST', '/yaml/preview', { body: { match } })).yaml;
	// What a tool call does in chat: its input is checked, then it is handed
	// over. The card, or the words the model gets back.
	const propose = async (tool, args) => {
		const result = await proposals.tools.call(tool, args);
		assert.ok(result, `unknown tool ${tool}`);
		return result.isError ? { error: result.content[0].text } : proposals.get(result.structuredContent.proposal_id);
	};
	const triggers = async (id) => (await file(id)).matches.map((match) => match.trigger ?? match.triggers ?? match.regex);
	return { ...api, router, proposals, cards, read, route, file, version, yaml, propose, triggers };
}

const BASE = 'local:base.yml';
const COMMAND = 'Runs a command on your computer each time it is used.';
const STALE = 'This changed after the proposal was made. Ask again.';

// --- cards ---------------------------------------------------------------------------------

test('a proposed snippet becomes a card that shows it, and nothing is written', async (t) => {
	const { propose, read, version, cards, proposals } = await setup(t);
	const before = read('base.yml');
	const card = await propose('snippets_add_snippet', { file_id: BASE, snippet: { trigger: ';x', replace: 'X' }, version: await version(BASE) });
	assert.match(card.id, /^[a-f0-9]{12}$/);
	assert.deepEqual(card, {
		id: card.id,
		tool: 'snippets_add_snippet',
		kind: 'add',
		title: 'Add a snippet to base.yml',
		subject: ';x',
		fileId: BASE,
		fileName: 'base.yml',
		before: null,
		after: '- trigger: ";x"\n  replace: "X"\n',
		lines: [],
		warnings: [],
		status: 'pending',
		message: null,
		code: null,
		link: null,
	});
	assert.deepEqual(cards, [card]);
	assert.deepEqual(proposals.all(), [card]);
	assert.equal(read('base.yml'), before);
});

test('Apply writes it the way the window would, and the card says so', async (t) => {
	const { propose, read, version, proposals } = await setup(t);
	const before = read('base.yml');
	const card = await propose('snippets_add_snippet', { file_id: BASE, snippet: { trigger: ';x', replace: 'X' }, version: await version(BASE) });
	const applied = await proposals.apply(card.id);
	assert.deepEqual([applied.status, applied.message, applied.code], ['applied', null, null]);
	assert.equal(read('base.yml'), `${before}\n  - trigger: ";x"\n    replace: "X"\n`);
	assert.equal(proposals.get(card.id).status, 'applied');
});

test('a change shows the snippet as it is and as it would be, and a deletion shows what would go', async (t) => {
	const { propose, version, yaml, file } = await setup(t);
	const sig = (await file(BASE)).matches[1];
	const changed = await propose('snippets_update_snippet', { file_id: BASE, index: 1, snippet: { ...sig, replace: 'Kind regards,\n{{firstname}}' }, version: await version(BASE) });
	assert.deepEqual(
		[changed.kind, changed.title, changed.subject, changed.before, changed.after],
		['update', 'Change a snippet in base.yml', ';sig', await yaml(sig), await yaml({ ...sig, replace: 'Kind regards,\n{{firstname}}' })]
	);
	const gone = await propose('snippets_delete_snippet', { file_id: BASE, index: 2, version: await version(BASE) });
	assert.deepEqual([gone.kind, gone.title, gone.subject, gone.before, gone.after], ['delete', 'Delete a snippet from base.yml', ';ty, ;thanks', await yaml({ triggers: [';ty', ';thanks'], replace: 'Thank you!' }), null]);
});

test('a new file and a file\'s whole text each get a card that says what they are', async (t) => {
	const { propose, version, read, proposals, matchDir } = await setup(t);
	const made = await propose('snippets_create_file', { name: 'work.yml', description: 'Replies for work', prefix: ':' });
	assert.deepEqual(
		[made.kind, made.title, made.subject, made.fileId, made.fileName, made.before, made.after, made.lines],
		['create-file', 'Create the file work.yml', 'work.yml', null, 'work.yml', null, null, ['Description: Replies for work', 'Prefix: :']]
	);
	assert.deepEqual((await propose('snippets_create_file', { name: 'plain.yml' })).lines, []);

	const text = 'matches:\n  - trigger: ";only"\n    replace: "Only this"\n';
	const whole = await propose('snippets_replace_file_yaml', { file_id: BASE, yaml: text, version: await version(BASE) });
	assert.deepEqual([whole.kind, whole.title, whole.subject, whole.before, whole.after, whole.warnings], ['replace-file', 'Replace the text of base.yml', 'base.yml', read('base.yml'), text, []]);

	assert.equal((await proposals.apply(made.id)).status, 'applied');
	assert.match(readFileSync(join(matchDir, 'work.yml'), 'utf8'), /^# Replies for work\n# prefix: ":"\n/);
	assert.equal((await proposals.apply(whole.id)).status, 'applied');
	assert.equal(read('base.yml'), text);
});

// --- several cards for one file ------------------------------------------------------------

test('three snippets proposed for one file apply one after another', async (t) => {
	const { propose, version, proposals, triggers } = await setup(t);
	const v = await version(BASE);
	const cards = [];
	for (const name of [';one', ';two', ';three']) cards.push(await propose('snippets_add_snippet', { file_id: BASE, snippet: { trigger: name, replace: name }, version: v }));
	for (const card of cards) assert.equal((await proposals.apply(card.id)).status, 'applied', card.subject);
	assert.deepEqual(await triggers(BASE), [';hello', ';sig', [';ty', ';thanks'], ';one', ';two', ';three']);
});

test('two deletions proposed for one file remove the two snippets that were meant, in either order', async (t) => {
	for (const order of [[0, 1], [1, 0]]) {
		const { propose, version, proposals, triggers } = await setup(t);
		const v = await version(BASE);
		const cards = [await propose('snippets_delete_snippet', { file_id: BASE, index: 0, version: v }), await propose('snippets_delete_snippet', { file_id: BASE, index: 2, version: v })];
		for (const which of order) assert.equal((await proposals.apply(cards[which].id)).status, 'applied');
		assert.deepEqual(await triggers(BASE), [';sig']);
	}
});

test('a snippet asked for at a position goes there while the file is that long, and at the end otherwise', async (t) => {
	const { propose, version, proposals, triggers, route } = await setup(t);
	const v = await version(BASE);
	const first = await propose('snippets_add_snippet', { file_id: BASE, snippet: { trigger: ';first', replace: '1' }, version: v, index: 0 });
	const third = await propose('snippets_add_snippet', { file_id: BASE, snippet: { trigger: ';third', replace: '3' }, version: v, index: 3 });
	// The file gets shorter before the second card is applied.
	await route('DELETE', `/files/${encodeURIComponent(BASE)}/snippets/0`, { query: { version: v } });
	await route('DELETE', `/files/${encodeURIComponent(BASE)}/snippets/0`, { query: { version: await version(BASE) } });
	assert.equal((await proposals.apply(third.id)).status, 'applied');
	assert.equal((await proposals.apply(first.id)).status, 'applied');
	assert.deepEqual(await triggers(BASE), [';first', [';ty', ';thanks'], ';third']);
});

// --- still the same thing? -----------------------------------------------------------------

test('a change to a snippet that was edited after the card was made is not applied', async (t) => {
	const { propose, version, proposals, route, read } = await setup(t);
	const v = await version(BASE);
	const change = await propose('snippets_update_snippet', { file_id: BASE, index: 0, snippet: { trigger: ';hello', replace: 'Hi' }, version: v });
	const removal = await propose('snippets_delete_snippet', { file_id: BASE, index: 0, version: v });
	await route('PUT', `/files/${encodeURIComponent(BASE)}/snippets/0`, { body: { match: { trigger: ';hello', replace: 'Hello, edited by hand' }, version: v } });
	const after = read('base.yml');
	for (const card of [change, removal]) {
		const result = await proposals.apply(card.id);
		assert.deepEqual([result.status, result.message, result.code], ['stale', STALE, 'STALE'], card.kind);
	}
	assert.equal(read('base.yml'), after);
	// A stale card stays stale.
	assert.equal((await proposals.apply(change.id)).status, 'stale');
});

test('a change is still applied when something else in the file changed', async (t) => {
	const { propose, version, proposals, route, file } = await setup(t);
	const v = await version(BASE);
	const change = await propose('snippets_update_snippet', { file_id: BASE, index: 2, snippet: { triggers: [';ty', ';thanks'], replace: 'Thanks a lot!' }, version: v });
	// Someone adds a snippet at the top and edits another by hand.
	await route('POST', `/files/${encodeURIComponent(BASE)}/snippets`, { body: { match: { trigger: ';top', replace: 'Top' }, index: 0, version: v } });
	await route('PUT', `/files/${encodeURIComponent(BASE)}/snippets/1`, { body: { match: { trigger: ';hello', replace: 'Hello again' }, version: await version(BASE) } });
	assert.equal((await proposals.apply(change.id)).status, 'applied');
	const matches = (await file(BASE)).matches;
	assert.deepEqual(matches.map((match) => match.replace), ['Top', 'Hello again', 'Best,\n{{firstname}}', 'Thanks a lot!']);
});

test('twin snippets: the one at its own position is taken, and when that cannot be told apart nothing is applied', async (t) => {
	const twins = 'matches:\n  - trigger: ";a"\n    replace: "same"\n  - trigger: ";a"\n    replace: "same"\n  - trigger: ";b"\n    replace: "other"\n';
	const TWINS = 'local:twins.yml';
	{
		const { propose, version, proposals, triggers, matchDir } = await setup(t);
		writeFileSync(join(matchDir, 'twins.yml'), twins);
		const card = await propose('snippets_delete_snippet', { file_id: TWINS, index: 1, version: await version(TWINS) });
		assert.equal((await proposals.apply(card.id)).status, 'applied');
		assert.deepEqual(await triggers(TWINS), [';a', ';b']);
	}
	{
		const { propose, version, proposals, route, read, matchDir } = await setup(t);
		writeFileSync(join(matchDir, 'twins.yml'), twins);
		const v = await version(TWINS);
		const card = await propose('snippets_update_snippet', { file_id: TWINS, index: 0, snippet: { trigger: ';a', replace: 'changed' }, version: v });
		// A snippet is put in front, so position 0 is no longer one of the twins.
		await route('POST', `/files/${encodeURIComponent(TWINS)}/snippets`, { body: { match: { trigger: ';front', replace: 'front' }, index: 0, version: v } });
		const after = read('twins.yml');
		assert.deepEqual([(await proposals.apply(card.id)).status, read('twins.yml')], ['stale', after]);
	}
});

test('a file\'s text is replaced only if it is still the text the card was made from', async (t) => {
	const { propose, version, proposals, route, read } = await setup(t);
	const v = await version(BASE);
	const card = await propose('snippets_replace_file_yaml', { file_id: BASE, yaml: 'matches: []\n', version: v });
	await route('POST', `/files/${encodeURIComponent(BASE)}/snippets`, { body: { match: { trigger: ';late', replace: 'Late' }, version: v } });
	const after = read('base.yml');
	const result = await proposals.apply(card.id);
	assert.deepEqual([result.status, result.message], ['stale', STALE]);
	assert.equal(read('base.yml'), after);
});

test('a file that went away after the card was made is reported, and the card can be tried again', async (t) => {
	const { propose, version, proposals, route } = await setup(t);
	const v = await version('local:dates.yml');
	const card = await propose('snippets_add_snippet', { file_id: 'local:dates.yml', snippet: { trigger: ':x', replace: 'X' }, version: v });
	await route('DELETE', `/files/${encodeURIComponent('local:dates.yml')}`, { query: { version: v } });
	const result = await proposals.apply(card.id);
	assert.deepEqual([result.status, result.message, result.code], ['pending', 'dates.yml is no longer in the match folder.', 'NOT_FOUND']);
});

// --- the switch, twice, dismissed ----------------------------------------------------------

test('with the switch off a card is still made, Apply says why not, and it works once the switch is on', async (t) => {
	const { propose, version, proposals, read, service } = await setup(t, { aiWrite: false });
	const before = read('base.yml');
	const card = await propose('snippets_add_snippet', { file_id: BASE, snippet: { trigger: ';x', replace: 'X' }, version: await version(BASE) });
	const held = await proposals.apply(card.id);
	assert.deepEqual([held.status, held.code, held.message], ['pending', 'SWITCH_OFF', 'Changes by AI tools are switched off. Switch on "Let AI tools change snippets" in Settings, then press Apply again.']);
	assert.equal(read('base.yml'), before);
	await service.saveSettings({ aiWrite: true });
	const applied = await proposals.apply(card.id);
	assert.deepEqual([applied.status, applied.code, applied.message], ['applied', null, null]);
	assert.notEqual(read('base.yml'), before);
});

test('Apply pressed twice changes the file once', async (t) => {
	const { propose, version, proposals, triggers } = await setup(t);
	const card = await propose('snippets_add_snippet', { file_id: BASE, snippet: { trigger: ';x', replace: 'X' }, version: await version(BASE) });
	const [first, second] = await Promise.all([proposals.apply(card.id), proposals.apply(card.id)]);
	assert.deepEqual([first.status, second.status].sort(), ['applied', 'applying']);
	await proposals.apply(card.id);
	assert.deepEqual(await triggers(BASE), [';hello', ';sig', [';ty', ';thanks'], ';x']);
});

test('a dismissed card is not applied, and a card that is not there says so', async (t) => {
	const { propose, version, proposals, read } = await setup(t);
	const before = read('base.yml');
	const card = await propose('snippets_add_snippet', { file_id: BASE, snippet: { trigger: ';x', replace: 'X' }, version: await version(BASE) });
	assert.equal(proposals.dismiss(card.id).status, 'dismissed');
	assert.equal((await proposals.apply(card.id)).status, 'dismissed');
	assert.equal(read('base.yml'), before);
	await assert.rejects(proposals.apply('nothing'), (error) => error.code === 'NOT_FOUND' && error.message === 'That proposal is no longer here. Ask again.');
	assert.throws(() => proposals.dismiss('nothing'), (error) => error.code === 'NOT_FOUND');
	assert.equal(proposals.get('nothing'), null);
	// What was applied is not undone by dismissing it.
	const other = await propose('snippets_create_file', { name: 'kept.yml' });
	await proposals.apply(other.id);
	assert.equal(proposals.dismiss(other.id).status, 'applied');
});

test('only so many cards are kept: the oldest go first', async (t) => {
	const { propose, proposals } = await setup(t, { limit: 3 });
	const made = [];
	for (const name of ['a.yml', 'b.yml', 'c.yml', 'd.yml']) made.push(await propose('snippets_create_file', { name }));
	assert.deepEqual(proposals.all().map((card) => card.subject), ['b.yml', 'c.yml', 'd.yml']);
	assert.equal(proposals.get(made[0].id), null);
});

test('a fault inside the app is not described on the card: it is logged, and the card can be tried again', async (t) => {
	const api = await startApi(t, { enabled: false, aiWrite: true });
	const real = createRouter({ service: api.service, log: () => {} });
	let broken = false;
	const logged = [];
	const proposals = createProposals({
		router: async (request) => {
			if (broken && request.method === 'POST') throw new Error('ENOENT: /Users/someone/private/path');
			return real(request);
		},
		aiWrite: () => true,
		log: (error) => logged.push(error.message),
	});
	const version = (await real({ method: 'GET', path: `/api/v1/files/${encodeURIComponent(BASE)}` })).body.version;
	const made = await proposals.tools.call('snippets_add_snippet', { file_id: BASE, snippet: { trigger: ';x', replace: 'X' }, version });
	const id = made.structuredContent.proposal_id;
	broken = true;
	const held = await proposals.apply(id);
	assert.deepEqual([held.status, held.message, held.code], ['pending', 'Something went wrong inside the app.', 'ERROR']);
	assert.deepEqual(logged, ['ENOENT: /Users/someone/private/path']);
	broken = false;
	assert.equal((await proposals.apply(id)).status, 'applied');
});

// --- commands ------------------------------------------------------------------------------

test('a snippet that runs a command carries a warning, and Apply is the answer to it', async (t) => {
	const { propose, version, proposals, file, read } = await setup(t);
	const snippet = { trigger: ':ip', replace: '{{ip}}', vars: [{ name: 'ip', type: 'shell', params: { cmd: 'ipconfig getifaddr en0' } }] };
	const added = await propose('snippets_add_snippet', { file_id: BASE, snippet, version: await version(BASE) });
	assert.deepEqual(added.warnings, [COMMAND]);
	const changed = await propose('snippets_update_snippet', { file_id: BASE, index: 0, snippet: { ...snippet, trigger: ';hello' }, version: await version(BASE) });
	assert.deepEqual(changed.warnings, [COMMAND]);
	const text = `${read('base.yml')}\n  - trigger: ":s"\n    replace: "{{s}}"\n    vars:\n      - name: s\n        type: script\n        params:\n          args: [python3, x.py]\n`;
	const whole = await propose('snippets_replace_file_yaml', { file_id: BASE, yaml: text, version: await version(BASE) });
	assert.deepEqual(whole.warnings, ['This text holds a snippet that runs a command on your computer each time it is used.']);
	// A plain snippet carries none.
	assert.deepEqual((await propose('snippets_add_snippet', { file_id: BASE, snippet: { trigger: ';p', replace: 'plain' }, version: await version(BASE) })).warnings, []);

	assert.equal((await proposals.apply(added.id)).status, 'applied');
	assert.deepEqual((await file(BASE)).matches.at(-1), snippet);
});

test('text too long to check for commands, or to read on a card, is not made into a card', async (t) => {
	const { propose, version, cards } = await setup(t);
	const long = `matches:\n${Array.from({ length: 9000 }, (_, index) => `  - trigger: ":t${index}"\n    replace: "reply number ${index}"\n`).join('')}`;
	assert.ok(long.length > 256 * 1024);
	const result = await propose('snippets_replace_file_yaml', { file_id: BASE, yaml: long, version: await version(BASE) });
	assert.equal(result.error, 'That text is too long to show on a card (over 256 KB). Ask the person to make this change in the raw editor, or change the snippets one at a time.');
	assert.deepEqual(cards, []);
});

test('what a card was made from cannot be changed afterwards by whoever asked for it', async (t) => {
	const { proposals, version, file } = await setup(t);
	const args = { file_id: BASE, snippet: { trigger: ';x', replace: 'As shown on the card', vars: [] }, version: await version(BASE) };
	const made = await proposals.tools.call('snippets_add_snippet', args);
	// The caller still holds the object it passed in.
	args.snippet.replace = 'Swapped after the card was made';
	args.snippet.vars.push({ name: 'o', type: 'shell', params: { cmd: 'echo ran' } });
	args.file_id = 'local:dates.yml';
	assert.equal((await proposals.apply(made.structuredContent.proposal_id)).status, 'applied');
	assert.deepEqual((await file(BASE)).matches.at(-1), { trigger: ';x', replace: 'As shown on the card', vars: [] });
});

test('a trigger that is not text is refused when proposed, in words that say how to write it', async (t) => {
	const { propose, version, cards } = await setup(t);
	const v = await version(BASE);
	for (const snippet of [{ trigger: 123, replace: 'x' }, { triggers: [';a', 7], replace: 'x' }, { trigger: true, replace: 'x' }, { regex: 5, replace: 'x' }]) {
		const result = await propose('snippets_add_snippet', { file_id: BASE, snippet, version: v });
		assert.equal(result.error, 'Write each trigger as text, in quotes. Example: {"trigger": "123", "replace": "..."}.', JSON.stringify(snippet));
	}
	assert.equal((await propose('snippets_update_snippet', { file_id: BASE, index: 0, snippet: { trigger: 5, replace: 'x' }, version: v })).error, 'Write each trigger as text, in quotes. Example: {"trigger": "123", "replace": "..."}.');
	assert.deepEqual(cards, []);
});

test('a card made for one answer belongs to that answer, and one that comes after its answer ended is not made', async (t) => {
	const { proposals, version, cards } = await setup(t);
	const seen = [];
	const state = { open: true };
	const answer = proposals.forTurn({ turnId: 'turn-a', isOpen: () => state.open, onCard: (card, turnId) => seen.push([turnId, card.subject]) });
	const v = await version(BASE);
	const add = (trigger) => ({ file_id: BASE, snippet: { trigger, replace: 'x' }, version: v });

	// From Ollama (the tools, in the app) and from a command-line tool (through the listener).
	assert.equal((await answer.tools.call('snippets_add_snippet', add(';one'))).isError, false);
	assert.match((await answer.receive({ tool: 'snippets_add_snippet', args: add(';two') })).id, /^[a-f0-9]{12}$/);
	assert.deepEqual(seen, [['turn-a', ';one'], ['turn-a', ';two']]);

	// The answer has ended. A card still being worked out is dropped, whichever way it came.
	state.open = false;
	const late = await answer.tools.call('snippets_add_snippet', add(';late'));
	assert.deepEqual([late.isError, late.content[0].text], [true, 'This chat has ended. The person can send their message again.']);
	await assert.rejects(answer.receive({ tool: 'snippets_add_snippet', args: add(';later') }), (error) => error.code === 'REFUSED' && /^This chat has ended/.test(error.message));
	assert.equal(proposals.all().length, 2);
	assert.equal(seen.length, 2);
	// The general listener hears of cards too.
	assert.equal(cards.length, 2);
});

test('the tools the assistant is given cannot write, whatever they are asked to call', async (t) => {
	const api = await startApi(t, { enabled: false, aiWrite: true });
	const requests = [];
	const real = createRouter({ service: api.service, log: () => {} });
	const proposals = createProposals({
		router: async (request) => {
			requests.push(`${request.method} ${request.path}`);
			return real(request);
		},
		aiWrite: () => true,
	});
	const before = readFileSync(join(api.matchDir, 'base.yml'), 'utf8');
	// The app's routes as the assistant's tools reach them: reading only.
	const reach = proposals.reach;
	assert.equal((await reach.request('GET', '/state')).status, 200);
	for (const [method, path, body] of [
		['POST', '/files', { name: 'x.yml' }],
		['PUT', `/files/${encodeURIComponent(BASE)}/raw`, { text: 'matches: []\n', version: 'v' }],
		['DELETE', `/files/${encodeURIComponent(BASE)}/snippets/0`, undefined],
		['POST', '/team/refresh', {}],
		['POST', '/yaml/parse', { text: 'a: 1' }],
	]) {
		assert.deepEqual(await reach.request(method, path, { body }), { status: 405, body: { error: { code: 'METHOD_NOT_ALLOWED', message: 'In chat a change is a proposal. Nothing is written from here.' } } }, `${method} ${path}`);
	}
	assert.deepEqual(requests, ['GET /api/v1/state']);
	assert.equal(readFileSync(join(api.matchDir, 'base.yml'), 'utf8'), before);
});


// --- refused when proposed ------------------------------------------------------------------

test('what the app would refuse is refused when it is proposed, in words the model can act on', async (t) => {
	const { propose, version, cards, read } = await setup(t);
	const v = await version(BASE);
	const snippet = { trigger: ';x', replace: 'X' };
	const before = read('base.yml');
	const refused = [
		['snippets_add_snippet', { file_id: 'package:goodbyes:package.yml', snippet, version: 'v' }, /^package\.yml is read-only: it belongs to a package.*snippets_add_snippet/],
		['snippets_add_snippet', { file_id: BASE, snippet, version: 'old' }, /^base\.yml changed since you read it\. Call snippets_get_file for local:base\.yml again/],
		['snippets_add_snippet', { file_id: 'local:none.yml', snippet, version: 'v' }, /none\.yml.*snippets_list_files/],
		['snippets_add_snippet', { file_id: 'nonsense', snippet, version: 'v' }, /^That is not a file id\. Call snippets_list_files/],
		['snippets_add_snippet', { file_id: BASE, snippet: { replace: 'no trigger' }, version: v }, /^`snippet` needs a `trigger`/],
		['snippets_add_snippet', { file_id: 'local:broken.yml', snippet, version: 'v' }, /^broken\.yml has YAML errors.*detail "raw"/],
		['snippets_update_snippet', { file_id: BASE, index: 3, snippet, version: v }, /^base\.yml has 3 snippets, at positions 0 to 2\. Call snippets_get_file to see them\.$/],
		['snippets_delete_snippet', { file_id: BASE, index: 9, version: v }, /^base\.yml has 3 snippets, at positions 0 to 2/],
		['snippets_delete_snippet', { file_id: BASE, index: 0, version: 'old' }, /changed since you read it/],
		['snippets_replace_file_yaml', { file_id: BASE, yaml: 'matches:\n  - trigger: "x\n', version: v }, /^That YAML has errors, so nothing was saved: /],
		['snippets_replace_file_yaml', { file_id: BASE, yaml: 'matches: []\n', version: 'old' }, /changed since you read it/],
		['snippets_create_file', { name: 'base.yml' }, /^A file named base\.yml already exists\. Choose another name, or change the existing file\.$/],
		['snippets_create_file', { name: 'BASE.yml' }, /^A file named base\.yml already exists/],
		['snippets_create_file', { name: '../up.yml' }, /^Use a file name ending in \.yml, without slashes or a leading dot\.$/],
		['snippets_create_file', { name: 'notes.txt' }, /^Use a file name ending in \.yml/],
		['snippets_install_team_package', { name: 'goodbyes' }, /^No team repository is connected\. Ask the person to connect one in the app, under Settings\.$/],
		['snippets_propose_to_team', { file_id: BASE, package: 'goodbyes', summary: 'Share' }, /^No team repository is connected/],
	];
	for (const [tool, args, pattern] of refused) {
		const result = await propose(tool, args);
		assert.match(result.error ?? `a card: ${JSON.stringify(result)}`, pattern, `${tool} ${JSON.stringify(args).slice(0, 80)}`);
	}
	assert.deepEqual(cards, []);
	assert.equal(read('base.yml'), before);
});

test('a snippet nested too deeply to write is refused when it is proposed', async (t) => {
	const { propose, version } = await setup(t);
	let deep = 'x';
	for (let level = 0; level < 6000; level += 1) deep = [deep];
	const result = await propose('snippets_add_snippet', { file_id: BASE, snippet: { trigger: ';deep', replace: 'x', deep }, version: await version(BASE) });
	assert.equal(result.error, 'That value is nested too deeply to write as YAML.');
});

test('what comes in from a command-line tool is checked like any tool call, and only a change is a proposal', async (t) => {
	const { proposals, version, cards } = await setup(t);
	const refused = (promise, pattern) => assert.rejects(promise, (error) => error.code === 'REFUSED' && pattern.test(error.message));
	await refused(proposals.receive({ tool: 'snippets_search', args: { query: 'hello' } }), /^snippets_search does not change anything, so it is not a proposal\.$/);
	await refused(proposals.receive({ tool: 'rm_rf', args: {} }), /^There is no tool named rm_rf\.$/);
	await refused(proposals.receive({ tool: 'snippets_add_snippet', args: { file_id: BASE, snippet: { trigger: ';x', replace: 'X' } } }), /^Missing `version`/);
	await refused(proposals.receive({ tool: 'snippets_add_snippet', args: { file_id: BASE, snippet: { trigger: ';x', replace: 'X' }, version: 'v', accept_commands: true } }), /^Unknown input `accept_commands`/);
	await refused(proposals.receive({ tool: 'snippets_add_snippet', args: { file_id: BASE, snippet: { trigger: ';x', replace: 'X' }, version: 'old' } }), /changed since you read it/);
	assert.deepEqual(cards, []);
	const { id } = await proposals.receive({ tool: 'snippets_add_snippet', args: { file_id: BASE, snippet: { trigger: ';x', replace: 'X' }, version: await version(BASE) } });
	assert.deepEqual(cards.map((card) => card.id), [id]);
});

// --- team ----------------------------------------------------------------------------------

async function team(t, options = {}) {
	const remote = seeded();
	remote.commit({
		'packages/tools/_manifest.yml': MANIFEST('tools'),
		'packages/tools/package.yml': 'matches:\n  - trigger: ":ip"\n    replace: "{{ip}}"\n    vars:\n      - name: ip\n        type: shell\n        params:\n          cmd: "ipconfig getifaddr en0"\n',
	});
	const context = await setup(t, { ...options, serviceOptions: { git: createGit({ allowLocal: true, env: gitEnv(remote.root) }), allowLocalRepositories: true } });
	await context.service.connectTeam(remote.url);
	return { ...context, remote };
}

const idOf = (remote) => parseRepositoryAddress(remote.url, { allowLocal: true }).id;
const proposalsIn = (remote) => remote.branches().filter((branch) => branch.startsWith('snippet-editor/'));
// How the app lists a repository when more than one could be meant. A test's
// repository is a folder, which has no owner, so its address stands in.
const listedAs = (remote) => `${remote.url} (${idOf(remote)})`;
const WHICH = 'Say which: set `repository` to one of the ids in brackets. If the person has not said which one, ask them.';
const NOT_CONNECTED = 'That repository is not connected. Call snippets_list_team_packages to see the connected repositories, their ids and what each offers.';
const TAKEN = (name, from) => `A package named ${name} is already installed from ${from}. Remove it first, then install this one.`;

// A second repository beside the one `team` connects. It offers `goodbyes`
// too, with other text, and `shipping`, which the first does not have.
async function teams(t, options = {}) {
	const context = await team(t, options);
	const second = createRemote();
	second.commit({
		'packages/goodbyes/_manifest.yml': MANIFEST('goodbyes', { title: 'Other goodbyes' }),
		'packages/goodbyes/package.yml': MATCHES([':later', 'See you later']),
		'packages/shipping/_manifest.yml': MANIFEST('shipping'),
		'packages/shipping/package.yml': MATCHES([':sent', 'Your parcel is on its way.']),
	});
	await context.service.connectTeam(second.url);
	return { ...context, first: context.remote, second, one: idOf(context.remote), two: idOf(second) };
}

test('installing a team package is a card, with a warning when the package runs commands', async (t) => {
	const { propose, proposals, matchDir, remote } = await team(t);
	const plain = await propose('snippets_install_team_package', { name: 'support' });
	assert.deepEqual(
		[plain.kind, plain.title, plain.subject, plain.lines, plain.warnings, plain.before, plain.after, plain.fileId],
		['install', 'Install the team package support', 'support', [`Repository: ${remote.url}`, 'Support replies', 'The support package', '4 snippets'], [], null, null, null]
	);
	// Named, the one connected repository gives the same card.
	const named = await propose('snippets_install_team_package', { name: 'support', repository: idOf(remote) });
	assert.deepEqual({ ...named, id: plain.id }, plain);
	const tools = await propose('snippets_install_team_package', { name: 'tools' });
	assert.deepEqual([tools.lines, tools.warnings], [[`Repository: ${remote.url}`, 'Tools', 'The tools package', '1 snippet'], ['This package runs commands on your computer when its snippets are used.']]);
	assert.equal((await propose('snippets_install_team_package', { name: 'support', repository: 'nothing' })).error, NOT_CONNECTED);
	assert.match((await propose('snippets_install_team_package', { name: 'nothing' })).error, /no package named nothing.*snippets_list_team_packages/s);

	assert.equal(existsSync(join(matchDir, 'team', 'support')), false);
	assert.equal((await proposals.apply(plain.id)).status, 'applied');
	assert.ok(readFileSync(join(matchDir, 'team', 'support', 'replies.yml'), 'utf8').includes(':refund'));
	assert.equal((await proposals.apply(tools.id)).status, 'applied');
	assert.ok(existsSync(join(matchDir, 'team', 'tools', 'package.yml')));

	// Installed already: the card says it is an update.
	assert.equal((await propose('snippets_install_team_package', { name: 'support' })).title, 'Update the team package support');
});

test('installing a package that runs no commands does not say that commands were agreed to', async (t) => {
	const remote = seeded();
	const api = await startApi(t, { enabled: false, aiWrite: true, serviceOptions: { git: createGit({ allowLocal: true, env: gitEnv(remote.root) }), allowLocalRepositories: true } });
	await api.service.connectTeam(remote.url);
	const real = createRouter({ service: api.service, log: () => {} });
	const installs = [];
	const proposals = createProposals({
		router: async (request) => {
			if (request.method === 'PUT' && request.path.includes('/team/packages/')) installs.push(request.body);
			return real(request);
		},
		aiWrite: () => true,
	});
	const made = await proposals.tools.call('snippets_install_team_package', { name: 'goodbyes' });
	assert.equal((await proposals.apply(made.structuredContent.proposal_id)).status, 'applied');
	// From the repository the card named, by its id.
	assert.deepEqual(installs, [{ repository: idOf(remote), acceptCommands: false }]);
});

test('a file is sent to the repository its card named, and with a title only if the card showed one', async (t) => {
	const { propose, proposals, remote, service, router } = await team(t);
	const sent = [];
	const watching = createProposals({
		router: async (request) => {
			if (request.method === 'POST' && request.path.endsWith('/team/proposals')) sent.push(request.body);
			return router(request);
		},
		aiWrite: () => true,
	});
	// The model adds a title and a description the card will not show, since the package exists.
	const made = await watching.tools.call('snippets_propose_to_team', { file_id: 'local:dates.yml', package: 'goodbyes', summary: 'Share', title: 'Hidden title', description: 'Hidden description' });
	const card = watching.get(made.structuredContent.proposal_id);
	assert.ok(!card.lines.join(' ').includes('Hidden'));
	assert.equal((await watching.apply(card.id)).status, 'applied');
	// To the repository the card named, by its id.
	assert.deepEqual(sent, [{ fileId: 'local:dates.yml', package: 'goodbyes', summary: 'Share', repository: idOf(remote) }]);

	// Another repository connected after the card was made: the card names its own, and still goes there.
	const waiting = await propose('snippets_propose_to_team', { file_id: 'local:base.yml', package: 'goodbyes', summary: 'Share again' });
	const other = seeded();
	await service.connectTeam(other.url);
	const result = await proposals.apply(waiting.id);
	assert.deepEqual([result.status, result.code], ['applied', null]);
	assert.deepEqual([proposalsIn(other), proposalsIn(remote).length], [[], 2]);
});

test('a send card is stale once its own repository is disconnected, whatever else is connected', async (t) => {
	const { propose, proposals, remote, service } = await team(t);
	const other = seeded();
	const args = { file_id: 'local:dates.yml', package: 'goodbyes', summary: 'Share' };
	const card = await propose('snippets_propose_to_team', args);
	const kept = await propose('snippets_propose_to_team', { ...args, summary: 'Share later' });

	// The other repository has a package of that name too. The card is not for it.
	await service.connectTeam(other.url);
	await service.disconnectTeam(idOf(remote));
	const result = await proposals.apply(card.id);
	assert.deepEqual([result.status, result.message, result.code], ['stale', STALE, 'STALE']);
	assert.deepEqual([proposalsIn(other), proposalsIn(remote)], [[], []]);

	// With none connected at all, the same.
	await service.disconnectTeam(idOf(other));
	assert.equal((await proposals.apply(kept.id)).status, 'stale');
	assert.deepEqual([proposalsIn(other), proposalsIn(remote)], [[], []]);
});

test('with several repositories, a send card is made once the call says which, and names it', async (t) => {
	const { propose, proposals, first, second, two, cards } = await teams(t);
	const args = { file_id: 'local:dates.yml', package: 'shipping', summary: 'Share the date snippets' };
	assert.equal((await propose('snippets_propose_to_team', args)).error, `Two repositories are connected: ${listedAs(first)} and ${listedAs(second)}. ${WHICH}`);
	assert.equal((await propose('snippets_propose_to_team', { ...args, repository: 'nothing' })).error, NOT_CONNECTED);
	assert.deepEqual(cards, []);

	const card = await propose('snippets_propose_to_team', { ...args, repository: two });
	assert.deepEqual(card.lines, [`Repository: ${second.url}`, 'Package: shipping', 'Summary: Share the date snippets']);
	// Each repository has its own names: shipping would be a new package in the first.
	assert.match((await propose('snippets_propose_to_team', { ...args, repository: idOf(first) })).error, /^A new package needs a `title`/);
	const sent = await proposals.apply(card.id);
	assert.equal(sent.status, 'applied');
	assert.deepEqual([proposalsIn(second).length, proposalsIn(first)], [1, []]);
});

test('with several repositories, an install card is made for the one that offers the name, or the one the call names', async (t) => {
	const { propose, proposals, first, second, one, two, matchDir, route, cards, service } = await teams(t);
	// Offered by one of them: that one, without being asked.
	const shipping = await propose('snippets_install_team_package', { name: 'shipping' });
	assert.deepEqual([shipping.title, shipping.lines], ['Install the team package shipping', [`Repository: ${second.url}`, 'Shipping', 'The shipping package', '1 snippet']]);
	// Offered by both: which one has to be said, and the card then names it.
	assert.equal((await propose('snippets_install_team_package', { name: 'goodbyes' })).error, `Two repositories offer goodbyes: ${listedAs(first)} and ${listedAs(second)}. ${WHICH}`);
	assert.equal((await propose('snippets_install_team_package', { name: 'goodbyes', repository: 'nothing' })).error, NOT_CONNECTED);
	assert.match((await propose('snippets_install_team_package', { name: 'shipping', repository: one })).error, /^The team repository has no package named shipping\..*snippets_list_team_packages/);
	assert.match((await propose('snippets_install_team_package', { name: 'nothing' })).error, /^No connected repository has a package named nothing\..*snippets_list_team_packages/);
	assert.deepEqual(cards.map((card) => card.id), [shipping.id]);

	const theirs = await propose('snippets_install_team_package', { name: 'goodbyes', repository: two });
	assert.deepEqual([theirs.title, theirs.lines], ['Install the team package goodbyes', [`Repository: ${second.url}`, 'Other goodbyes', 'The goodbyes package', '1 snippet']]);
	const mine = await propose('snippets_install_team_package', { name: 'goodbyes', repository: one });
	assert.deepEqual(mine.lines, [`Repository: ${first.url}`, 'Goodbyes', 'The goodbyes package', '2 snippets']);

	assert.equal((await proposals.apply(theirs.id)).status, 'applied');
	assert.equal(readFileSync(join(matchDir, 'team', 'goodbyes', 'package.yml'), 'utf8'), MATCHES([':later', 'See you later']));
	assert.equal((await proposals.apply(shipping.id)).status, 'applied');

	// The name was taken after the other card was made: the app's own refusal is on the card, and nothing is replaced.
	const held = await proposals.apply(mine.id);
	assert.deepEqual([held.status, held.message, held.code], ['pending', TAKEN('goodbyes', second.url), 'EXISTS']);
	assert.equal(readFileSync(join(matchDir, 'team', 'goodbyes', 'package.yml'), 'utf8'), MATCHES([':later', 'See you later']));
	// Proposed now, it is refused at once, with what has to happen first.
	assert.equal(
		(await propose('snippets_install_team_package', { name: 'goodbyes', repository: one })).error,
		`${TAKEN('goodbyes', second.url)} These tools cannot remove a team package. Tell the person which repository holds the name, and that removing it comes first: they do that in the app, on the Team packages page.`
	);
	// From its own repository it is an update.
	assert.equal((await propose('snippets_install_team_package', { name: 'goodbyes', repository: two })).title, 'Update the team package goodbyes');
	// With no repository named it is the holder's too, though both offer the
	// name: no other repository could install it. The card says whose it is.
	second.commit({ 'packages/goodbyes/package.yml': MATCHES([':later', 'See you much later']) });
	await service.refreshTeam(two);
	const update = await propose('snippets_install_team_package', { name: 'goodbyes' });
	assert.deepEqual([update.title, update.lines], ['Update the team package goodbyes', [`Repository: ${second.url}`, 'Other goodbyes', 'The goodbyes package', '1 snippet']]);
	assert.equal((await proposals.apply(update.id)).status, 'applied');
	assert.equal(readFileSync(join(matchDir, 'team', 'goodbyes', 'package.yml'), 'utf8'), MATCHES([':later', 'See you much later']));
	// A marker that names no repository is nobody's: both show the package as
	// installed, neither holds it, and which one has to be said.
	const marker = join(matchDir, 'team', 'goodbyes', '.snippet-editor.json');
	const written = readFileSync(marker, 'utf8');
	writeFileSync(marker, '{ not json');
	assert.equal((await propose('snippets_install_team_package', { name: 'goodbyes' })).error, `Two repositories offer goodbyes: ${listedAs(first)} and ${listedAs(second)}. ${WHICH}`);
	writeFileSync(marker, written);
	assert.equal((await propose('snippets_install_team_package', { name: 'goodbyes' })).lines[0], `Repository: ${second.url}`);

	// Once the person has removed it, the name is free: which one has to be
	// said again, and the card that was held back applies.
	await route('DELETE', '/team/packages/goodbyes/installed');
	assert.equal((await propose('snippets_install_team_package', { name: 'goodbyes' })).error, `Two repositories offer goodbyes: ${listedAs(first)} and ${listedAs(second)}. ${WHICH}`);
	assert.equal((await proposals.apply(mine.id)).status, 'applied');
	assert.equal(readFileSync(join(matchDir, 'team', 'goodbyes', 'package.yml'), 'utf8'), MATCHES([':bye', 'Goodbye for now'], [':cheers', 'Cheers,']));
});

test('an install card whose repository was disconnected, or dropped the package, is stale, and nothing is installed from another', async (t) => {
	const { propose, proposals, second, two, service, matchDir } = await teams(t);
	const goodbyes = await propose('snippets_install_team_package', { name: 'goodbyes', repository: two });
	const shipping = await propose('snippets_install_team_package', { name: 'shipping' });
	const later = await propose('snippets_install_team_package', { name: 'shipping', repository: two });

	// The second repository drops shipping. Nobody else offers it.
	second.commit({ 'packages/shipping/_manifest.yml': null, 'packages/shipping/package.yml': null });
	await service.refreshTeam(two);
	const dropped = await proposals.apply(shipping.id);
	assert.deepEqual([dropped.status, dropped.message, dropped.code], ['stale', STALE, 'STALE']);
	assert.equal(existsSync(join(matchDir, 'team', 'shipping')), false);

	// The second repository is disconnected. The first still offers goodbyes, and the card is not for the first.
	await service.disconnectTeam(two);
	const gone = await proposals.apply(goodbyes.id);
	assert.deepEqual([gone.status, gone.message, gone.code], ['stale', STALE, 'STALE']);
	assert.equal((await proposals.apply(later.id)).status, 'stale');
	assert.equal(existsSync(join(matchDir, 'team')), false);
});

test('a card names a repository on GitHub by its owner and name', async (t) => {
	// The app as it runs, where no folder is an address. Git alone is pointed
	// at a test repository when it is asked for one of the two GitHub addresses.
	const [first, second] = [seeded(), seeded()];
	const [one, two] = [parseRepositoryAddress('acme/team-snippets'), parseRepositoryAddress('git@github.com:Other-Org/snippets.git')];
	const where = new Map([[one.url, first.url], [two.url, second.url]]);
	const real = createGit({ allowLocal: true, env: gitEnv(first.root) });
	const git = (args, options) => {
		const stray = args.find((arg) => /^(https?:|ssh:|git@)/.test(arg) && !where.has(arg));
		if (stray) return Promise.reject(new Error(`This test has no repository for ${stray}.`));
		return real(args.map((arg) => where.get(arg) ?? arg), options);
	};
	git.stopAll = () => real.stopAll();
	const { propose, service, proposals, route } = await setup(t, { serviceOptions: { git } });
	await service.connectTeam('acme/team-snippets');

	const card = await propose('snippets_install_team_package', { name: 'support' });
	assert.deepEqual(card.lines, ['Repository: acme/team-snippets', 'Support replies', 'The support package', '4 snippets']);
	// Where a file is sent is shown in full, as it always was.
	const send = await propose('snippets_propose_to_team', { file_id: 'local:dates.yml', package: 'goodbyes', summary: 'Share' });
	assert.equal(send.lines[0], 'Repository: https://github.com/acme/team-snippets.git');

	await service.connectTeam('git@github.com:Other-Org/snippets.git');
	assert.equal((await propose('snippets_install_team_package', { name: 'support' })).error, `Two repositories offer support: acme/team-snippets (${one.id}) and Other-Org/snippets (${two.id}). ${WHICH}`);
	assert.equal((await propose('snippets_install_team_package', { name: 'support', repository: two.id })).lines[0], 'Repository: Other-Org/snippets');
	assert.equal((await proposals.apply(card.id)).status, 'applied');
	assert.equal((await propose('snippets_install_team_package', { name: 'support', repository: two.id })).error, `${TAKEN('support', 'acme/team-snippets')} These tools cannot remove a team package. Tell the person which repository holds the name, and that removing it comes first: they do that in the app, on the Team packages page.`);
	// The link a sent card keeps is one the window may open: it is inside its own repository's pages.
	const sent = await proposals.apply(send.id);
	assert.match(sent.link, /^https:\/\/github\.com\/acme\/team-snippets\/compare\/main\.\.\.snippet-editor\/goodbyes-\d{8}-\d{6}\?expand=1$/);
	assert.equal((await route('GET', '/team')).repositories.length, 2);
});

test('a package that started to run commands after its card was made is not installed', async (t) => {
	const { propose, proposals, remote, matchDir, route } = await team(t);
	const card = await propose('snippets_install_team_package', { name: 'goodbyes' });
	assert.deepEqual(card.warnings, []);
	remote.commit({ 'packages/goodbyes/package.yml': 'matches:\n  - trigger: ":bye"\n    replace: "{{x}}"\n    vars:\n      - name: x\n        type: shell\n        params:\n          cmd: "whoami"\n' });
	await route('POST', '/team/refresh');
	const result = await proposals.apply(card.id);
	assert.deepEqual([result.status, result.message], ['stale', STALE]);
	assert.equal(existsSync(join(matchDir, 'team', 'goodbyes')), false);
});

test('sending a file to the team is a card that says it leaves the computer, and Apply pushes the branch', async (t) => {
	const { propose, proposals, remote, read } = await team(t);
	const card = await propose('snippets_propose_to_team', { file_id: 'local:dates.yml', package: 'goodbyes', summary: 'Share the date snippets' });
	assert.deepEqual(
		[card.kind, card.title, card.subject, card.fileId, card.before, card.after, card.lines, card.warnings],
		[
			'send',
			'Send dates.yml to the team',
			'dates.yml',
			'local:dates.yml',
			null,
			read('dates.yml'),
			[`Repository: ${remote.url}`, 'Package: goodbyes', 'Summary: Share the date snippets'],
			['This leaves your computer. Everyone who can read the repository will be able to read every snippet in this file.'],
		]
	);
	assert.deepEqual(remote.branches().filter((branch) => branch.startsWith('snippet-editor/')), []);
	const sent = await proposals.apply(card.id);
	assert.equal(sent.status, 'applied');
	assert.match(sent.message, /^Sent as the branch snippet-editor\/goodbyes-\d{8}-\d{6}\. A person on the team opens the pull request on the repository's site\.$/);
	assert.equal(sent.link, null);
	assert.equal(remote.branches().filter((branch) => branch.startsWith('snippet-editor/')).length, 1);

	const fresh = await propose('snippets_propose_to_team', { file_id: 'local:dates.yml', package: 'brand-new', summary: 'A new package', title: 'Brand new', description: 'Made in chat' });
	assert.deepEqual(fresh.lines, [`Repository: ${remote.url}`, 'Package: brand-new (new)', 'Title: Brand new', 'Description: Made in chat', 'Summary: A new package']);
});

test('a send is refused when proposed if the app would refuse it, and held back if the file changed', async (t) => {
	const { propose, proposals, remote, route, version } = await team(t);
	const D = 'local:dates.yml';
	for (const [args, pattern] of [
		[{ file_id: 'package:goodbyes:package.yml', package: 'goodbyes', summary: 'x' }, /^Only one of the person's own files can be proposed/],
		[{ file_id: 'local:broken.yml', package: 'goodbyes', summary: 'x' }, /^broken\.yml has YAML errors/],
		[{ file_id: D, package: 'Bad Name', summary: 'x' }, /^A package name is lowercase letters, digits and dashes, 80 characters or fewer\.$/],
		[{ file_id: D, package: 'goodbyes', summary: 'two\nlines' }, /^Write a one-line summary, 100 characters or fewer\.$/],
		[{ file_id: D, package: 'brand-new', summary: 'x' }, /^A new package needs a `title`/],
		[{ file_id: D, package: 'brand-new', summary: 'x', title: 'T' }, /^A new package needs a `description` of 3 to 1000 characters\.$/],
	]) {
		assert.match((await propose('snippets_propose_to_team', args)).error ?? 'a card', pattern, JSON.stringify(args));
	}

	const card = await propose('snippets_propose_to_team', { file_id: D, package: 'goodbyes', summary: 'Share' });
	await route('POST', `/files/${encodeURIComponent(D)}/snippets`, { body: { match: { trigger: ':late', replace: 'Late' }, version: await version(D) } });
	assert.deepEqual([(await proposals.apply(card.id)).status, remote.branches().filter((branch) => branch.startsWith('snippet-editor/')).length], ['stale', 0]);

	// The push is refused: the card says so and can be tried again.
	const again = await propose('snippets_propose_to_team', { file_id: D, package: 'goodbyes', summary: 'Share' });
	remote.refuseProposals();
	const held = await proposals.apply(again.id);
	assert.deepEqual([held.status, held.message, held.code], ['pending', 'You do not have permission to push to this repository.', 'GIT_FAILED']);
});

// --- the app's routes, called inside the app ------------------------------------------------

test('inside the app, the routes answer exactly as they do over HTTP, odd files and all', async (t) => {
	const api = await startApi(t, { enabled: true });
	writeFileSync(join(api.matchDir, 'odd.yml'), 'matches:\n  - trigger: ":odd"\n    replace: "x"\n    weight: .inf\n');
	const inside = createInProcessApi({ router: createRouter({ service: api.service, log: () => {} }), aiWrite: () => api.service.settings().aiWrite });
	const outside = createApiClient({ dataDir: api.dataDir });
	for (const [method, path, options] of [
		['GET', '/state', {}],
		['GET', '/search', { query: { q: 'hello', limit: 5 } }],
		['GET', '/search', { query: { q: 'odd', limit: undefined } }],
		['GET', `/files/${encodeURIComponent('local:odd.yml')}`, {}],
		['GET', `/files/${encodeURIComponent('local:none.yml')}`, {}],
		['GET', '/team', {}],
		['POST', '/yaml/parse', { body: { text: 'a: .nan' } }],
		['POST', '/yaml/preview', { body: { match: { trigger: ';x', replace: 'X', gone: undefined } } }],
		['PATCH', '/state', {}],
	]) {
		assert.deepEqual(await inside.request(method, path, options), await outside.request(method, path, options), `${method} ${path}`);
	}
	assert.deepEqual(await inside.settings(), { apiEnabled: true, apiPort: null, aiWrite: false });
	await api.service.saveSettings({ aiWrite: true });
	assert.equal((await inside.settings()).aiWrite, true);
});
