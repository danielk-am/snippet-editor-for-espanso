import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchFiles } from '../shared/search.js';

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
