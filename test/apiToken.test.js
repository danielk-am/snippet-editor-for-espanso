import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadToken, replaceToken, tokensMatch } from '../core/apiToken.js';

const file = () => join(mkdtempSync(join(tmpdir(), 'snippet-editor-token-')), 'data', 'api-token');

test('the first load makes a 64-character token and saves it for the owner only', async () => {
	const path = file();
	const token = await loadToken(path);
	assert.match(token, /^[a-f0-9]{64}$/);
	assert.equal(readFileSync(path, 'utf8').trim(), token);
	if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600);
});

test('later loads return the same token', async () => {
	const path = file();
	assert.equal(await loadToken(path), await loadToken(path));
});

test('a damaged token file is replaced with a fresh token', async () => {
	const path = file();
	await loadToken(path);
	writeFileSync(path, 'short');
	const token = await loadToken(path);
	assert.match(token, /^[a-f0-9]{64}$/);
	assert.equal(readFileSync(path, 'utf8').trim(), token);
});

test('replacing the token gives a different one, and the old one no longer matches', async () => {
	const path = file();
	const before = await loadToken(path);
	const after = await replaceToken(path);
	assert.notEqual(after, before);
	assert.equal(await loadToken(path), after);
	assert.equal(tokensMatch(before, after), false);
});

test('tokens match only when they are the same text', () => {
	const token = 'a'.repeat(64);
	assert.equal(tokensMatch(token, token), true);
	assert.equal(tokensMatch('b'.repeat(64), token), false);
	assert.equal(tokensMatch('a'.repeat(63), token), false);
	assert.equal(tokensMatch('', token), false);
	for (const given of [undefined, null, 123, {}]) assert.equal(tokensMatch(given, token), false);
});
