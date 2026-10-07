import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRouter } from '../core/apiRouter.js';
import { createLookups } from '../core/chat/lookups.js';
import { createProposals } from '../core/chat/proposals.js';
import { startApi } from './helpers/apiFixture.js';

// What the app looks up for the assistant before it is asked: the closest
// matches to the message, the open snippet and the open file.

async function setup(t, { most, wrap = (tools) => tools, store } = {}) {
	const api = await startApi(t, { enabled: false });
	const router = createRouter({ service: api.service, log: () => {} });
	const tools = createProposals({ router, aiWrite: () => false }).tools;
	const logged = [];
	const lookUp = createLookups({ store: store ?? api.service.store, tools: wrap(tools), log: (error) => logged.push(error), ...(most ? { most } : {}) });
	const call = async (name, args) => (await tools.call(name, args)).structuredContent;
	return { ...api, tools, lookUp, logged, call };
}

const BASE = { fileId: 'local:base.yml', fileName: 'base.yml' };
const kinds = (result) => result.lookups.map((item) => item.tool);

test('a find with nothing open looks up the closest matches, and nothing else', async (t) => {
	const { lookUp } = await setup(t);
	const result = await lookUp({ text: 'Find my snippet for saying thanks', context: null });
	assert.deepEqual(kinds(result), ['snippets_search']);
	assert.deepEqual(result.lookups[0], {
		tool: 'snippets_search',
		words: ['thanks'],
		result: {
			items: [
				{ file_id: 'local:base.yml', file: 'base.yml', source: 'local', index: 2, triggers: [';ty', ';thanks'], label: '', preview: 'Thank you!' },
				{ file_id: 'package:goodbyes:package.yml', file: 'package.yml', source: 'package', package: 'goodbyes', index: 0, triggers: [':bye'], label: 'Friendly goodbye', preview: 'Thanks for reaching out. Have a great day!' },
			],
		},
	});
	assert.deepEqual(result.found, [
		{ fileId: 'local:base.yml', fileName: 'base.yml', source: 'local', index: 2, triggers: [';ty', ';thanks'], label: '', preview: 'Thank you!' },
		{ fileId: 'package:goodbyes:package.yml', fileName: 'package.yml', source: 'package', package: 'goodbyes', index: 0, triggers: [':bye'], label: 'Friendly goodbye', preview: 'Thanks for reaching out. Have a great day!' },
	]);
});

test('with a file open, its summary and version come too, exactly as the tool gives them', async (t) => {
	const { lookUp, call } = await setup(t);
	const result = await lookUp({ text: 'Find my snippet for saying thanks', context: BASE });
	assert.deepEqual(kinds(result), ['snippets_search', 'snippets_get_file']);
	const file = result.lookups[1];
	assert.deepEqual(file.args, { file_id: 'local:base.yml', limit: 25 });
	assert.deepEqual(file.result, await call('snippets_get_file', { file_id: 'local:base.yml', limit: 25 }));
	assert.match(file.result.version, /^[a-f0-9]{24}$/);
	assert.equal(file.result.snippets.length, 3);
});

test('with a snippet open, that snippet comes whole and first', async (t) => {
	const { lookUp, call } = await setup(t);
	const result = await lookUp({ text: 'Make it friendlier', context: { ...BASE, index: 1, trigger: ';sig' } });
	assert.deepEqual(kinds(result), ['snippets_get_snippet', 'snippets_get_file']);
	assert.deepEqual(result.lookups[0], { tool: 'snippets_get_snippet', args: { file_id: 'local:base.yml', index: 1 }, result: await call('snippets_get_snippet', { file_id: 'local:base.yml', index: 1 }) });
	assert.equal(result.lookups[0].result.snippet.label, 'Signature');
	assert.deepEqual(result.found, []);
});

test('a message with no word worth searching for makes no search, and reads no folder', async (t) => {
	let reads = 0;
	const { lookUp } = await setup(t, { store: { likely: async () => ((reads += 1), []) } });
	assert.deepEqual(await lookUp({ text: 'Please find the snippet', context: null }), { found: [], lookups: [] });
	assert.deepEqual(await lookUp({ text: '', context: null }), { found: [], lookups: [] });
	assert.deepEqual(await lookUp({ text: undefined, context: undefined }), { found: [], lookups: [] });
	assert.equal(reads, 0);
});

test('when nothing matches, there is no search lookup and no match to show', async (t) => {
	const { lookUp } = await setup(t);
	assert.deepEqual(await lookUp({ text: 'Find the zebra crossing rota', context: null }), { found: [], lookups: [] });
});

test('a folder that cannot be searched is logged, and the rest still comes', async (t) => {
	const { lookUp, logged } = await setup(t, {
		store: {
			likely: async () => {
				throw new Error('the disk is gone');
			},
		},
	});
	const result = await lookUp({ text: 'Find my thanks', context: BASE });
	assert.deepEqual(kinds(result), ['snippets_get_file']);
	assert.deepEqual(result.found, []);
	assert.deepEqual(logged.map((error) => error.message), ['the disk is gone']);
});

test('a tool that throws is logged and left out', async (t) => {
	const { lookUp, logged } = await setup(t, {
		wrap: (tools) => ({
			call: async (name, args) => {
				if (name === 'snippets_get_file') throw new Error('unexpected');
				return tools.call(name, args);
			},
		}),
	});
	const result = await lookUp({ text: 'Find my thanks', context: { ...BASE, index: 0 } });
	assert.deepEqual(kinds(result), ['snippets_get_snippet', 'snippets_search']);
	assert.deepEqual(logged.map((error) => error.message), ['unexpected']);
});

test('an open file that is gone, has YAML errors or cannot be read is left out', async (t) => {
	const { lookUp, matchDir, logged } = await setup(t);
	// It has errors: the tool says so in `problem`, which is no use up front.
	assert.deepEqual(kinds(await lookUp({ text: 'hm', context: { fileId: 'local:broken.yml', fileName: 'broken.yml' } })), []);
	assert.deepEqual(kinds(await lookUp({ text: 'hm', context: { fileId: 'local:broken.yml', fileName: 'broken.yml', index: 0 } })), []);
	rmSync(join(matchDir, 'base.yml'));
	assert.deepEqual(kinds(await lookUp({ text: 'hm', context: { ...BASE, index: 1 } })), []);
	assert.deepEqual(logged, []);
});

test('what the window says is open is trusted for nothing', async (t) => {
	const asked = [];
	const { lookUp, logged } = await setup(t, {
		wrap: (tools) => ({
			call: (name, args) => {
				asked.push(name);
				return tools.call(name, args);
			},
		}),
	});
	for (const context of [
		{ fileId: 'local:nothing.yml', fileName: 'nothing.yml' },
		{ fileId: '../../etc/passwd', fileName: 'passwd' },
		{ fileId: 42, fileName: 'base.yml' },
		{ fileId: '', fileName: '' },
		{ fileId: ['local:base.yml'] },
		'local:base.yml',
		[],
		7,
	]) {
		assert.deepEqual(await lookUp({ text: 'hm', context }), { found: [], lookups: [] }, JSON.stringify(context));
	}
	// What is not even the name of a file is not put to the tools at all.
	asked.length = 0;
	for (const context of [{ fileId: 42, fileName: 'base.yml' }, { fileId: '', fileName: '' }, { fileId: ['local:base.yml'] }, 'local:base.yml', [], 7, null]) await lookUp({ text: 'hm', context });
	assert.deepEqual(asked, []);
	// A position that is no position: the file is still read, the snippet is not.
	for (const index of [-1, 1.5, '2', 99, null, Number.NaN]) {
		asked.length = 0;
		assert.deepEqual(kinds(await lookUp({ text: 'hm', context: { ...BASE, index } })), ['snippets_get_file'], String(index));
		// Nor is what is not a position: only the file is asked for.
		if (index !== 99) assert.deepEqual(asked, ['snippets_get_file'], String(index));
	}
	// A file that belongs to a package may be read, as the tools may read it.
	assert.deepEqual(kinds(await lookUp({ text: 'hm', context: { fileId: 'package:goodbyes:package.yml', fileName: 'package.yml', index: 1 } })), ['snippets_get_snippet', 'snippets_get_file']);
	assert.deepEqual(logged, []);
});

test('at most eight matches, and at most 25 snippets of the open file', async (t) => {
	const { lookUp, matchDir } = await setup(t);
	writeFileSync(join(matchDir, 'many.yml'), `matches:\n${Array.from({ length: 40 }, (_, index) => `  - trigger: ":r${index}"\n    replace: "Refund number ${index}"\n`).join('')}`);
	const result = await lookUp({ text: 'the refund one', context: { fileId: 'local:many.yml', fileName: 'many.yml' } });
	assert.equal(result.lookups[0].result.items.length, 8);
	assert.equal(result.found.length, 8);
	assert.equal(result.lookups[1].result.snippets.length, 25);
	assert.equal(result.lookups[1].result.snippet_count, 40);
	assert.equal(result.lookups[1].result.has_more, true);
});

// 300 snippets, each long in its trigger, its label and its text.
const LONG = `matches:\n${Array.from({ length: 300 }, (_, index) => `  - trigger: ":r${index}-${'t'.repeat(300)}"\n    label: "${'L'.repeat(300)}"\n    replace: "${'refund '.repeat(40).trim()}"\n`).join('')}`;

test('everything together stays under the cap: the file summary gives way first, then matches from the end', async (t) => {
	const context = { fileId: 'local:long.yml', fileName: 'long.yml', index: 0 };
	const size = (result) => JSON.stringify(result.lookups).length;
	const long = async (most) => {
		const made = await setup(t, most ? { most } : {});
		writeFileSync(join(made.matchDir, 'long.yml'), LONG);
		return made.lookUp({ text: 'refund', context });
	};

	// The summary of 25 such snippets is itself over 12,000 characters.
	const usual = await long();
	assert.deepEqual(kinds(usual), ['snippets_get_snippet', 'snippets_search']);
	assert.equal(usual.found.length, 8);
	assert.ok(size(usual) <= 12_000, `${size(usual)} characters`);

	// With room for all three, all three come.
	assert.deepEqual(kinds(await long(100_000)), ['snippets_get_snippet', 'snippets_search', 'snippets_get_file']);

	// Tighter: some matches fit. The matches shown are the matches sent.
	const cut = await long(3000);
	assert.deepEqual(kinds(cut), ['snippets_get_snippet', 'snippets_search']);
	assert.ok(size(cut) <= 3000, `${size(cut)} characters`);
	assert.ok(cut.found.length >= 1 && cut.found.length < 8, `${cut.found.length} matches`);
	assert.deepEqual(cut.found.map((hit) => hit.index), cut.lookups[1].result.items.map((item) => item.index));
	assert.deepEqual(cut.found.map((hit) => hit.index), usual.found.map((hit) => hit.index).slice(0, cut.found.length));

	// Tighter still: no match fits, so there is no search lookup and nothing to show.
	const least = await long(1300);
	assert.deepEqual(kinds(least), ['snippets_get_snippet']);
	assert.deepEqual(least.found, []);
	assert.ok(size(least) <= 1300, `${size(least)} characters`);
});

test('an open snippet too long to hand over is left for the assistant to read, and the rest still comes', async (t) => {
	const { lookUp, matchDir } = await setup(t, { most: 2000 });
	writeFileSync(join(matchDir, 'big.yml'), `matches:\n  - trigger: ":big"\n    replace: "${'word '.repeat(600)}"\n  - trigger: ":small"\n    replace: "A zebra"\n`);
	const result = await lookUp({ text: 'the zebra one', context: { fileId: 'local:big.yml', fileName: 'big.yml', index: 0 } });
	assert.deepEqual(kinds(result), ['snippets_search', 'snippets_get_file']);
	assert.deepEqual(result.found.map((hit) => hit.triggers), [[':small']]);
	assert.ok(JSON.stringify(result.lookups).length <= 2000);

	const { lookUp: tiny, matchDir: dir } = await setup(t, { most: 200 });
	writeFileSync(join(dir, 'big.yml'), `matches:\n  - trigger: ":big"\n    replace: "${'word '.repeat(600)}"\n`);
	assert.deepEqual(await tiny({ text: 'hm', context: { fileId: 'local:big.yml', fileName: 'big.yml', index: 0 } }), { found: [], lookups: [] });
});

test('what the panel is given is short, whatever the snippet holds', async (t) => {
	const { lookUp, matchDir } = await setup(t, { most: 200_000 });
	writeFileSync(join(matchDir, 'wide.yml'), `matches:\n  - triggers: [${Array.from({ length: 9 }, (_, index) => `":zebra${index}${'z'.repeat(200)}"`).join(', ')}]\n    label: "${'Zebra '.repeat(100)}"\n    replace: "${'stripes '.repeat(100)}"\n`);
	writeFileSync(join(matchDir, `${'n'.repeat(150)}.yml`), 'matches:\n  - trigger: ":okapi"\n    replace: "An okapi"\n');
	const named = (await lookUp({ text: 'okapi', context: null })).found;
	assert.equal(named.length, 1);
	assert.equal(named[0].fileName, `${'n'.repeat(79)}…`);
	assert.equal(named[0].fileId, `local:${'n'.repeat(150)}.yml`);
	const { found } = await lookUp({ text: 'zebra', context: null });
	assert.equal(found.length, 1);
	assert.equal(found[0].triggers.length, 5);
	assert.ok(found[0].triggers.every((trigger) => trigger.length <= 80));
	assert.ok(found[0].label.length <= 80);
	assert.ok(found[0].preview.length <= 120);
	assert.ok(found[0].fileName.length <= 80);
});

test('the lookups do not wait on one another', async (t) => {
	// Each of the three is held until all three have been asked for. Were one
	// to wait for another's answer, the last would never be asked. No clock is
	// read: on a busy machine three short waits side by side can take longer
	// than three in a row on a quiet one.
	let asked = 0;
	let letGo;
	const allAsked = new Promise((resolve) => (letGo = resolve));
	const held = async (answer) => {
		asked += 1;
		if (asked === 3) letGo(true);
		await allAsked;
		return answer();
	};
	let real;
	const { lookUp, service } = await setup(t, {
		wrap: (tools) => ({ call: (name, args) => held(() => tools.call(name, args)) }),
		store: { likely: (text, options) => held(() => real.likely(text, options)) },
	});
	real = service.store;
	// If one does wait for another, the test is not left hanging: the hold is let go, and it fails below.
	let askedByThen = 3;
	const giveUp = setTimeout(() => {
		askedByThen = asked;
		letGo(false);
	}, 10_000);
	const result = await lookUp({ text: 'thanks', context: { ...BASE, index: 1 } });
	clearTimeout(giveUp);
	assert.equal(await allAsked, true, `only ${askedByThen} of the three lookups had been asked for while none was answered`);
	assert.deepEqual(kinds(result), ['snippets_get_snippet', 'snippets_search', 'snippets_get_file']);
});

// --- after an independent review ---------------------------------------------------------------

test('one enormous match does not cost the others their place: a match is handed over short', async (t) => {
	const { lookUp, matchDir } = await setup(t);
	mkdirSync(join(matchDir, 'packages', 'huge'), { recursive: true });
	writeFileSync(join(matchDir, 'packages', 'huge', 'package.yml'), `matches:\n  - triggers: [${Array.from({ length: 9 }, (_, index) => `":refund-policy-${index}-${'t'.repeat(300)}"`).join(', ')}]\n    label: "${'Refund policy thanks '.repeat(700)}"\n    replace: "x"\n`);
	writeFileSync(join(matchDir, 'mine.yml'), 'matches:\n  - trigger: ":rp"\n    label: "Refund policy"\n    replace: "Thirty days."\n');
	const result = await lookUp({ text: 'find my refund policy', context: null });
	const items = result.lookups[0].result.items;
	// The huge one is the closer by weight, so it comes first, and it does not push the other out.
	assert.deepEqual(items.map((item) => item.file_id), ['package:huge:package.yml', 'local:mine.yml']);
	assert.equal(items[0].triggers.length, 5);
	assert.ok(items[0].triggers.every((trigger) => trigger.length === 80 && trigger.endsWith('…')));
	assert.equal(items[0].label.length, 80);
	assert.ok(JSON.stringify(items[0]).length < 1000);
	assert.deepEqual(items[1], { file_id: 'local:mine.yml', file: 'mine.yml', source: 'local', index: 0, triggers: [':rp'], label: 'Refund policy', preview: 'Thirty days.' });
	// What is shown is what is sent, field for field.
	assert.deepEqual(result.found, items.map(({ file_id: fileId, file: fileName, ...rest }) => ({ fileId, fileName, ...rest })));
});

test('a snippet the tools could not hand over is not handed over as a match', async (t) => {
	const { lookUp, matchDir, call } = await setup(t);
	writeFileSync(join(matchDir, 'odd.yml'), 'matches:\n  - trigger: ":okapi"\n    replace: "An okapi"\n    weight: .nan\n');
	writeFileSync(join(matchDir, 'even.yml'), 'matches:\n  - trigger: ":okapi2"\n    replace: "Another okapi"\n');
	// The search tool leaves the first out, and so does the lookup.
	assert.deepEqual((await call('snippets_search', { query: 'okapi' })).items.map((item) => item.file_id), ['local:even.yml']);
	const result = await lookUp({ text: 'my okapi snippet', context: null });
	assert.deepEqual(result.lookups[0].result.items.map((item) => item.file_id), ['local:even.yml']);
	assert.deepEqual(result.found.map((hit) => hit.fileId), ['local:even.yml']);
});

test('a snippet folder that cannot be opened gives nothing to look up, and nothing goes wrong', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async (t) => {
	const { lookUp, matchDir, logged } = await setup(t);
	chmodSync(matchDir, 0o000);
	t.after(() => chmodSync(matchDir, 0o755));
	assert.deepEqual(await lookUp({ text: 'Find my thanks', context: { ...BASE, index: 1 } }), { found: [], lookups: [] });
	assert.deepEqual(logged, []);
});
