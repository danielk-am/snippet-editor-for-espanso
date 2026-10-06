import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CHANNELS, EVENTS } from '../shared/channels.js';

const preload = readFileSync(new URL('../electron/preload.cjs', import.meta.url), 'utf8');
const ipc = readFileSync(new URL('../electron/ipc.js', import.meta.url), 'utf8');

function listIn(source, name) {
	const body = source.match(new RegExp(`const ${name} = new Set\\(\\[([^\\]]*)\\]\\)`));
	assert.ok(body, `${name} list not found in preload.cjs`);
	return [...body[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

test('the preload allows exactly the channels the app declares', () => {
	assert.deepEqual(listIn(preload, 'CHANNELS').sort(), [...CHANNELS].sort());
	assert.deepEqual(listIn(preload, 'EVENTS').sort(), [...EVENTS].sort());
});

test('every declared channel has a handler in the main process', () => {
	const handled = [...ipc.matchAll(/handle\(\s*'([^']+)'/g)].map((m) => m[1]);
	assert.deepEqual(handled.sort(), [...CHANNELS].sort());
});
