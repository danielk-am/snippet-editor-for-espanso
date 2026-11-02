import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDraftStorage } from '../renderer/lib/draftStorage.js';

function storage() {
	const values = new Map();
	return { getItem: (k) => values.get(k) ?? null, setItem: (k, v) => values.set(k, v), removeItem: (k) => values.delete(k) };
}
test('drafts preserve invalid YAML text and original versions, scoped to the match folder', () => {
	const drafts = createDraftStorage(storage());
	const record = { route: { view: 'snippet', fileId: 'local:base.yml', index: 0 }, kind: 'snippet', value: { version: 'old', draft: { content: 'edited' }, raw: { extras: '[' } } };
	drafts.write('/one/match', record);
	assert.deepEqual(drafts.read('/one/match'), record);
	assert.equal(drafts.read('/two/match'), null);
	drafts.clear('/one/match');
	assert.equal(drafts.read('/one/match'), null);
});
test('unavailable draft storage and malformed records are surfaced without overwriting a good record', () => {
	const disk = storage();
	const drafts = createDraftStorage(disk);
	drafts.write('/match', { kind: 'raw', route: { view: 'file', fileId: 'local:a.yml', tab: 'raw' }, value: { text: '[' } });
	const cyclic = {}; cyclic.self = cyclic;
	assert.throws(() => drafts.write('/match', cyclic));
	assert.equal(drafts.read('/match').value.text, '[');
	assert.throws(() => createDraftStorage({ getItem() { throw new Error('blocked'); } }).read('/match'), /blocked/);
});
