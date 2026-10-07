import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as wait } from 'node:timers/promises';
import { quitWhenDisposed } from '../electron/quit.js';

// Electron's app, as far as quitting goes: 'will-quit' can be held back, and
// quit() asks again. One rule of the real one matters: while it is telling
// 'will-quit' it takes no notice of another quit. That lasts until the call
// into the listener has fully returned, which is after every promise already
// settled has run its callbacks. A quit asked for there is lost, silently.
function fakeApp() {
	const listeners = [];
	let telling = false;
	const app = {
		quits: 0,
		gone: false,
		relaunches: 0,
		// What it was asked to do, in order.
		asked: [],
		relaunch() {
			app.relaunches += 1;
			app.asked.push('relaunch');
		},
		on(name, listener) {
			if (name === 'will-quit') listeners.push(listener);
		},
		quit() {
			app.quits += 1;
			app.asked.push('quit');
			if (telling) return;
			telling = true;
			setImmediate(() => (telling = false));
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

test('while it is closing no window may open, and asking for one brings the app back once it has gone', async () => {
	const app = fakeApp();
	let finish;
	const leaving = quitWhenDisposed({ app, dispose: () => new Promise((resolve) => (finish = resolve)) });
	// Open: a window may open, and nothing is remembered.
	assert.equal(leaving.mayOpen(), true);
	app.quit();
	// Closing: what a window would talk to has been stopped. Asked twice, it comes back once.
	assert.equal(leaving.mayOpen(), false);
	assert.equal(leaving.mayOpen(), false);
	assert.deepEqual([app.gone, app.relaunches], [false, 0]);
	finish();
	await wait(10);
	assert.deepEqual([app.gone, app.relaunches], [true, 1]);
	// Asked to come back before it is asked to go, or it would not come back at all.
	assert.deepEqual(app.asked.slice(-2), ['relaunch', 'quit']);
});

test('an app nobody asked for again goes and stays gone', async () => {
	const app = fakeApp();
	const leaving = quitWhenDisposed({ app, dispose: async () => {} });
	assert.equal(leaving.mayOpen(), true);
	app.quit();
	await wait(10);
	assert.deepEqual([app.gone, app.relaunches], [true, 0]);
});

test('asked for in its last moment, when everything is already stopped, it still comes back, once', async () => {
	const app = fakeApp();
	const leaving = quitWhenDisposed({ app, dispose: async () => {} });
	app.quit();
	await wait(10);
	assert.equal(leaving.mayOpen(), false);
	assert.equal(leaving.mayOpen(), false);
	assert.equal(app.relaunches, 1);
});

test('with nothing to wait for, the app still goes: the last quit is not asked for while Electron is not listening', async () => {
	// Nothing to stop, or all of it stopped without waiting: the usual case.
	for (const dispose of [() => {}, async () => {}, () => Promise.resolve()]) {
		const app = fakeApp();
		quitWhenDisposed({ app, dispose });
		app.quit();
		await wait(20);
		assert.equal(app.gone, true);
	}
});
