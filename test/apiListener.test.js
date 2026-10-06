import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createListenerControl } from '../core/apiListener.js';
import { createRouter } from '../core/apiRouter.js';
import { createService } from '../core/service.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/match', import.meta.url));

function sparePort() {
	return new Promise((resolve) => {
		const probe = net.createServer();
		probe.listen(0, '127.0.0.1', () => {
			const { port } = probe.address();
			probe.close(() => resolve(port));
		});
	});
}

async function setup(t) {
	const root = mkdtempSync(join(tmpdir(), 'snippet-editor-listener-'));
	const matchDir = join(root, 'match');
	cpSync(FIXTURES, matchDir, { recursive: true });
	const service = await createService({ userDataDir: join(root, 'data'), env: { SNIPPET_EDITOR_MATCH_DIR: matchDir } });
	const listener = createListenerControl({ service, router: createRouter({ service }) });
	t.after(async () => {
		await listener.stop();
		service.dispose();
	});
	const token = () => readFileSync(service.tokenFile, 'utf8').trim();
	const get = (port, bearer) => fetch(`http://127.0.0.1:${port}/api/v1/state`, { headers: bearer ? { Authorization: `Bearer ${bearer}` } : {} });
	return { service, listener, token, get, port: await sparePort() };
}

test('the listener is off until it is switched on', async (t) => {
	const { listener, service, get, port } = await setup(t);
	assert.deepEqual(await listener.status(), { enabled: false, running: false, port: 27187, address: 'http://127.0.0.1:27187/api/v1', problem: '' });
	// Checked on a spare port, so a copy of the app already running on this
	// computer cannot answer for it.
	await service.saveSettings({ apiPort: port });
	await listener.apply();
	assert.equal((await listener.status()).running, false);
	await assert.rejects(get(port));
});

test('switching it on starts it on the chosen port, and the choice is remembered', async (t) => {
	const { listener, service, token, get, port } = await setup(t);
	const status = await listener.set({ enabled: true, port });
	assert.deepEqual(status, { enabled: true, running: true, port, address: `http://127.0.0.1:${port}/api/v1`, problem: '' });
	assert.deepEqual([service.settings().apiEnabled, service.settings().apiPort], [true, port]);
	assert.equal((await get(port)).status, 401);
	const reply = await get(port, token());
	assert.equal(reply.status, 200);
	assert.equal((await reply.json()).files.length, 4);
});

test('the status never carries the token', async (t) => {
	const { listener, token, port } = await setup(t);
	const status = await listener.set({ enabled: true, port });
	assert.ok(!JSON.stringify(status).includes(token()));
});

test('what can be copied is the token, or a curl line that uses it', async (t) => {
	const { listener, token, port } = await setup(t);
	await listener.set({ enabled: true, port });
	assert.equal(await listener.textToCopy('token'), token());
	assert.equal(await listener.textToCopy('curl'), `curl -H "Authorization: Bearer ${token()}" http://127.0.0.1:${port}/api/v1/state`);
	await assert.rejects(listener.textToCopy('other'), (error) => error.code === 'INVALID');
});

test('switching it off closes the port', async (t) => {
	const { listener, get, token, port } = await setup(t);
	await listener.set({ enabled: true, port });
	const status = await listener.set({ enabled: false, port });
	assert.deepEqual([status.enabled, status.running], [false, false]);
	await assert.rejects(get(port, token()));
});

test('switching it on and off in quick succession ends in the state asked for last', async (t) => {
	const { service, token, get, port } = await setup(t);
	// The first save is slow, as a busy disk would make it, so without care
	// the "off" that was asked for second would finish first and be undone.
	let first = true;
	const slow = {
		...service,
		async saveSettings(patch) {
			if (first) {
				first = false;
				await new Promise((resolve) => setTimeout(resolve, 60));
			}
			return service.saveSettings(patch);
		},
	};
	const listener = createListenerControl({ service: slow, router: createRouter({ service }) });
	t.after(() => listener.stop());
	const replies = await Promise.all([listener.set({ enabled: true, port }), listener.set({ enabled: false, port })]);
	assert.deepEqual(replies.map((reply) => reply.running), [true, false]);
	assert.deepEqual([(await listener.status()).running, service.settings().apiEnabled], [false, false]);
	await assert.rejects(get(port, token()));
});

test('a port already in use is reported, and the app carries on', async (t) => {
	const { listener, service, port } = await setup(t);
	const blocker = net.createServer();
	await new Promise((resolve) => blocker.listen(port, '127.0.0.1', resolve));
	t.after(() => blocker.close());
	const status = await listener.set({ enabled: true, port });
	assert.deepEqual([status.enabled, status.running, status.problem], [true, false, `Port ${port} is in use.`]);
	assert.equal((await service.state()).files.length, 4);
});

test('a token that cannot be saved is reported, and the app carries on', async (t) => {
	const { listener, service, get, port } = await setup(t);
	// A folder where the token file should be: it can be neither read nor written.
	mkdirSync(service.tokenFile, { recursive: true });
	const status = await listener.set({ enabled: true, port });
	assert.deepEqual(status, {
		enabled: true,
		running: false,
		port,
		address: `http://127.0.0.1:${port}/api/v1`,
		problem: 'The API token could not be saved, so the API is not running.',
	});
	await assert.rejects(get(port));
	assert.equal((await service.state()).files.length, 4);
});

test('replacing the token locks out the old one', async (t) => {
	const { listener, token, get, port } = await setup(t);
	await listener.set({ enabled: true, port });
	const old = token();
	await listener.replaceToken();
	assert.notEqual(token(), old);
	assert.equal((await get(port, old)).status, 401);
	assert.equal((await get(port, token())).status, 200);
});

test('a port that is not a whole number from 1024 to 65535 is refused', async (t) => {
	const { listener, service } = await setup(t);
	for (const port of [80, 70000, 2.5, '8080', undefined]) {
		await assert.rejects(listener.set({ enabled: true, port }), (error) => error.code === 'INVALID', String(port));
	}
	await assert.rejects(listener.set({ enabled: 'yes', port: 30000 }), (error) => error.code === 'INVALID');
	assert.equal(service.settings().apiEnabled, false);
});

// --- added after review ---------------------------------------------------------

test('the token file is read again at every start', async (t) => {
	const { listener, service, token, get, port } = await setup(t);
	await listener.set({ enabled: true, port });
	const first = token();

	// Deleted while the listener was off: a new one is made, and the old one is dead.
	await listener.set({ enabled: false, port });
	rmSync(service.tokenFile);
	await listener.set({ enabled: true, port });
	const second = token();
	assert.notEqual(second, first);
	assert.equal((await get(port, first)).status, 401);
	assert.equal((await get(port, second)).status, 200);

	// Put there by hand: that is the token from the next start on.
	await listener.set({ enabled: false, port });
	const mine = 'd'.repeat(64);
	writeFileSync(service.tokenFile, mine + '\n');
	await listener.set({ enabled: true, port });
	assert.equal((await get(port, second)).status, 401);
	assert.equal((await get(port, mine)).status, 200);
	assert.equal(await listener.textToCopy('token'), mine);
});

test('nothing the control hands back carries the token', async (t) => {
	const { listener, token, port } = await setup(t);
	const results = [await listener.set({ enabled: true, port }), await listener.status(), await listener.apply()];
	const before = token();
	results.push(await listener.replaceToken());
	const after = token();
	results.push(await listener.status(), await listener.set({ enabled: false, port }));
	const text = JSON.stringify(results);
	assert.ok(!text.includes(before) && !text.includes(after));
	assert.deepEqual(Object.keys(results[3]).sort(), ['address', 'enabled', 'port', 'problem', 'running']);
});

test('changing the port closes the old one', async (t) => {
	const { listener, token, get, port } = await setup(t);
	const other = await sparePort();
	await listener.set({ enabled: true, port });
	const status = await listener.set({ enabled: true, port: other });
	assert.deepEqual([status.running, status.port, status.address], [true, other, `http://127.0.0.1:${other}/api/v1`]);
	await assert.rejects(get(port, token()));
	assert.equal((await get(other, token())).status, 200);
});
