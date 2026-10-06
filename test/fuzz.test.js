// Property test for the promise in core/matchFile.js: whatever the file
// looks like, an edit to one snippet changes bytes only inside that snippet.
// Files and edits are generated from a fixed seed, so a failure is repeatable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyMatchUpdate, insertMatch, parseMatchFile, removeMatch } from '../core/matchFile.js';

function random(seed) {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state / 2 ** 32;
	};
}

const AWKWARD = [
	'plain words',
	'two\nlines',
	'ends with newline\n',
	'  leading spaces',
	'trailing spaces  ',
	'colon: and # hash',
	'"quoted"',
	"it's",
	'02134',
	'true',
	'',
	'tab\there',
	'emoji 😀',
	'{{var}} and $|$',
	'- not a list\n- at all',
	'a\n\nb',
];

function buildFile(next) {
	const pick = (list) => list[Math.floor(next() * list.length)];
	const chance = (p) => next() < p;
	const eol = chance(0.15) ? '\r\n' : '\n';
	const flat = chance(0.2);
	const dash = flat ? 0 : pick([2, 4]);
	const key = dash + 2;
	const sp = (count) => ' '.repeat(count);
	const lines = [];

	if (chance(0.5)) lines.push('# Header description', ...(chance(0.5) ? ['# prefix: ";"'] : []), '');
	if (chance(0.4)) lines.push('global_vars:', '  - name: g', '    type: echo', '    params:', '      echo: 007', '');
	if (chance(0.3)) lines.push('imports:', '  - "_shared.yml"   # shared', '');
	lines.push(chance(0.2) ? 'matches: # the list' : 'matches:');

	const count = 2 + Math.floor(next() * 4);
	for (let index = 0; index < count; index += 1) {
		if (index > 0) for (let blank = Math.floor(next() * 3); blank > 0; blank -= 1) lines.push('');
		if (chance(0.3)) lines.push(`${sp(dash)}# comment above snippet ${index}`);

		if (chance(0.15)) {
			lines.push(`${sp(dash)}- { trigger: ":f${index}", replace: flow${index} }${chance(0.5) ? '  # flow' : ''}`);
			continue;
		}
		lines.push(`${sp(dash)}- trigger: ${pick([`":t${index}"`, `':t${index}'`, `:t${index}`])}${chance(0.3) ? '   # after trigger' : ''}`);
		if (chance(0.4)) lines.push(`${sp(key)}label: Label ${index}`);
		const style = pick(['quoted', 'plain', 'literal', 'folded', 'number', 'multiplain']);
		if (style === 'quoted') lines.push(`${sp(key)}replace: "Text ${index}\\twith tab"`);
		if (style === 'plain') lines.push(`${sp(key)}replace: Text ${index}${chance(0.3) ? '  # why' : ''}`);
		if (style === 'literal') lines.push(`${sp(key)}replace: ${pick(['|', '|-', '|+'])}`, `${sp(key + 2)}Line one ${index}`, `${sp(key + 2)}  indented`, '', `${sp(key + 2)}Line three`);
		if (style === 'folded') lines.push(`${sp(key)}replace: >`, `${sp(key + 2)}Folded ${index}`, `${sp(key + 2)}  - bullet`, `${sp(key + 2)}more`);
		if (style === 'number') lines.push(`${sp(key)}replace: ${pick(['02134', '+6591234567', '0xDEADBEEF', '1e3', '007'])}`);
		if (style === 'multiplain') lines.push(`${sp(key)}replace: plain that`, `${sp(key + 2)}continues ${index}`);
		if (chance(0.3)) {
			lines.push(`${sp(key)}vars:`, `${sp(key + 2)}# about the date`, `${sp(key + 2)}- name: d${index}`, `${sp(key + 4)}type: date`, `${sp(key + 4)}params:`, `${sp(key + 6)}format: "%Y"  # year`);
		}
		if (chance(0.3)) lines.push(`${sp(key)}word: true`);
		if (chance(0.2)) lines.push(`${sp(key)}left_word: true   # unknown to the form`);
		if (chance(0.2)) lines.push(`${sp(key)}triggers_extra: [a, b]`);
	}
	if (chance(0.3)) lines.push('', `${sp(dash)}# trailing comment`);
	return lines.join(eol) + (chance(0.9) ? eol : '');
}

// Where each snippet's own lines start, and where the next one's begin.
function spans(text) {
	const { seq } = parseMatchFile(text);
	const starts = seq.items.map((item) => {
		let at = item.range[0] - 1;
		while (text[at] !== '-') at -= 1;
		return text.lastIndexOf('\n', at - 1) + 1;
	});
	return starts.map((start, index) => ({ start, end: index + 1 < starts.length ? starts[index + 1] : text.length }));
}

// How much of the start and of the end of `before` survives in `after`.
function kept(before, after) {
	let prefix = 0;
	while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
	let suffix = 0;
	while (suffix < before.length && suffix < after.length && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix += 1;
	return { prefix, suffix };
}

// The blank lines directly above `offset` count as part of what follows.
function aboveBlankLines(text, offset) {
	let start = offset;
	while (start > 0) {
		const previous = text.lastIndexOf('\n', start - 2) + 1;
		if (text.slice(previous, start).trim() !== '') break;
		start = previous;
	}
	return start;
}

function edit(next, match) {
	const pick = (list) => list[Math.floor(next() * list.length)];
	const changed = structuredClone(match);
	const content = ['replace', 'markdown', 'html'].find((name) => name in changed) ?? 'replace';
	const kind = pick(['content', 'label', 'unlabel', 'word', 'triggers', 'extra', 'var', 'type']);
	if (kind === 'content') changed[content] = pick(AWKWARD);
	if (kind === 'label') changed.label = pick(AWKWARD.filter((value) => !value.includes('\n')));
	if (kind === 'unlabel') delete changed.label;
	if (kind === 'word') changed.word === true ? delete changed.word : (changed.word = true);
	if (kind === 'triggers' && 'trigger' in changed) {
		changed.triggers = [changed.trigger, ':second'];
		delete changed.trigger;
	}
	if (kind === 'extra') changed.priority = 3;
	if (kind === 'var') {
		if (Array.isArray(changed.vars)) changed.vars[0].params.format = '%d/%m';
		else changed.vars = [{ name: 'c', type: 'clipboard' }];
	}
	if (kind === 'type') {
		const value = changed[content];
		delete changed[content];
		changed[content === 'replace' ? 'markdown' : 'replace'] = value;
	}
	return changed;
}

test('edits to generated files change bytes only inside the snippet that was edited', () => {
	const next = random(20261006);
	let done = 0;
	let unchanged = 0;

	for (let round = 0; round < 1500; round += 1) {
		const text = buildFile(next);
		const before = parseMatchFile(text);
		assert.deepEqual(before.errors, [], `generated file must parse:\n${text}`);
		const where = spans(text);
		const index = Math.floor(next() * before.matches.length);
		const action = next() < 0.6 ? 'update' : next() < 0.5 ? 'insert' : 'remove';
		const context = `round ${round}, ${action} at ${index}\n--- file ---\n${text}`;

		let out;
		let expected;
		let run;
		if (action === 'update') {
			const changed = edit(next, before.matches[index]);
			expected = before.matches.map((match, at) => (at === index ? changed : match));
			run = () => applyMatchUpdate(text, index, changed);
		} else if (action === 'insert') {
			const added = { trigger: ':new', replace: AWKWARD[Math.floor(next() * AWKWARD.length)] };
			expected = [...before.matches.slice(0, index), added, ...before.matches.slice(index)];
			run = () => insertMatch(text, added, index);
		} else {
			expected = before.matches.filter((_, at) => at !== index);
			run = () => removeMatch(text, index);
		}
		// None of these layouts is exotic, so none of these edits may be refused.
		try {
			out = run();
		} catch (error) {
			assert.fail(`${error.message}\n${context}\n--- wanted ---\n${JSON.stringify(expected[index], null, 1)}`);
		}

		const after = parseMatchFile(out);
		assert.deepEqual(after.errors, [], context + `\n--- result ---\n${out}`);
		assert.deepEqual(after.matches, expected, context + `\n--- result ---\n${out}`);
		done += 1;
		if (out === text) {
			unchanged += 1;
			continue;
		}

		const detail = context + `\n--- result ---\n${out}`;
		if (action === 'insert') {
			// Nothing of the original may be rewritten: every byte of it is
			// still there, in order, around what was added.
			const { prefix, suffix } = kept(text, out);
			assert.ok(prefix + suffix >= text.length, detail);
		} else {
			// Everything before the snippet's first line, and everything from
			// the next snippet's first line on, is byte for byte the same.
			// (An emptied list also marks the `matches:` line with ` []`.)
			const emptied = action === 'remove' && before.matches.length === 1;
			const from = emptied ? 0 : action === 'remove' ? aboveBlankLines(text, where[index].start) : where[index].start;
			// The line break that ended the line above may go with a removed
			// last snippet, when the file had no final line break to begin with.
			assert.ok(out.startsWith(text.slice(0, from).replace(/\r?\n$/, '')), detail);
			assert.ok(out.endsWith(text.slice(where[index].end)), detail);
		}
	}

	assert.equal(done, 1500);
	// A no-op is legitimate (removing a label that is not there), but if most
	// rounds did nothing the test would be proving nothing.
	assert.ok(unchanged < 300, `${unchanged} rounds changed nothing`);
});
