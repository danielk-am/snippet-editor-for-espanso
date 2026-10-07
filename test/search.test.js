import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keywordsOf, likelyFiles, searchFiles } from '../shared/search.js';

const FILES = [
	{
		id: 'local:base.yml',
		source: 'local',
		name: 'base.yml',
		matches: [
			{ trigger: ';hello', replace: 'Hello there' },
			{ trigger: ';sig', label: 'Signature', replace: 'Best,\nDaniel' },
			{ triggers: [';ty', ';thanks'], replace: 'Thank you!' },
			{ regex: ':ticket(\\d+)', replace: 'https://example.com/{{id}}', search_terms: ['support', 'Zendesk'] },
			{ trigger: ';m', form: 'Meet [[who]]', markdown: '', html: '<b>bold</b>', image_path: '/img/logo.png' },
		],
	},
	{
		id: 'package:goodbyes:package.yml',
		source: 'package',
		package: 'goodbyes',
		name: 'package.yml',
		matches: [{ trigger: ':bye', label: 'Friendly goodbye', replace: 'Have a great day!' }],
	},
	{ id: 'local:broken.yml', source: 'local', name: 'broken.yml', matches: null },
];

const ids = (hits) => hits.map((h) => `${h.fileId}#${h.index}`);

test('a query matches the trigger', () => {
	assert.deepEqual(ids(searchFiles(FILES, ';hello')), ['local:base.yml#0']);
});

test('a query matches any trigger in a triggers list', () => {
	assert.deepEqual(ids(searchFiles(FILES, 'thanks')), ['local:base.yml#2']);
});

test('a query matches label, content, regex and search terms without regard to case', () => {
	assert.deepEqual(ids(searchFiles(FILES, 'SIGNATURE')), ['local:base.yml#1']);
	assert.deepEqual(ids(searchFiles(FILES, 'daniel')), ['local:base.yml#1']);
	assert.deepEqual(ids(searchFiles(FILES, 'ticket(')), ['local:base.yml#3']);
	assert.deepEqual(ids(searchFiles(FILES, 'zendesk')), ['local:base.yml#3']);
});

test('a query matches form, html and image path content', () => {
	assert.deepEqual(ids(searchFiles(FILES, '[[who]]')), ['local:base.yml#4']);
	assert.deepEqual(ids(searchFiles(FILES, '<b>bold')), ['local:base.yml#4']);
	assert.deepEqual(ids(searchFiles(FILES, 'logo.png')), ['local:base.yml#4']);
});

test('every word of the query must appear somewhere in the snippet', () => {
	assert.deepEqual(ids(searchFiles(FILES, 'best sig')), ['local:base.yml#1']);
	assert.deepEqual(ids(searchFiles(FILES, 'best goodbye')), []);
});

test('hits carry their source so results can be grouped and badged', () => {
	const [hit] = searchFiles(FILES, 'great day');
	assert.equal(hit.source, 'package');
	assert.equal(hit.package, 'goodbyes');
	assert.equal(hit.fileName, 'package.yml');
	assert.deepEqual(hit.match, FILES[1].matches[0]);
});

test('trigger hits rank ahead of content hits', () => {
	const files = [
		{
			id: 'local:a.yml',
			source: 'local',
			name: 'a.yml',
			matches: [
				{ trigger: ':x', replace: 'say hello' },
				{ trigger: ':hello', replace: 'x' },
			],
		},
	];
	assert.deepEqual(ids(searchFiles(files, 'hello')), ['local:a.yml#1', 'local:a.yml#0']);
});

test('a blank query returns nothing and files with errors are skipped', () => {
	assert.deepEqual(searchFiles(FILES, '   '), []);
	assert.deepEqual(ids(searchFiles(FILES, 'broken')), []);
});

test('results stop at the limit', () => {
	assert.equal(searchFiles(FILES, 'e', { limit: 2 }).length, 2);
});

// --- the closest matches to a sentence ------------------------------------------------------

const words = (text) => keywordsOf(text).map((item) => item.word);

test('a sentence finds what the plain search cannot', () => {
	assert.deepEqual(ids(searchFiles(FILES, 'Find my snippet for saying thanks')), []);
	assert.deepEqual(ids(likelyFiles(FILES, 'Find my snippet for saying thanks')), ['local:base.yml#2']);
});

test('the words of a request are not searched for, and a message of only those finds nothing', () => {
	assert.deepEqual(words('Please find my snippet for the'), []);
	assert.deepEqual(likelyFiles(FILES, 'Please find my snippet for the'), []);
	assert.deepEqual(likelyFiles(FILES, ''), []);
	assert.deepEqual(likelyFiles(FILES, undefined), []);
	assert.deepEqual(likelyFiles(FILES, 42), []);
});

test('words are lower-cased, lose the punctuation around them, and repeat once', () => {
	assert.deepEqual(words('"Refund," (REFUND) refund? Policy!'), ['refund', 'policy']);
});

test('a word that starts with a sign is kept whole, as a trigger would be', () => {
	const found = keywordsOf('What does ;Sig. do, and ":ticket"?');
	assert.deepEqual(
		found.map((item) => [item.word, item.sign, item.forms]),
		[
			[';sig', true, [';sig']],
			[':ticket', true, [':ticket']],
		]
	);
	assert.deepEqual(ids(likelyFiles(FILES, 'What does ;sig do?')), ['local:base.yml#1']);
});

test('signs alone, and words under three letters, are not words to search for', () => {
	assert.deepEqual(words('-> ... :) ok hi && ; "" ()'), []);
	assert.deepEqual(words(';m is short'), [';m', 'short']);
});

test('a word also counts in a shorter form', () => {
	const form = (text) => keywordsOf(text)[0].forms;
	assert.deepEqual(form('thanks'), ['thanks', 'thank']);
	assert.deepEqual(form('addresses'), ['addresses', 'addresse', 'address']);
	assert.deepEqual(form('replies'), ['replies', 'replie', 'repli', 'reply']);
	assert.deepEqual(form('meeting'), ['meeting', 'meet']);
	assert.deepEqual(form('delayed'), ['delayed', 'delay']);
	// A doubled letter before the ending is also tried single: "shipping" finds "ship".
	assert.deepEqual(form('shipping'), ['shipping', 'shipp', 'ship']);
	assert.deepEqual(form('stopped'), ['stopped', 'stopp', 'stop']);
	// Too short once cut, so it stays as it is.
	assert.deepEqual(form('bus'), ['bus']);
	assert.deepEqual(form('class'), ['class']);

	const files = [{ id: 'local:a.yml', source: 'local', name: 'a.yml', matches: [{ trigger: ':gr', replace: 'Thank you so much' }] }];
	assert.deepEqual(ids(searchFiles(files, 'thanks')), []);
	assert.deepEqual(ids(likelyFiles(files, 'my thanks message')), ['local:a.yml#0']);
});

test("a contraction is read as its first word", () => {
	assert.deepEqual(words("What's Daniel's signature, and why isn't it working?"), ['daniel', 'signature', 'working']);
	assert.deepEqual(words('What’s the manager’s number'), ['manager', 'number']);
});

test('at most twelve words are searched for, each cut at sixty characters', () => {
	const many = Array.from({ length: 40 }, (_, index) => `word${index}`).join(' ');
	assert.equal(keywordsOf(many).length, 12);
	assert.equal(words('x'.repeat(500))[0].length, 60);
});

const SHELF = [
	{
		id: 'local:replies.yml',
		source: 'local',
		name: 'replies.yml',
		matches: [
			{ trigger: ':one', replace: 'refund policy for late shipping to customers' },
			{ trigger: ':two', replace: 'refund policy' },
			{ trigger: ':three', replace: 'refund' },
			{ trigger: ':four', replace: 'nothing to do with it' },
		],
	},
];

test('a snippet is kept when it holds at least half of the words, the closest first', () => {
	const hits = likelyFiles(SHELF, 'refund policy late shipping');
	assert.deepEqual(ids(hits), ['local:replies.yml#0', 'local:replies.yml#1']);
	assert.deepEqual(hits.map((hit) => hit.matched), [4, 2]);
	// With three words, two are needed. With one, one.
	assert.deepEqual(ids(likelyFiles(SHELF, 'refund policy shipping')), ['local:replies.yml#0', 'local:replies.yml#1']);
	assert.deepEqual(ids(likelyFiles(SHELF, 'refund')), ['local:replies.yml#0', 'local:replies.yml#1', 'local:replies.yml#2']);
});

test('a word in a trigger counts most, then a label or search term, then the text', () => {
	const files = [
		{
			id: 'local:a.yml',
			source: 'local',
			name: 'a.yml',
			matches: [
				{ trigger: ':a', replace: 'my invoice is attached' },
				{ trigger: ':b', search_terms: ['invoice'], replace: 'x' },
				{ trigger: ':c', label: 'Invoice', replace: 'x' },
				{ trigger: ':invoice', replace: 'x' },
				{ regex: 'invoice(\\d+)', replace: 'x' },
			],
		},
	];
	const hits = likelyFiles(files, 'invoice');
	assert.deepEqual(ids(hits), ['local:a.yml#3', 'local:a.yml#4', 'local:a.yml#1', 'local:a.yml#2', 'local:a.yml#0']);
	assert.deepEqual(hits.map((hit) => hit.weight), [4, 4, 3, 3, 1]);
	assert.deepEqual(hits.map((hit) => hit.inTrigger), [true, true, false, false, false]);
});

test('a trigger named with its sign keeps a snippet, whatever else the message says', () => {
	const files = [
		{
			id: 'local:a.yml',
			source: 'local',
			name: 'a.yml',
			matches: [
				{ trigger: ':other', replace: 'right back at you, be seeing you' },
				{ trigger: ';brb', replace: 'One moment.' },
			],
		},
	];
	// Three words: ;brb, right, back. The first snippet holds two, the second one.
	assert.deepEqual(ids(likelyFiles(files, 'Add a snippet ;brb that expands to Be right back.')), ['local:a.yml#1', 'local:a.yml#0']);
	// Without the sign it is a word like any other, and one of three is not enough.
	assert.deepEqual(ids(likelyFiles(files, 'Add a snippet moment that expands to hello world')), []);
});

test("the person's own files come before team packages, and those before installed packages, when equally close", () => {
	const file = (id, source) => ({ id, source, name: 'f.yml', matches: [{ trigger: ':x', replace: 'out of office' }] });
	const files = [file('package:p:f.yml', 'package'), file('team:t:f.yml', 'team'), file('local:f.yml', 'local'), file('local:g.yml', 'local')];
	assert.deepEqual(ids(likelyFiles(files, 'office')), ['local:f.yml#0', 'local:g.yml#0', 'team:t:f.yml#0', 'package:p:f.yml#0']);
});

test('the closest matches stop at eight, or at the limit asked for', () => {
	const files = [{ id: 'local:a.yml', source: 'local', name: 'a.yml', matches: Array.from({ length: 30 }, (_, index) => ({ trigger: `:r${index}`, replace: 'refund' })) }];
	assert.equal(likelyFiles(files, 'refund').length, 8);
	assert.equal(likelyFiles(files, 'refund', { limit: 3 }).length, 3);
	assert.deepEqual(ids(likelyFiles(files, 'refund', { limit: 2 })), ['local:a.yml#0', 'local:a.yml#1']);
});

test('a hit is shaped as a plain search hit is, and a file with errors is skipped', () => {
	const [hit] = likelyFiles(FILES, 'a great day to all');
	assert.deepEqual(
		{ fileId: hit.fileId, fileName: hit.fileName, source: hit.source, package: hit.package, index: hit.index },
		{ fileId: 'package:goodbyes:package.yml', fileName: 'package.yml', source: 'package', package: 'goodbyes', index: 0 }
	);
	assert.deepEqual(hit.match, FILES[1].matches[0]);
	assert.deepEqual(likelyFiles([{ id: 'local:broken.yml', source: 'local', name: 'broken.yml', matches: null }], 'broken'), []);
	assert.deepEqual(likelyFiles([{ id: 'local:odd.yml', source: 'local', name: 'odd.yml', matches: [null, 'text', 7, ['x'], { trigger: ':ok', replace: 'broken' }] }], 'broken').map((item) => item.index), [4]);
});

test('signs that mean something to a pattern are searched for as written', () => {
	assert.deepEqual(ids(likelyFiles(FILES, ':ticket(\\d+) and (.*)+$ ^[a-')), ['local:base.yml#3']);
});

test('a long message, and a large library, are searched quickly', () => {
	const files = Array.from({ length: 60 }, (_, f) => ({
		id: `local:f${f}.yml`,
		source: 'local',
		name: `f${f}.yml`,
		matches: Array.from({ length: 150 }, (_, i) => ({ trigger: `:t${f}x${i}`, label: `Reply ${i}`, replace: `Thanks for writing in about order ${i}. We will look into it and come back to you within two working days.` })),
	}));
	const began = Date.now();
	assert.equal(likelyFiles(files, 'Find the reply about an order that says we come back within two working days').length, 8);
	assert.deepEqual(likelyFiles(files, `${'a'.repeat(20_000)} ${'((((('.repeat(2000)}`), []);
	assert.deepEqual(likelyFiles(files, Array.from({ length: 5000 }, (_, index) => `zz${index}qq`).join(' ')), []);
	assert.ok(Date.now() - began < 1000, `took ${Date.now() - began} ms`);
});

test('one enormous word made to be slow to trim is not slow', () => {
	const began = Date.now();
	for (const sign of ['(', ')', '.', '’', "'"]) {
		// Only the start of such a word is looked at.
		assert.deepEqual(words(`a${sign.repeat(19_998)}a`), []);
		assert.deepEqual(words(`;${sign.repeat(19_998)}a`), []);
		assert.deepEqual(words(`${sign.repeat(19_998)}n't`), []);
		assert.deepEqual(words(`refund${sign.repeat(19_998)}n't`), ['refund']);
	}
	assert.ok(Date.now() - began < 200, `took ${Date.now() - began} ms`);
});
