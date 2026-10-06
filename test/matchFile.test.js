import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
	parseMatchFile,
	parseHeaderMeta,
	writeHeaderMeta,
	applyMatchUpdate,
	insertMatch,
	removeMatch,
	stringifyMatch,
	newFileText,
} from '../core/matchFile.js';

const BASE = readFileSync(new URL('./fixtures/match/base.yml', import.meta.url), 'utf8');

test('parsing reads the matches and the header comment metadata', () => {
	const parsed = parseMatchFile(BASE);
	assert.deepEqual(parsed.errors, []);
	assert.equal(parsed.matches.length, 3);
	assert.deepEqual(parsed.matches[0], { trigger: ';hello', replace: 'Hello there' });
	assert.deepEqual(parsed.matches[2], { triggers: [';ty', ';thanks'], replace: 'Thank you!' });
	assert.deepEqual(parsed.header, { description: 'Greetings for support replies', prefix: ';' });
});

test('editing one value leaves every other byte of the file alone', () => {
	const out = applyMatchUpdate(BASE, 0, { trigger: ';hello', replace: 'Hello again' });
	assert.equal(out, BASE.replace('replace: "Hello there"', 'replace: "Hello again"'));
});

test('an update that changes nothing returns the file unchanged', () => {
	const parsed = parseMatchFile(BASE);
	assert.equal(applyMatchUpdate(BASE, 1, parsed.matches[1]), BASE);
});

test('an update keeps keys it was not told about', () => {
	const out = applyMatchUpdate(BASE, 1, {
		trigger: ';sig',
		label: 'Sign-off',
		replace: 'Best,\n{{firstname}}',
		left_word: true,
	});
	assert.equal(out, BASE.replace('label: Signature', 'label: "Sign-off"'));
});

test('an update removes keys the new match no longer carries', () => {
	const out = applyMatchUpdate(BASE, 1, { trigger: ';sig', replace: 'Best,\n{{firstname}}' });
	const match = parseMatchFile(out).matches[1];
	assert.deepEqual(match, { trigger: ';sig', replace: 'Best,\n{{firstname}}' });
});

test('multi-line text is written as a block, not an escaped one-liner', () => {
	const out = applyMatchUpdate(BASE, 0, { trigger: ';hello', replace: 'Hello\nthere\n' });
	assert.ok(out.includes('    replace: |\n      Hello\n      there\n'), out);
	assert.equal(parseMatchFile(out).matches[0].replace, 'Hello\nthere\n');
});

test('a long single line is not folded across lines', () => {
	const long = 'word '.repeat(60).trim();
	const out = applyMatchUpdate(BASE, 0, { trigger: ';hello', replace: long });
	assert.ok(out.includes(`replace: "${long}"`));
});

test('updating an index that does not exist throws', () => {
	assert.throws(() => applyMatchUpdate(BASE, 9, { trigger: ':x', replace: 'x' }), /No snippet at position 9/);
});

test('inserting appends by default and keeps the existing matches', () => {
	const out = insertMatch(BASE, { trigger: ';new', replace: 'New' });
	const parsed = parseMatchFile(out);
	assert.deepEqual(parsed.errors, []);
	assert.equal(parsed.matches.length, 4);
	assert.deepEqual(parsed.matches[3], { trigger: ';new', replace: 'New' });
	assert.ok(out.startsWith(BASE.trimEnd()), 'existing content is untouched');
});

test('inserting at a position places the match there', () => {
	const out = insertMatch(BASE, { trigger: ';new', replace: 'New' }, 1);
	const triggers = parseMatchFile(out).matches.map((m) => m.trigger ?? m.triggers[0]);
	assert.deepEqual(triggers, [';hello', ';new', ';sig', ';ty']);
});

test('inserting into a file with no matches key creates the list', () => {
	const out = insertMatch('# Notes only\n', { trigger: ':a', replace: 'A' });
	assert.equal(out, '# Notes only\n\nmatches:\n  - trigger: ":a"\n    replace: "A"\n');
});

test('inserting into an empty file creates the list', () => {
	assert.equal(insertMatch('', { trigger: ':a', replace: 'A' }), 'matches:\n  - trigger: ":a"\n    replace: "A"\n');
});

test('inserting into an empty matches list fills it', () => {
	const out = insertMatch('matches: []\n', { trigger: ':a', replace: 'A' });
	assert.deepEqual(parseMatchFile(out).matches, [{ trigger: ':a', replace: 'A' }]);
});

test('removing a match keeps the others, the header and file-level keys', () => {
	const out = removeMatch(BASE, 1);
	const parsed = parseMatchFile(out);
	assert.deepEqual(
		parsed.matches.map((m) => m.trigger ?? m.triggers[0]),
		[';hello', ';ty']
	);
	assert.deepEqual(parsed.header, { description: 'Greetings for support replies', prefix: ';' });
	assert.ok(out.includes('global_vars:\n  - name: firstname'));
});

test('a file that does not indent its list keeps that style', () => {
	const flat = 'matches:\n- trigger: ":a"\n  replace: "A"\n- trigger: ":b"\n  replace: "B"\n';
	const out = applyMatchUpdate(flat, 1, { trigger: ':b', replace: 'Bee' });
	assert.equal(out, flat.replace('replace: "B"', 'replace: "Bee"'));
});

test('invalid YAML is reported and yields no matches', () => {
	const parsed = parseMatchFile('matches:\n  - trigger: ":a"\n    replace: "open\n  bad: [\n');
	assert.equal(parsed.matches, null);
	assert.ok(parsed.errors.length > 0);
	assert.match(parsed.errors[0], /line \d+/i);
});

test('a matches key that is not a list is reported', () => {
	const parsed = parseMatchFile('matches: nope\n');
	assert.equal(parsed.matches, null);
	assert.deepEqual(parsed.errors, ['`matches` must be a list of snippets.']);
});

test('a list entry that is not a mapping is reported with its position', () => {
	const parsed = parseMatchFile('matches:\n  - trigger: ":a"\n    replace: A\n  - just text\n');
	assert.equal(parsed.matches, null);
	assert.deepEqual(parsed.errors, ['Snippet 2 is not a mapping of keys.']);
});

test('structured edits refuse a file with YAML errors', () => {
	assert.throws(() => insertMatch('matches: nope\n', { trigger: ':a', replace: 'A' }), /must be a list/);
});

test('a file with no matches key parses as an empty list', () => {
	const parsed = parseMatchFile('# only a comment\n');
	assert.deepEqual(parsed.matches, []);
	assert.deepEqual(parsed.errors, []);
});

test('header metadata reads the first plain comment and the prefix directive', () => {
	assert.deepEqual(parseHeaderMeta('# prefix: ":"\n# Work replies\n# second line\nmatches: []\n'), {
		description: 'Work replies',
		prefix: ':',
	});
	assert.deepEqual(parseHeaderMeta('matches: []\n# trailing\n'), { description: '', prefix: '' });
	assert.deepEqual(parseHeaderMeta("# prefix: ';;'\n"), { description: '', prefix: ';;' });
});

test('writing header metadata replaces the description and prefix lines', () => {
	const out = writeHeaderMeta(BASE, { description: 'Replies', prefix: ':' });
	assert.equal(out, BASE.replace('# Greetings for support replies\n# prefix: ";"', '# Replies\n# prefix: ":"'));
});

test('writing header metadata adds a header to a file without one', () => {
	assert.equal(
		writeHeaderMeta('matches: []\n', { description: 'Mine', prefix: ';' }),
		'# Mine\n# prefix: ";"\n\nmatches: []\n'
	);
});

test('clearing header metadata removes its lines and keeps other comments', () => {
	const text = '# Old\n# prefix: ";"\n# keep me\n\nmatches: []\n';
	assert.equal(writeHeaderMeta(text, { description: '', prefix: '' }), '# keep me\n\nmatches: []\n');
});

test('a prefix containing a quote is escaped and read back intact', () => {
	const out = writeHeaderMeta('matches: []\n', { description: '', prefix: '"' });
	assert.equal(parseHeaderMeta(out).prefix, '"');
});

test('a new file starts with its header and an empty list', () => {
	assert.equal(newFileText({ description: 'Mine', prefix: ';' }), '# Mine\n# prefix: ";"\n\nmatches: []\n');
	assert.equal(newFileText({}), 'matches: []\n');
});

test('stringifyMatch shows one match as the YAML that will be written', () => {
	assert.equal(
		stringifyMatch({ trigger: ':a', replace: 'A\nB', word: true }),
		'- trigger: ":a"\n  replace: |-\n    A\n    B\n  word: true\n'
	);
});
