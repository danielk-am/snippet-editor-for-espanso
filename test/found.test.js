import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rowTriggers, triggersNow, whereNow } from '../shared/found.js';
import { triggersOf } from '../mcp/tools.mjs';

// A row in the assistant's "Closest matches" says where a snippet was when
// the app looked. It is found again when it is pressed.

const files = () => [
	{
		id: 'local:base.yml',
		name: 'base.yml',
		matches: [
			{ trigger: ';hello', replace: 'Hello there' },
			{ trigger: ';sig', replace: 'Best' },
			{ triggers: [';ty', ';thanks'], replace: 'Thank you!' },
			{ regex: ':ticket(\\d+)', replace: 'x' },
		],
	},
	{ id: 'local:broken.yml', name: 'broken.yml', matches: null },
];
const hit = (extra = {}) => ({ fileId: 'local:base.yml', fileName: 'base.yml', source: 'local', index: 2, triggers: [';ty', ';thanks'], label: '', preview: 'Thank you!', ...extra });

test('a snippet that is where it was is opened there', () => {
	assert.deepEqual(whereNow(files(), hit()), { view: 'snippet', fileId: 'local:base.yml', index: 2 });
	assert.deepEqual(whereNow(files(), hit({ index: 0, triggers: [';hello'] })), { view: 'snippet', fileId: 'local:base.yml', index: 0 });
	assert.deepEqual(whereNow(files(), hit({ index: 3, triggers: [':ticket(\\d+)'] })), { view: 'snippet', fileId: 'local:base.yml', index: 3 });
});

test('a snippet that has moved in its file is opened where it is now', () => {
	const moved = files();
	moved[0].matches.unshift({ trigger: ';new', replace: 'New' });
	assert.deepEqual(whereNow(moved, hit()), { view: 'snippet', fileId: 'local:base.yml', index: 3 });
	// The one now at its old position is not it.
	assert.deepEqual(whereNow(moved, hit({ index: 1, triggers: [';sig'] })), { view: 'snippet', fileId: 'local:base.yml', index: 2 });
});

test('a snippet that is gone, or whose triggers have changed, opens its file', () => {
	const gone = files();
	gone[0].matches.splice(2, 1);
	assert.deepEqual(whereNow(gone, hit()), { view: 'file', fileId: 'local:base.yml' });
	const renamed = files();
	renamed[0].matches[2].triggers = [';ty'];
	assert.deepEqual(whereNow(renamed, hit()), { view: 'file', fileId: 'local:base.yml' });
	assert.deepEqual(whereNow(files(), hit({ index: 99 })), { view: 'snippet', fileId: 'local:base.yml', index: 2 });
});

test('a file that is gone opens nothing, and a file with errors opens as a file', () => {
	assert.equal(whereNow(files(), hit({ fileId: 'local:nowhere.yml' })), null);
	assert.equal(whereNow([], hit()), null);
	assert.deepEqual(whereNow(files(), hit({ fileId: 'local:broken.yml', index: 0 })), { view: 'file', fileId: 'local:broken.yml' });
});

test('of two snippets with the same triggers, the one still at the position is opened; moved, they cannot be told apart, and the file is opened', () => {
	const twins = files();
	twins[0].matches.push({ triggers: [';ty', ';thanks'], replace: 'Thanks again' });
	assert.deepEqual(whereNow(twins, hit({ index: 4 })), { view: 'snippet', fileId: 'local:base.yml', index: 4 });
	assert.deepEqual(whereNow(twins, hit({ index: 2 })), { view: 'snippet', fileId: 'local:base.yml', index: 2 });
	assert.deepEqual(whereNow(twins, hit({ index: 1 })), { view: 'file', fileId: 'local:base.yml' });
	// With one of the two gone, the other is the only one it can be.
	twins[0].matches.splice(2, 1);
	assert.deepEqual(whereNow(twins, hit({ index: 0 })), { view: 'snippet', fileId: 'local:base.yml', index: 3 });
	// The same holds for snippets that have no trigger at all.
	const bare = [{ id: 'local:bare.yml', name: 'bare.yml', matches: [{ trigger: ';a', replace: 'x' }, { replace: 'One' }, { replace: 'Two' }] }];
	assert.deepEqual(whereNow(bare, { fileId: 'local:bare.yml', index: 2, triggers: [] }), { view: 'snippet', fileId: 'local:bare.yml', index: 2 });
	assert.deepEqual(whereNow(bare, { fileId: 'local:bare.yml', index: 0, triggers: [] }), { view: 'file', fileId: 'local:bare.yml' });
});

test('a row shows at most five triggers of at most 80 characters, and a snippet is still found by them', () => {
	const long = [{ id: 'local:wide.yml', name: 'wide.yml', matches: [{ trigger: ';a', replace: 'x' }, { triggers: Array.from({ length: 9 }, (_, index) => `:zebra${index}${'z'.repeat(200)}`), replace: 'x' }] }];
	const row = rowTriggers(triggersNow(long[0].matches[1]));
	assert.equal(row.length, 5);
	assert.ok(row.every((trigger) => trigger.length === 80 && trigger.endsWith('…')));
	assert.deepEqual(rowTriggers([';ty', 't'.repeat(80), 't'.repeat(81)]), [';ty', 't'.repeat(80), `${'t'.repeat(79)}…`]);
	assert.deepEqual(whereNow(long, { fileId: 'local:wide.yml', index: 0, triggers: row }), { view: 'snippet', fileId: 'local:wide.yml', index: 1 });
});

test('a snippet with no trigger at all is found by having none', () => {
	const bare = [{ id: 'local:bare.yml', name: 'bare.yml', matches: [{ trigger: ';a', replace: 'x' }, { replace: 'No trigger here' }] }];
	assert.deepEqual(whereNow(bare, { fileId: 'local:bare.yml', index: 1, triggers: [] }), { view: 'snippet', fileId: 'local:bare.yml', index: 1 });
	assert.deepEqual(whereNow(bare, { fileId: 'local:bare.yml', index: 0, triggers: [] }), { view: 'snippet', fileId: 'local:bare.yml', index: 1 });
	// A row whose triggers are not a list is no row: it names no snippet.
	assert.deepEqual(whereNow(bare, { fileId: 'local:bare.yml', index: 1 }), { view: 'file', fileId: 'local:bare.yml' });
	assert.deepEqual(whereNow(bare, { fileId: 'local:bare.yml', index: 1, triggers: '' }), { view: 'file', fileId: 'local:bare.yml' });
});

test('a row that is not a row opens nothing, and nothing in a file can make the finder throw', () => {
	for (const bad of [null, undefined, 'local:base.yml', 7, [], {}, { fileId: 7 }, { fileId: 'local:base.yml' }, { fileId: 'local:base.yml', index: 0, triggers: 'x' }]) {
		const where = whereNow(files(), bad);
		assert.ok(where === null || where.view === 'file', JSON.stringify(bad));
	}
	const odd = [{ id: 'local:odd.yml', name: 'odd.yml', matches: [null, 'text', 7, ['x'], {}, { trigger: 9 }, { triggers: [null, 3, ';ok'] }] }];
	assert.deepEqual(whereNow(odd, { fileId: 'local:odd.yml', index: 0, triggers: ['3', ';ok'] }), { view: 'snippet', fileId: 'local:odd.yml', index: 6 });
	assert.deepEqual(whereNow(odd, { fileId: 'local:odd.yml', index: 0, triggers: ['9'] }), { view: 'snippet', fileId: 'local:odd.yml', index: 5 });
	assert.equal(whereNow(null, hit()), null);
	assert.equal(whereNow([null, 7, { id: 'local:base.yml' }], hit()).view, 'file');
});

test('the triggers of a snippet are read here exactly as the tools read them', () => {
	for (const match of [
		{ trigger: ';a' },
		{ triggers: [';a', ';b'] },
		{ triggers: [';a', 7, true, null, '', { x: 1 }] },
		{ regex: 'a(\\d+)' },
		{ trigger: '', regex: 'r' },
		{ trigger: 7 },
		{ trigger: false, regex: 'r' },
		{ triggers: 'not a list', trigger: ';t' },
		{ triggers: [], trigger: ';t' },
		{ trigger: ';t', regex: 'r' },
		{},
		{ replace: 'only text' },
		null,
		'text',
		[';a'],
	]) {
		assert.deepEqual(triggersNow(match), triggersOf(match), JSON.stringify(match));
	}
});
