import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as wait } from 'node:timers/promises';
import { quitWhenDisposed } from '../electron/quit.js';

// Electron's app, as far as quitting goes: 'will-quit' can be held back, and
// quit() asks again.
function fakeApp() {
	const listeners = [];
	const app = {
		quits: 0,
		gone: false,
		on(name, listener) {
			if (name === 'will-quit') listeners.push(listener);
		},
		quit() {
			app.quits += 1;
			let held = false;
			for (const listener of listeners) listener({ preventDefault: () => (held = true) });
			if (!held) app.gone = true;
		},
	};
	return app;
}

test('the app does not go until what it started has been stopped', async () => {
	const app = fakeApp();
	let finish;
	let disposed = 0;
	quitWhenDisposed({
		app,
		dispose: () => {
			disposed += 1;
			return new Promise((resolve) => (finish = resolve));
		},
	});
	app.quit();
	assert.deepEqual([app.gone, disposed], [false, 1]);
	// Asked again while it is still stopping things: still held, and nothing is stopped twice.
	app.quit();
	assert.deepEqual([app.gone, disposed], [false, 1]);
	finish();
	await wait(10);
	assert.deepEqual([app.gone, disposed], [true, 1]);
});

test('stopping things has a time limit, so the app always goes', async () => {
	const app = fakeApp();
	quitWhenDisposed({ app, dispose: () => new Promise(() => {}), deadline: 150 });
	const began = Date.now();
	app.quit();
	assert.equal(app.gone, false);
	while (!app.gone && Date.now() - began < 2000) await wait(10);
	assert.equal(app.gone, true);
	assert.ok(Date.now() - began >= 140);
});

test('a fault while stopping things does not keep the app open, and is logged', async () => {
	const logged = [];
	for (const dispose of [() => Promise.reject(new Error('could not stop')), () => { throw new Error('could not stop'); }]) {
		const app = fakeApp();
		quitWhenDisposed({ app, dispose, log: (error) => logged.push(error.message) });
		app.quit();
		await wait(10);
		assert.equal(app.gone, true);
	}
	assert.deepEqual(logged, ['could not stop', 'could not stop']);
});
