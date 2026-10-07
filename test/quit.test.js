import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as wait } from 'node:timers/promises';
import { quitWhenDisposed } from '../electron/quit.js';

// Electron's app, as far as quitting goes: 'will-quit' can be held back, and
// quit() asks again. One rule of the real one matters: while it is telling
// 'will-quit' it takes no notice of another quit. That lasts until the call
// into the listener has fully returned, which is after every promise already
// settled has run its callbacks. A quit asked for there is lost, silently.
function fakeApp(onGone = () => {}) {
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
			if (!held) {
				app.gone = true;
				onGone();
			}
		},
	};
	return app;
}

// Until what a quit sets going has run. That takes turns of the event loop,
// not a length of time: nothing in it waits on a clock. A short sleep here
// would be a race. On a busy machine ten milliseconds can pass before the
// loop has taken its next turn, and the check would then come too soon.
async function settled() {
	for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setImmediate(resolve));
}

// Until something has happened. The wait is long because it only matters when
// the thing never happens: what has happened is seen at the next look.
async function until(happened, what, within = 30_000) {
	const end = Date.now() + within;
	while (!happened()) {
		if (Date.now() > end) throw new Error(`Still waiting for ${what}.`);
		await wait(5);
	}
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
	await settled();
	assert.deepEqual([app.gone, disposed], [true, 1]);
});

test('stopping things has a time limit, so the app always goes', async () => {
	// Two apps whose stopping never ends, one with a short limit and one with a
	// limit ten times as long. What is checked is the order they go in, and
	// that neither goes before its limit: never that a wait was short enough.
	// On a busy machine a timer can be late by any amount. It is not early, and
	// the one due first is still told first.
	const SHORT = 150;
	const LONG = 1500;
	const went = [];
	const began = Date.now();
	const patient = fakeApp(() => went.push({ limit: LONG, after: Date.now() - began, otherGone: hasty.gone }));
	const hasty = fakeApp(() => went.push({ limit: SHORT, after: Date.now() - began, otherGone: patient.gone }));
	quitWhenDisposed({ app: patient, dispose: () => new Promise(() => {}), deadline: LONG });
	quitWhenDisposed({ app: hasty, dispose: () => new Promise(() => {}), deadline: SHORT });
	// The one with the long limit is asked first. Were the limit given not the
	// one kept, it would also be the first to go.
	patient.quit();
	hasty.quit();
	assert.deepEqual([patient.gone, hasty.gone], [false, false]);
	await until(() => patient.gone && hasty.gone, 'both apps to go');
	assert.deepEqual(went.map((one) => [one.limit, one.otherGone]), [[SHORT, false], [LONG, true]]);
	// A timer may be a few milliseconds early by this clock, as the test allowed before.
	for (const one of went) assert.ok(one.after >= one.limit - 10, `the app with a limit of ${one.limit} ms went after ${one.after} ms`);
});

test('a fault while stopping things does not keep the app open, and is logged', async () => {
	const logged = [];
	for (const dispose of [() => Promise.reject(new Error('could not stop')), () => { throw new Error('could not stop'); }]) {
		const app = fakeApp();
		quitWhenDisposed({ app, dispose, log: (error) => logged.push(error.message) });
		app.quit();
		await settled();
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
	await settled();
	assert.deepEqual([app.gone, app.relaunches], [true, 1]);
	// Asked to come back before it is asked to go, or it would not come back at all.
	assert.deepEqual(app.asked.slice(-2), ['relaunch', 'quit']);
});

test('an app nobody asked for again goes and stays gone', async () => {
	const app = fakeApp();
	const leaving = quitWhenDisposed({ app, dispose: async () => {} });
	assert.equal(leaving.mayOpen(), true);
	app.quit();
	await settled();
	assert.deepEqual([app.gone, app.relaunches], [true, 0]);
});

test('asked for in its last moment, when everything is already stopped, it still comes back, once', async () => {
	const app = fakeApp();
	const leaving = quitWhenDisposed({ app, dispose: async () => {} });
	app.quit();
	await settled();
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
		await settled();
		assert.equal(app.gone, true);
	}
});
