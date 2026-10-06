import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMarkdown } from '../renderer/lib/markdown.js';

const t = (text) => ({ type: 'text', text });
const code = (text) => ({ type: 'code', text });
const strong = (...children) => ({ type: 'strong', children });
const em = (...children) => ({ type: 'em', children });
const p = (...inline) => ({ type: 'paragraph', inline });

test('plain text is paragraphs, set apart by empty lines, with the line breaks inside one kept', () => {
	assert.deepEqual(parseMarkdown('One.\n\nTwo,\nstill two.\n\n\n\nThree.'), [p(t('One.')), p(t('Two,\nstill two.')), p(t('Three.'))]);
	assert.deepEqual(parseMarkdown(''), []);
	assert.deepEqual(parseMarkdown('   \n\n  '), []);
	assert.deepEqual(parseMarkdown('Windows\r\nline ends'), [p(t('Windows\nline ends'))]);
});

test('bold, italic and code inside a line, also one inside another', () => {
	assert.deepEqual(parseMarkdown('A **bold** and *slanted* and `code` word.'), [p(t('A '), strong(t('bold')), t(' and '), em(t('slanted')), t(' and '), code('code'), t(' word.'))]);
	assert.deepEqual(parseMarkdown('__bold__ and _slanted_'), [p(strong(t('bold')), t(' and '), em(t('slanted')))]);
	assert.deepEqual(parseMarkdown('**bold with *slant* and `code`**'), [p(strong(t('bold with '), em(t('slant')), t(' and '), code('code')))]);
	assert.deepEqual(parseMarkdown('***both***'), [p(strong(em(t('both'))))]);
	// Inside code nothing else is read.
	assert.deepEqual(parseMarkdown('`**not bold** <b>`'), [p(code('**not bold** <b>'))]);
	assert.deepEqual(parseMarkdown('``a ` b``'), [p(code('a ` b'))]);
	// One space of padding each side is dropped, and no more.
	assert.deepEqual(parseMarkdown('`` `tick` `` and `  two  `'), [p(code('`tick`'), t(' and '), code(' two '))]);
});

test('marks that are not markup stay as they were typed', () => {
	assert.deepEqual(parseMarkdown('2 * 3 * 4 and a_snake_case_name and 5*6'), [p(t('2 * 3 * 4 and a_snake_case_name and 5*6'))]);
	assert.deepEqual(parseMarkdown('an unclosed **bold and `code'), [p(t('an unclosed **bold and `code'))]);
	assert.deepEqual(parseMarkdown('escaped \\*stars\\* and \\`ticks\\`'), [p(t('escaped *stars* and `ticks`'))]);
	assert.deepEqual(parseMarkdown('four **** stars and ____ lines'), [p(t('four **** stars and ____ lines'))]);
	assert.deepEqual(parseMarkdown('x ****four**** y'), [p(t('x ****four**** y'))]);
	assert.deepEqual(parseMarkdown('file_name_ and more'), [p(t('file_name_ and more'))]);
	// Espanso's own marks are text.
	assert.deepEqual(parseMarkdown('Use {{name}} and $|$ and [[field]].'), [p(t('Use {{name}} and $|$ and [[field]].'))]);
});

test('a link is shown as its words and its address, as text', () => {
	assert.deepEqual(parseMarkdown('See [the docs](https://espanso.org/docs/) now.'), [p(t('See the docs (https://espanso.org/docs/) now.'))]);
	assert.deepEqual(parseMarkdown('[https://a.example](https://a.example)'), [p(t('https://a.example'))]);
	assert.deepEqual(parseMarkdown('[click me](javascript:alert(1))'), [p(t('click me (javascript:alert(1))'))]);
	assert.deepEqual(parseMarkdown('![a picture](https://x.example/p.png)'), [p(t('a picture (https://x.example/p.png)'))]);
	assert.deepEqual(parseMarkdown('[not a link] (really)'), [p(t('[not a link] (really)'))]);
	// Brackets inside the address belong to it.
	assert.deepEqual(parseMarkdown('[x(1)](x(1)) after'), [p(t('x(1) after'))]);
});

test('HTML and scripts are text, never markup', () => {
	const hostile = '<script>alert(1)</script> <img src=x onerror=alert(1)> <b>bold</b> &lt; &amp;';
	assert.deepEqual(parseMarkdown(hostile), [p(t(hostile))]);
	const blocks = parseMarkdown('# <h1 onclick=x>\n\n- <li>\n\n> <blockquote>');
	assert.deepEqual(JSON.stringify(blocks).match(/"type":"[a-z]+"/g).filter((kind) => !['"type":"heading"', '"type":"list"', '"type":"quote"', '"type":"text"'].includes(kind)), []);
});

test('headings, rules and quotes', () => {
	assert.deepEqual(parseMarkdown('# One\n## Two with `code`\n###### Six\n####### seven is text\n#hash is text'), [
		{ type: 'heading', level: 1, inline: [t('One')] },
		{ type: 'heading', level: 2, inline: [t('Two with '), code('code')] },
		{ type: 'heading', level: 6, inline: [t('Six')] },
		p(t('####### seven is text\n#hash is text')),
	]);
	assert.deepEqual(parseMarkdown('Above\n\n---\n\nBelow\n***\n_ _ _'), [p(t('Above')), { type: 'rule' }, p(t('Below')), { type: 'rule' }, { type: 'rule' }]);
	assert.deepEqual(parseMarkdown('> Quoted **words**\n> on two lines\n\nAfter'), [{ type: 'quote', inline: [t('Quoted '), strong(t('words')), t('\non two lines')] }, p(t('After'))]);
});

test('lists: bullets and numbers, a second level, and an item that runs on', () => {
	assert.deepEqual(parseMarkdown('- one\n- two\n  - under two\n* three\n+ four'), [
		{
			type: 'list',
			ordered: false,
			items: [
				{ depth: 0, inline: [t('one')] },
				{ depth: 0, inline: [t('two')] },
				{ depth: 1, inline: [t('under two')] },
				{ depth: 0, inline: [t('three')] },
				{ depth: 0, inline: [t('four')] },
			],
		},
	]);
	assert.deepEqual(parseMarkdown('1. first\n2) second\n   runs on\n\n3. third'), [
		{ type: 'list', ordered: true, items: [{ depth: 0, inline: [t('first')] }, { depth: 0, inline: [t('second\nruns on')] }, { depth: 0, inline: [t('third')] }] },
	]);
	// A list ends where something else begins, and the two kinds are two lists.
	assert.deepEqual(parseMarkdown('- a\n\nNot a list\n1. b').map((block) => block.type), ['list', 'paragraph', 'list']);
	assert.deepEqual(parseMarkdown('- a\n1. b').map((block) => [block.type, block.ordered]), [['list', false], ['list', true]]);
	// Not lists.
	assert.deepEqual(parseMarkdown('-not a list\n1.5 is a number\n- '), [p(t('-not a list\n1.5 is a number\n-'))]);
	// Very deep is drawn as the third level.
	assert.equal(parseMarkdown('- a\n          - deep').at(0).items[1].depth, 3);
});

test('a block of code keeps its text exactly, with its language, and one left open runs to the end', () => {
	assert.deepEqual(parseMarkdown('Before\n```yaml\n- trigger: ":sig"\n  replace: "**Best**,\\nSam"\n\n  # comment\n```\nAfter'), [
		p(t('Before')),
		{ type: 'code', language: 'yaml', text: '- trigger: ":sig"\n  replace: "**Best**,\\nSam"\n\n  # comment' },
		p(t('After')),
	]);
	assert.deepEqual(parseMarkdown('```\nno language\n```'), [{ type: 'code', language: '', text: 'no language' }]);
	assert.deepEqual(parseMarkdown('~~~sh\necho hi\n~~~'), [{ type: 'code', language: 'sh', text: 'echo hi' }]);
	// Still being written: the fence has not closed yet.
	assert.deepEqual(parseMarkdown('Here:\n```yaml\n- trigger: ":x"'), [p(t('Here:')), { type: 'code', language: 'yaml', text: '- trigger: ":x"' }]);
	// A longer fence holds a shorter one.
	assert.deepEqual(parseMarkdown('````\n```\ninner\n```\n````'), [{ type: 'code', language: '', text: '```\ninner\n```' }]);
	assert.deepEqual(parseMarkdown('```'), [{ type: 'code', language: '', text: '' }]);
});

test('a table is kept as lined-up text', () => {
	const table = '| Trigger | Expands to |\n| --- | --- |\n| :sig | Best, Sam |';
	assert.deepEqual(parseMarkdown(`Found two:\n\n${table}\n\nDone.`), [p(t('Found two:')), { type: 'code', language: 'table', text: table }, p(t('Done.'))]);
});

test('very long and very nested input is read without trouble', () => {
	const long = 'word '.repeat(50_000);
	const blocks = parseMarkdown(long);
	assert.equal(blocks.length, 1);
	assert.equal(blocks[0].inline[0].text.length, long.trimEnd().length);
	const stars = '*'.repeat(20_000);
	assert.ok(parseMarkdown(`${stars}text${stars}`).length >= 1);
	const nested = `${'**a *b '.repeat(2000)}${' b* a**'.repeat(2000)}`;
	assert.ok(parseMarkdown(nested).length >= 1);
	// Emphasis inside emphasis is followed four levels down, and is text below that.
	const levels = '**a *b __c _d ***e*** d_ c__ b* a**';
	const deepest = (parts, level = 0) => Math.max(level, ...parts.filter((part) => part.children).map((part) => deepest(part.children, level + 1)));
	assert.equal(deepest(parseMarkdown(levels)[0].inline), 4);
	assert.deepEqual(parseMarkdown(null), []);
	assert.deepEqual(parseMarkdown(42), [p(t('42'))]);
});
