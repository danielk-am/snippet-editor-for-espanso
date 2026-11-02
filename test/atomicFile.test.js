import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { atomicFile } from '../core/atomicFile.js';
import { loadSettings, saveSettings } from '../core/settings.js';

test('a disk-full write leaves the prior settings readable, cleans staging and does not poison the queue', async (t) => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snippet-atomic-'));
	t.after(() => fs.rm(dir, { recursive: true, force: true }));
	const file = path.join(dir, 'settings.json');
	await saveSettings(file, { maxBackups: 7 });
	const originalOpen = fs.open;
	const mock = t.mock.method(fs, 'open', async (...args) => {
		const handle = await originalOpen(...args);
		handle.writeFile = async () => { throw Object.assign(new Error('Disk full'), { code: 'ENOSPC' }); };
		return handle;
	});
	await assert.rejects(saveSettings(file, { maxBackups: 9 }), { code: 'ENOSPC' });
	mock.mock.restore();
	assert.equal((await loadSettings(file)).maxBackups, 7);
	assert.deepEqual((await fs.readdir(dir)).sort(), ['settings.json', 'settings.json.last-good']);
	await saveSettings(file, { apiPort: 30001 });
	assert.equal((await loadSettings(file)).apiPort, 30001);
	await atomicFile(path.join(dir, 'x'), 'complete');
	assert.equal(await fs.readFile(path.join(dir, 'x'), 'utf8'), 'complete');
});
