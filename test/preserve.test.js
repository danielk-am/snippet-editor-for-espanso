// The promise this app makes about your files: an edit changes the bytes of
// the thing you edited and nothing else. Each test here pins one way that
// promise was, or could be, broken.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyMatchUpdate, insertMatch, parseHeaderMeta, parseMatchFile, removeMatch, writeHeaderMeta } from '../core/matchFile.js';

const A = { trigger: ':a', replace: 'a' };
const matches = (text) => parseMatchFile(text).matches;

// --- other snippets are not rewritten ------------------------------------------

const NUMERIC = [
	'matches:',
	'  - trigger: ":a"',
	'    replace: "a"',
	'  - trigger: ":phone"',
	'    replace: +6591234567',
	'  - trigger: ":zip"',
	'    replace: 02134',
	'  - trigger: ":id"',
	'    replace: 123456789012345678',
	'  - trigger: ":hex"',
	'    replace: 0xDEADBEEF',
	'  - trigger: ":sci"',
	'    replace: 1e3',
	'  - trigger: ":yes"',
	'    replace: true',
	'',
].join('\n');

test('number-like text in other snippets is not rewritten', () => {
	const out = applyMatchUpdate(NUMERIC, 0, { ...A, label: 'First' });
	assert.equal(out, NUMERIC.replace('    replace: "a"\n', '    replace: "a"\n    label: "First"\n'));
});

test('number-like text is read as the characters Espanso sees', () => {
	assert.deepEqual(
		matches(NUMERIC).map((match) => match.replace),
		['a', '+6591234567', '02134', '123456789012345678', '0xDEADBEEF', '1e3', 'true']
	);
});

test('editing a different field of a snippet with number-like text keeps that text', () => {
	const out = applyMatchUpdate(NUMERIC, 2, { trigger: ':zip', replace: '02134', label: 'Zip' });
	assert.equal(out, NUMERIC.replace('    replace: 02134\n', '    replace: 02134\n    label: "Zip"\n'));
});

test('a folded scalar in another snippet survives repeated saves', () => {
	const tail = '  - trigger: ":b"\n    replace: >\n      Intro paragraph\n        - bullet one\n        \n      Closing\n';
	const text = 'matches:\n  - trigger: ":a"\n    replace: "a"\n' + tail;
	const once = applyMatchUpdate(text, 0, { trigger: ':a', replace: 'one' });
	const twice = applyMatchUpdate(once, 0, { trigger: ':a', replace: 'two' });
	assert.equal(twice, 'matches:\n  - trigger: ":a"\n    replace: "two"\n' + tail);
});

test('escapes in other quoted strings stay as they were written', () => {
	const other = '  - trigger: ":b"\n    replace: "x\\u00a0y \\U0001F600 \\x7f \\N"\n';
	const text = 'matches:\n  - trigger: ":a"\n    replace: "a"\n' + other;
	assert.equal(applyMatchUpdate(text, 0, { trigger: ':a', replace: 'z' }), 'matches:\n  - trigger: ":a"\n    replace: "z"\n' + other);
});

// --- layout is left alone -------------------------------------------------------

test('a file indented with four spaces keeps its indentation', () => {
	const text = 'matches:\n    - trigger: ":a"\n      replace: "a"\n    - trigger: ":b"\n      replace: "b"\n';
	assert.equal(applyMatchUpdate(text, 1, { trigger: ':b', replace: 'bee' }), text.replace('replace: "b"', 'replace: "bee"'));
});

test('a key added in a four-space file lines up with its siblings', () => {
	const text = 'matches:\n    - trigger: ":a"\n      replace: "a"\n    - trigger: ":b"\n      replace: "b"\n';
	assert.equal(
		applyMatchUpdate(text, 0, { ...A, word: true }),
		'matches:\n    - trigger: ":a"\n      replace: "a"\n      word: true\n    - trigger: ":b"\n      replace: "b"\n'
	);
});

test('blank lines, comment spacing and trailing blank lines are left alone', () => {
	const text =
		'# top\n\n\nglobal_vars:\n- name: g\n  type: echo\n  params: {echo: 007}\n\nmatches: # the list\n  - trigger: ":a"   # first\n    replace:\t"a"\n\n\n# Section B\n  - trigger: ":b"\n    replace: this is\n      a plain multiline\n      scalar\n\n\n';
	const out = applyMatchUpdate(text, 0, { trigger: ':a', replace: 'a', label: 'L' });
	assert.equal(out, text.replace('    replace:\t"a"\n', '    replace:\t"a"\n    label: "L"\n'));
});

test('a file without a final line break stays that way', () => {
	const text = 'matches:\n  - trigger: ":a"\n    replace: "a"';
	assert.equal(applyMatchUpdate(text, 0, { trigger: ':a', replace: 'b' }), 'matches:\n  - trigger: ":a"\n    replace: "b"');
});

test('a key added to a file without a final line break goes on its own line', () => {
	const text = 'matches:\n  - trigger: ":a"\n    replace: "a"';
	assert.equal(applyMatchUpdate(text, 0, { ...A, word: true }), 'matches:\n  - trigger: ":a"\n    replace: "a"\n    word: true');
});

test('a flow-style snippet elsewhere is untouched, and one edited in place stays flow', () => {
	const text = 'matches:\n  - { trigger: ":c", replace: c }\n  - trigger: ":d"\n    replace: d\n';
	assert.equal(applyMatchUpdate(text, 1, { trigger: ':d', replace: 'dee' }), text.replace('replace: d\n', 'replace: "dee"\n'));
	assert.equal(applyMatchUpdate(text, 0, { trigger: ':c', replace: 'see' }), text.replace('replace: c }', 'replace: "see" }'));
});

test('a flow list edited in place stays a flow list', () => {
	const text = 'matches:\n  - triggers: [";ty", ";thanks"]  # both\n    replace: "Thank you!"\n';
	assert.equal(
		applyMatchUpdate(text, 0, { triggers: [';ty', ';thx'], replace: 'Thank you!' }),
		text.replace('";thanks"', '";thx"')
	);
	assert.equal(
		applyMatchUpdate(text, 0, { triggers: [';ty', ';thanks', ';cheers'], replace: 'Thank you!' }),
		text.replace('[";ty", ";thanks"]', '[";ty", ";thanks", ";cheers"]')
	);
});

test('a byte order mark and mixed line endings are preserved', () => {
	const text = '\ufeffmatches:\r\n  - trigger: ":a"\n    replace: "a"\r\n  - trigger: ":b"\n    replace: "b"\n';
	assert.equal(applyMatchUpdate(text, 1, { trigger: ':b', replace: 'bee' }), text.replace('replace: "b"', 'replace: "bee"'));
});

test('lines added to a CRLF file end in CRLF', () => {
	const text = 'matches:\r\n  - trigger: ":a"\r\n    replace: "a"\r\n';
	assert.equal(applyMatchUpdate(text, 0, { ...A, word: true }), text + '    word: true\r\n');
	assert.equal(applyMatchUpdate(text, 0, { trigger: ':a', replace: 'x\ny' }), 'matches:\r\n  - trigger: ":a"\r\n    replace: |-\r\n      x\r\n      y\r\n');
});

// --- inside one snippet ---------------------------------------------------------

const VARS = [
	'matches:',
	'  - trigger: ":d"',
	'    replace: "{{d}} {{e}}"',
	'    vars:',
	'      # the date',
	'      - name: d',
	'        type: date',
	'        params:',
	'          format: "%Y"  # year only',
	'      # second var',
	'      - name: e   # keep me',
	'        type: echo',
	'        params:',
	'          echo: one',
	'',
].join('\n');
const varsMatch = () => structuredClone(matches(VARS)[0]);

test('changing one variable keeps the comments and layout of the others', () => {
	const match = varsMatch();
	match.vars[1].params.echo = 'two';
	assert.equal(applyMatchUpdate(VARS, 0, match), VARS.replace('echo: one', 'echo: "two"'));
});

test('adding a variable appends it and leaves the others alone', () => {
	const match = varsMatch();
	match.vars.push({ name: 'c', type: 'clipboard' });
	assert.equal(applyMatchUpdate(VARS, 0, match), VARS + '      - name: "c"\n        type: "clipboard"\n');
});

test('removing a variable removes its lines and keeps the comments', () => {
	const match = varsMatch();
	match.vars.shift();
	const out = applyMatchUpdate(VARS, 0, match);
	assert.deepEqual(matches(out)[0].vars, [{ name: 'e', type: 'echo', params: { echo: 'one' } }]);
	for (const kept of ['# the date', '# second var', '- name: e   # keep me']) assert.ok(out.includes(kept), kept);
	assert.ok(!out.includes('name: d'));
});

test('a trailing comment stays on its line when the value becomes multi-line', () => {
	const text = 'matches:\n  - trigger: ":a"\n    replace: "a"  # note\n    word: true\n';
	assert.equal(
		applyMatchUpdate(text, 0, { trigger: ':a', replace: 'x\ny', word: true }),
		'matches:\n  - trigger: ":a"\n    replace: |-  # note\n      x\n      y\n    word: true\n'
	);
});

test('a multi-line value replaced by a short one leaves no stray lines', () => {
	const text = 'matches:\n  - trigger: ":a"\n    replace: |\n      one\n      two\n    word: true\n';
	assert.equal(applyMatchUpdate(text, 0, { trigger: ':a', replace: 'short', word: true }), 'matches:\n  - trigger: ":a"\n    replace: "short"\n    word: true\n');
});

test('switching trigger type or content type renames the key where it is', () => {
	const text = 'matches:\n  - trigger: ";hello"\n    replace: "Hello there"\n    word: true\n';
	assert.equal(applyMatchUpdate(text, 0, { regex: ';h(\\d)', replace: 'Hello there', word: true }), text.replace('trigger: ";hello"', 'regex: ";h(\\\\d)"'));
	assert.equal(applyMatchUpdate(text, 0, { trigger: ';hello', markdown: 'Hello there', word: true }), text.replace('replace:', 'markdown:'));
});

test('removing a key removes its line', () => {
	const text = 'matches:\n  - trigger: ":a"\n    label: L  # gone\n    replace: "a"\n';
	assert.equal(applyMatchUpdate(text, 0, A), 'matches:\n  - trigger: ":a"\n    replace: "a"\n');
});

test('every awkward piece of text is read back exactly as it was given', () => {
	const text = 'matches:\n  - trigger: ":a"\n    replace: "a"\n  - trigger: ":b"\n    replace: "b"\n';
	const awkward = [
		'   \n',
		'a  \nb',
		'  leading',
		'trailing  ',
		'tab\there',
		'a\n\n',
		'\nstarts blank',
		'a\r\nb',
		'x\u007fy',
		'\u00a0',
		'x\u200by',
		'\ufeff',
		'emoji 😀\nsecond line',
		'# not a comment\n- not a list',
		'key: value',
		'"quoted" and \\backslash',
		'',
		'null',
		'~',
		'  \n  indented block\n',
	];
	for (const value of awkward) {
		const out = applyMatchUpdate(text, 0, { trigger: ':a', replace: value });
		assert.deepEqual(matches(out), [{ trigger: ':a', replace: value }, { trigger: ':b', replace: 'b' }], JSON.stringify(value));
	}
});

// --- adding and removing snippets -----------------------------------------------

const STOCK = [
	'# espanso match file',
	'',
	'matches:',
	'  # Simple text replacement',
	'  - trigger: ":espanso"',
	'    replace: "Hi there!"',
	'',
	'  # NOTE: espanso uses YAML to define matches',
	'',
	'  # But matches can also be dynamic:',
	'',
	'  # Print the current date',
	'  - trigger: ":date"',
	'    replace: "{{mydate}}"',
	'',
	'  # And much more! For more information, visit the docs: https://espanso.org/docs/',
	'',
].join('\n');

test('editing a snippet leaves every line of the stock file where it was', () => {
	assert.equal(applyMatchUpdate(STOCK, 0, { trigger: ':espanso', replace: 'Hello!' }), STOCK.replace('"Hi there!"', '"Hello!"'));
});

test('removing a snippet removes its lines and no comment', () => {
	const out = removeMatch(STOCK, 1);
	assert.equal(out, STOCK.replace('  - trigger: ":date"\n    replace: "{{mydate}}"\n', ''));
});

test('a snippet inserted first goes above the comment introducing the old first one', () => {
	const out = insertMatch(STOCK, { trigger: ':new', replace: 'N' }, 0);
	assert.equal(out, STOCK.replace('  # Simple text replacement\n', '  - trigger: ":new"\n    replace: "N"\n\n  # Simple text replacement\n'));
});

test('a snippet appended goes after the last snippet and before trailing comments', () => {
	const out = insertMatch(STOCK, { trigger: ':new', replace: 'N' });
	assert.equal(out, STOCK.replace('    replace: "{{mydate}}"\n', '    replace: "{{mydate}}"\n\n  - trigger: ":new"\n    replace: "N"\n'));
});

test('removing the only snippet leaves an empty list and its comment', () => {
	const out = removeMatch('matches:\n  # Greeting\n  - trigger: ":a"\n    replace: "A"\n', 0);
	const parsed = parseMatchFile(out);
	assert.deepEqual([parsed.matches, parsed.errors], [[], []]);
	assert.ok(out.includes('# Greeting'));
});

test('an edit that would change another snippet is refused', () => {
	const text = [
		'global_vars:',
		'  - name: g',
		'    type: echo',
		'    params: &p {echo: one}',
		'matches:',
		'  - trigger: ":a"',
		'    replace: "a"',
		'    vars:',
		'      - name: v',
		'        type: echo',
		'        params: &p {echo: two}',
		'  - trigger: ":b"',
		'    replace: "b"',
		'    vars:',
		'      - name: w',
		'        type: echo',
		'        params: *p',
		'',
	].join('\n');
	assert.equal(matches(text)[1].vars[0].params.echo, 'two');
	assert.throws(() => removeMatch(text, 0), /could not be made safely/);
});

test('a position that is not a whole number in range is refused', () => {
	const text = 'matches:\n  - trigger: ":a"\n    replace: "a"\n';
	for (const index of ['length', '__proto__', -1, 1.5, 1, undefined, null]) {
		assert.throws(() => removeMatch(text, index), /No snippet at position/, String(index));
		assert.throws(() => applyMatchUpdate(text, index, A), /No snippet at position/, String(index));
	}
	assert.equal(parseMatchFile(text).matches.length, 1);
});

// --- header comment -------------------------------------------------------------

test('saving unchanged details changes nothing', () => {
	for (const text of [
		'##############\n# My snippets\n##############\n\nmatches: []\n',
		'# prefix: ;\n# Desc\nmatches: []\n',
		'#    Indented   desc\n\n\nmatches: []\n',
		'\ufeff# Desc\r\n\r\nmatches: []\r\n',
		'matches: []\n',
	]) {
		assert.equal(writeHeaderMeta(text, parseHeaderMeta(text)), text, JSON.stringify(text));
	}
});

test('a banner around the description is not mistaken for it', () => {
	const text = '##############\n# My snippets\n##############\n\nmatches: []\n';
	assert.deepEqual(parseHeaderMeta(text), { description: 'My snippets', prefix: '' });
	assert.equal(writeHeaderMeta(text, { description: 'Work', prefix: '' }), text.replace('# My snippets', '# Work'));
});

test('an editor modeline is kept and is not the description', () => {
	const text = '# yaml-language-server: $schema=https://example.com/match.json\n# Work snippets\n\nmatches: []\n';
	assert.deepEqual(parseHeaderMeta(text), { description: 'Work snippets', prefix: '' });
	assert.equal(writeHeaderMeta(text, { description: 'Work stuff', prefix: '' }), text.replace('# Work snippets', '# Work stuff'));
	const bare = '# yaml-language-server: $schema=https://example.com/match.json\nmatches: []\n';
	assert.equal(
		writeHeaderMeta(bare, { description: 'Mine', prefix: ';' }),
		'# yaml-language-server: $schema=https://example.com/match.json\n# Mine\n# prefix: ";"\nmatches: []\n'
	);
});

test('a description that would read back as the prefix is refused', () => {
	assert.throws(() => writeHeaderMeta('matches: []\n', { description: 'Prefix: none, plain words', prefix: '' }), /cannot start with/);
});

test('details saved to a file with a byte order mark keep it first', () => {
	const out = writeHeaderMeta('\ufeff# Old\n\nmatches: []\n', { description: 'New', prefix: '' });
	assert.equal(out, '\ufeff# New\n\nmatches: []\n');
});

test('details saved to a CRLF file do not change its other lines', () => {
	const text = '# Old\r\n\r\nmatches: []\r\n';
	assert.equal(writeHeaderMeta(text, { description: 'New', prefix: ':' }), '# New\r\n# prefix: ":"\r\n\r\nmatches: []\r\n');
});
