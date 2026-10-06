// Snippet files are not always your own: a package or a synced file can hold
// anything. None of it may stop the app from opening, blank a screen, or
// show a file from outside the match folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMatchFile } from '../core/matchFile.js';
import { createStore } from '../core/store.js';
import { searchFiles } from '../shared/search.js';
import { applyDraft, draftToMatch, matchToDraft, matchTriggers, previewText, validateDraft } from '../shared/snippetModel.js';
import { fieldsToRows, isEditableVarList, isStructuredVar, rowsToFields } from '../shared/varsModel.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/match', import.meta.url));
const isRoot = userInfo().uid === 0;

function sandbox(options = {}) {
	const root = mkdtempSync(join(tmpdir(), 'snippet-editor-hostile-'));
	const matchDir = join(root, 'match');
	cpSync(FIXTURES, matchDir, { recursive: true });
	return { root, matchDir, store: createStore({ matchDir, backupDir: join(root, 'backups'), ...options }) };
}

const names = (files) => files.map((file) => file.name);
const FIXTURE_NAMES = ['_shared.yml', 'base.yml', 'broken.yml', 'dates.yml'];

// --- parsing ----------------------------------------------------------------

test('an alias to a missing anchor is a file error, not a crash', () => {
	const parsed = parseMatchFile('matches:\n  - trigger: ":a"\n    replace: *missing\n');
	assert.equal(parsed.matches, null);
	assert.equal(parsed.errors.length, 1);
});

test('a snippet that refers to itself through an alias is a file error', () => {
	const parsed = parseMatchFile('matches:\n  - &m\n    trigger: ":a"\n    replace: hi\n    again: *m\n');
	assert.equal(parsed.matches, null);
	assert.match(parsed.errors[0], /refers to itself/);
});

test('an alias bomb is a file error, not a hang or a crash', () => {
	const lines = ['a: &a ["x","x","x","x","x","x","x","x","x"]'];
	for (const [name, previous] of [['b', 'a'], ['c', 'b'], ['d', 'c'], ['e', 'd'], ['f', 'e'], ['g', 'f']]) {
		lines.push(`${name}: &${name} [${Array(9).fill(`*${previous}`).join(',')}]`);
	}
	lines.push('matches:\n  - trigger: ":a"\n    replace: *g');
	const parsed = parseMatchFile(lines.join('\n') + '\n');
	assert.equal(parsed.matches, null);
	assert.equal(parsed.errors.length, 1);
});

// --- the store --------------------------------------------------------------

test('a file with a broken alias is listed as a problem and the rest still load', async () => {
	const { store, matchDir } = sandbox();
	writeFileSync(join(matchDir, 'alias.yml'), 'matches:\n  - trigger: ":a"\n    replace: *missing\n');
	const inv = await store.inventory();
	assert.deepEqual(names(inv.files), ['_shared.yml', 'alias.yml', 'base.yml', 'broken.yml', 'dates.yml']);
	const alias = inv.files.find((file) => file.name === 'alias.yml');
	assert.equal(alias.matches, null);
	assert.equal(alias.parseErrors.length, 1);
	assert.equal(inv.files.find((file) => file.name === 'base.yml').matchCount, 3);
});

test('a file that cannot be read is listed as a problem and the rest still load', { skip: isRoot }, async () => {
	const { store, matchDir } = sandbox();
	writeFileSync(join(matchDir, 'locked.yml'), 'matches: []\n');
	chmodSync(join(matchDir, 'locked.yml'), 0o000);
	symlinkSync('loop.yml', join(matchDir, 'loop.yml'));
	const inv = await store.inventory();
	assert.deepEqual(names(inv.files), ['_shared.yml', 'base.yml', 'broken.yml', 'dates.yml', 'locked.yml', 'loop.yml']);
	for (const name of ['locked.yml', 'loop.yml']) {
		const file = inv.files.find((candidate) => candidate.name === name);
		assert.equal(file.unreadable, true);
		assert.equal(file.readOnly, true);
		assert.equal(file.matches, null);
		assert.equal(file.parseErrors.length, 1);
	}
});

test('a file over the size limit is listed but not opened, and cannot be overwritten', async () => {
	const { store, matchDir } = sandbox({ maxFileBytes: 400 });
	writeFileSync(join(matchDir, 'huge.yml'), 'matches:\n' + '  - trigger: ":x"\n    replace: "y"\n'.repeat(40));
	const inv = await store.inventory();
	const huge = inv.files.find((file) => file.name === 'huge.yml');
	assert.equal(huge.unreadable, true);
	assert.equal(huge.matches, null);
	assert.match(huge.parseErrors[0], /too large/);
	assert.deepEqual(names(inv.files).filter((name) => name !== 'huge.yml'), FIXTURE_NAMES);
	await assert.rejects(
		store.saveRaw({ source: 'local', name: 'huge.yml' }, { text: 'matches: []\n', version: huge.version }),
		(error) => error.code === 'READ_ONLY'
	);
});

test('a package manifest with odd values does not stop the inventory', async () => {
	const { store, matchDir } = sandbox();
	writeFileSync(join(matchDir, 'packages', 'goodbyes', '_manifest.yml'), 'title:\n  toString: 1\nversion: [1, 2]\nauthor: 7\n');
	const inv = await store.inventory();
	assert.deepEqual(names(inv.files), FIXTURE_NAMES);
	const [pkg] = inv.packages;
	assert.equal(pkg.title, 'goodbyes');
	assert.equal(pkg.version, '');
	assert.equal(pkg.author, '7');
	assert.equal(pkg.matchCount, 2);
});

test('a package folder that cannot be read is listed with its error', { skip: isRoot }, async () => {
	const { store, matchDir } = sandbox();
	mkdirSync(join(matchDir, 'packages', 'sealed'));
	chmodSync(join(matchDir, 'packages', 'sealed'), 0o000);
	const inv = await store.inventory();
	chmodSync(join(matchDir, 'packages', 'sealed'), 0o700);
	assert.deepEqual(names(inv.files), FIXTURE_NAMES);
	assert.deepEqual(
		inv.packages.map((pkg) => [pkg.name, pkg.files.length, pkg.manifestError !== '']),
		[
			['goodbyes', 1, false],
			['sealed', 0, true],
		]
	);
});

test('a match folder that cannot be read reports the problem instead of failing', { skip: isRoot }, async () => {
	const { store, matchDir } = sandbox();
	chmodSync(matchDir, 0o000);
	const inv = await store.inventory();
	chmodSync(matchDir, 0o700);
	assert.equal(inv.exists, true);
	assert.match(inv.error, /could not be read/);
	assert.deepEqual([inv.files, inv.packages], [[], []]);
});

test('a symlink inside a package cannot show a file from outside the packages folder', async () => {
	const { store, matchDir, root } = sandbox();
	writeFileSync(join(root, 'secret.yml'), 'matches:\n  - trigger: ":s"\n    replace: "private"\n');
	symlinkSync(join(root, 'secret.yml'), join(matchDir, 'packages', 'goodbyes', 'leak.yml'));
	const inv = await store.inventory();
	assert.deepEqual(names(inv.packages[0].files), ['package.yml']);
	await assert.rejects(
		store.readFile({ source: 'package', package: 'goodbyes', name: 'leak.yml' }),
		(error) => error.code === 'NOT_FOUND'
	);
	assert.deepEqual(await store.search('private'), []);
});

test('a package folder that is itself a link to somewhere else is not read', async () => {
	const { store, matchDir, root } = sandbox();
	mkdirSync(join(root, 'elsewhere'));
	writeFileSync(join(root, 'elsewhere', 'package.yml'), 'matches:\n  - trigger: ":s"\n    replace: "private"\n');
	symlinkSync(join(root, 'elsewhere'), join(matchDir, 'packages', 'linked'));
	const inv = await store.inventory();
	assert.deepEqual(
		inv.packages.map((pkg) => pkg.name),
		['goodbyes']
	);
	await assert.rejects(
		store.readFile({ source: 'package', package: 'linked', name: 'package.yml' }),
		(error) => error.code === 'NOT_FOUND'
	);
});

// --- the models the screens render from -------------------------------------

const TRAP = { toString: 1, valueOf: 1 };
const HOSTILE = [
	{ trigger: TRAP, replace: 'hi' },
	{ triggers: [TRAP, ':ok', null], replace: 'hi' },
	{ trigger: ':a', replace: TRAP },
	{ trigger: ':a', label: TRAP, replace: 'hi', search_terms: [TRAP] },
	{ regex: TRAP, form: TRAP, form_fields: ['x'] },
	{ trigger: ':a', replace: 'hi', vars: [null, 'text', { name: TRAP, type: TRAP }] },
	{ trigger: ':a', replace: 'hi', vars: { not: 'a list' } },
	{ trigger: ':a', replace: 'hi', vars: [{ name: 'v', type: 'constructor', params: { x: 1, constructor: 2 } }] },
	{ trigger: 12, label: 34, replace: true },
];

test('no snippet shape makes the list, search or editor models throw', () => {
	for (const match of HOSTILE) {
		assert.doesNotThrow(() => {
			matchTriggers(match).forEach((trigger) => assert.equal(typeof trigger, 'string'));
			assert.equal(typeof previewText(match), 'string');
			searchFiles([{ id: 'local:x.yml', source: 'local', name: 'x.yml', matches: [match] }], 'hi a');
			const draft = matchToDraft(match);
			validateDraft(draft);
			draftToMatch(draft);
			(draft.vars ?? []).forEach((variable) => isStructuredVar(variable));
		}, JSON.stringify(match));
	}
});

test('opening and saving a strangely shaped snippet without edits changes nothing', () => {
	for (const match of HOSTILE) {
		assert.deepStrictEqual(applyDraft(match, matchToDraft(match)), match);
	}
});

test('numbers and booleans are shown as text', () => {
	const match = { trigger: 12, label: 34, replace: true };
	assert.deepEqual(matchTriggers(match), ['12']);
	assert.equal(previewText(match), 'true');
	assert.equal(matchToDraft(match).label, '34');
});

test('a variable list the form cannot show is kept whole for the YAML editor', () => {
	const vars = [null, 'text', { name: TRAP, type: TRAP }];
	assert.equal(isEditableVarList(vars), false);
	assert.equal(isEditableVarList({ not: 'a list' }), false);
	assert.equal(isEditableVarList([{ name: 'v', type: 'date' }, { name: 'w' }]), true);
	const draft = matchToDraft({ trigger: ':a', replace: 'hi', vars });
	assert.deepEqual(draft.vars, []);
	assert.equal(draft.varsRaw, vars);
	assert.equal(draftToMatch(draft).vars, vars);
});

test('variable types named after built-in properties are not mistaken for known types', () => {
	assert.equal(isStructuredVar({ name: 'v', type: 'constructor', params: { x: 1 } }), false);
	assert.equal(isStructuredVar({ name: 'v', type: 'date', params: { constructor: 'x' } }), false);
	assert.equal(isStructuredVar({ name: 'v', type: TRAP }), false);
});

test('a form field named __proto__ is an ordinary field', () => {
	const rows = fieldsToRows(undefined, 'Hi [[__proto__]] and [[constructor]]');
	assert.deepEqual(rows.map((row) => [row.name, row.kind]), [['__proto__', 'text'], ['constructor', 'text']]);
	const fields = rowsToFields([{ name: '__proto__', kind: 'multiline', values: [], default: '' }]);
	assert.deepEqual(Object.keys(fields), ['__proto__']);
	assert.equal(Object.getPrototypeOf(fields), Object.prototype);
});

test('a package manifest that links outside the packages folder is ignored', async () => {
	const { store, matchDir, root } = sandbox();
	writeFileSync(join(root, 'outside.yml'), 'title: Leaked title\ndescription: Leaked description\n');
	mkdirSync(join(matchDir, 'packages', 'sneaky'));
	writeFileSync(join(matchDir, 'packages', 'sneaky', 'package.yml'), 'matches: []\n');
	symlinkSync(join(root, 'outside.yml'), join(matchDir, 'packages', 'sneaky', '_manifest.yml'));
	const sneaky = (await store.inventory()).packages.find((pkg) => pkg.name === 'sneaky');
	assert.deepEqual([sneaky.title, sneaky.description], ['sneaky', '']);
});
