import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { createRunner } from '../core/chat/run.js';

// A small program, run by this same node.
const program = (code, extra = {}) => ({ program: process.execPath, args: ['-e', code], ...extra });

async function collect(runner, options) {
	const lines = [];
	const started = runner.run({ onLine: (line) => lines.push(line), ...options });
	return { lines, started, result: await started.done };
}

const alive = (pid) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

// Waits for a program to have gone. The wait is long because it only matters
// when the program has not gone: one that has is seen at the next look.
async function gone(pid, within = 30_000) {
	const until = Date.now() + within;
	while (Date.now() < until) {
		if (!alive(pid)) return true;
		await wait(25);
	}
	return false;
}

// How long this machine takes, as busy as it is at this moment, to start a
// node, hear its one line and see it end.
async function startUp() {
	const began = performance.now();
	await collect(createRunner(), program(`console.log('up')`));
	return performance.now() - began;
}

// The two time limits of a test: a short one that is meant to end the program,
// and a long one that must not. Neither is a fixed number, because a fixed
// number is too short for a busy machine or too slow for a quiet one.
//   short  ten start-ups, and two seconds at the least, so a program that is
//          slow to start is not taken for one that ran out of time
//   long   ten times the short one, so the two cannot be mistaken for each
//          other, however late a timer is
async function limits() {
	const short = Math.max(2000, Math.ceil(10 * (await startUp())));
	return { short, long: 10 * short };
}

// A timer is never early by more than a millisecond or two, however busy the
// machine is. Late it can be by any amount.
const EARLY = 50;

test('lines arrive whole, however the output is cut into pieces', async () => {
	const code = `
		const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
		const e = Buffer.from('é');
		(async () => {
			process.stdout.write('ab'); await pause(30);
			process.stdout.write('c\\nde\\r\\n'); await pause(30);
			process.stdout.write(Buffer.concat([Buffer.from('caf'), e.subarray(0, 1)])); await pause(30);
			process.stdout.write(Buffer.concat([e.subarray(1), Buffer.from('\\n\\nlast')]));
		})();`;
	const { lines, result } = await collect(createRunner(), program(code));
	assert.deepEqual(lines, ['abc', 'de', 'café', '', 'last']);
	assert.deepEqual(result, { reason: 'exit', code: 0, stderrTail: '' });
});

test('the input goes in on standard input and is not on the command line, and the folder and environment are the ones given', async () => {
	const cwd = mkdtempSync(join(tmpdir(), 'snippet-editor-run-'));
	const code = `
		let input = '';
		process.stdin.setEncoding('utf8');
		process.stdin.on('data', (chunk) => (input += chunk));
		process.stdin.on('end', () => console.log(JSON.stringify({ input, argv: process.argv.slice(1), cwd: process.cwd(), marker: process.env.RUN_MARKER, home: typeof process.env.PATH })));`;
	const secret = 'a private message\nwith two lines';
	const { lines, result } = await collect(createRunner(), program(code, { input: secret, cwd, env: { ...process.env, RUN_MARKER: 'set' } }));
	const seen = JSON.parse(lines[0]);
	assert.equal(seen.input, secret);
	assert.ok(!JSON.stringify(seen.argv).includes('private message'));
	assert.match(seen.cwd, /snippet-editor-run-/);
	assert.deepEqual([seen.marker, seen.home], ['set', 'string']);
	assert.equal(result.reason, 'exit');
});

test('a program that is not there is "missing", and one that cannot be started says why', async () => {
	const { lines, result } = await collect(createRunner(), { program: join(tmpdir(), 'no-such-program-here'), args: [] });
	assert.deepEqual([lines, result.reason, result.code], [[], 'missing', null]);
	const notAProgram = await collect(createRunner(), { program: tmpdir(), args: [] });
	assert.equal(notAProgram.result.reason, 'failed');
});

test('a program that ends with an error gives its code and its last words, not all of them', async () => {
	const code = `process.stderr.write('x'.repeat(3000) + ' the last words\\n'); process.exit(3);`;
	const { result } = await collect(createRunner(), program(code));
	assert.deepEqual([result.reason, result.code], ['exit', 3]);
	assert.equal(result.stderrTail.length, 500);
	assert.ok(result.stderrTail.endsWith('the last words'));
});

test('a program that goes silent is stopped, together with what it started', async () => {
	const code = `
		const { spawn } = require('node:child_process');
		const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
		console.log(JSON.stringify({ self: process.pid, child: child.pid }));
		setInterval(() => {}, 1000);`;
	const { short, long } = await limits();
	const lines = [];
	const began = performance.now();
	const started = createRunner().run({ ...program(code), onLine: (line) => lines.push(line), idleMs: short, totalMs: long });
	const result = await started.done;
	const ran = performance.now() - began;
	assert.equal(result.reason, 'idle');
	// It said its one line, so it was running, and then nothing.
	assert.equal(lines.length, 1);
	// It was the silence that ended it: that limit had passed, and the whole time was nowhere near up.
	assert.ok(ran >= short - EARLY, `stopped after ${Math.round(ran)} ms, before ${short} ms of silence could have passed`);
	assert.ok(ran < long, `stopped after ${Math.round(ran)} ms, which is its whole time of ${long} ms and not ${short} ms of silence`);
	const { self, child } = JSON.parse(lines[0]);
	assert.equal(await gone(self), true, 'the program is still running');
	if (process.platform !== 'win32') assert.equal(await gone(child), true, 'what it started is still running');
});

test('a program that keeps talking is stopped when its whole time is up', async () => {
	const { short, long } = await limits();
	const began = performance.now();
	const { result, lines } = await collect(createRunner(), program(`setInterval(() => console.log('still here'), 40);`, { idleMs: long, totalMs: short }));
	const ran = performance.now() - began;
	assert.equal(result.reason, 'total');
	assert.ok(lines.length >= 3);
	// It was its whole time that ended it: that much time had passed, and far less than the silence it was allowed.
	assert.ok(ran >= short - EARLY, `stopped after ${Math.round(ran)} ms, before its whole time of ${short} ms was up`);
	assert.ok(ran < long, `stopped after ${Math.round(ran)} ms, which is the ${long} ms it may be silent and not its whole time of ${short} ms`);
});

test('more output than allowed stops it, and so does one line with no end', async () => {
	const flood = await collect(createRunner(), program(`setInterval(() => console.log('y'.repeat(1000)), 5);`, { maxBytes: 20_000 }));
	assert.equal(flood.result.reason, 'too-much');
	assert.ok(flood.lines.length <= 20);
	const endless = await collect(createRunner(), program(`setInterval(() => process.stdout.write('z'.repeat(1000)), 5);`, { maxLine: 10_000, maxBytes: 10_000_000 }));
	assert.equal(endless.result.reason, 'too-much');
	assert.deepEqual(endless.lines, []);
});

test('stop() ends it and says so, and stopping twice or after the end is fine', async () => {
	const lines = [];
	const started = createRunner().run({ ...program(`console.log(process.pid); setInterval(() => console.log('tick'), 30);`), onLine: (line) => lines.push(line) });
	while (!lines.length) await wait(10);
	started.stop();
	started.stop();
	const result = await started.done;
	assert.equal(result.reason, 'stopped');
	assert.equal(await gone(Number(lines[0])), true);
	started.stop();
});

test('a program that ignores a polite stop is stopped anyway', { skip: process.platform === 'win32' }, async () => {
	const lines = [];
	const started = createRunner({ grace: 200 }).run({ ...program(`process.on('SIGTERM', () => {}); console.log(process.pid); setInterval(() => {}, 1000);`), onLine: (line) => lines.push(line) });
	while (!lines.length) await wait(10);
	started.stop();
	assert.equal((await started.done).reason, 'stopped');
	assert.equal(await gone(Number(lines[0])), true);
});

test('stopAll() ends every program under way, and only those', async () => {
	const runner = createRunner();
	const quick = await collect(runner, program(`console.log('done')`));
	assert.equal(quick.result.reason, 'exit');
	const running = [1, 2].map(() => runner.run({ ...program(`setInterval(() => {}, 1000)`), onLine: () => {} }));
	runner.stopAll();
	assert.deepEqual((await Promise.all(running.map((one) => one.done))).map((result) => result.reason), ['stopped', 'stopped']);
	runner.stopAll();
});

test('shutDown() stops every program at once, even one that ignores a polite stop, and starts no more', { skip: process.platform === 'win32' }, async () => {
	// A long wait after a polite stop: the app closing must not sit through it.
	// The wait is ten times what closing is allowed, so a busy machine that is
	// slow to end a program is not taken for an app that sat the wait out.
	const { short, long } = await limits();
	const runner = createRunner({ grace: long });
	const lines = [];
	const stubborn = runner.run({ ...program(`process.on('SIGTERM', () => {}); console.log(process.pid); setInterval(() => {}, 1000);`), onLine: (line) => lines.push(line) });
	while (!lines.length) await wait(10);
	// Already asked politely, and taking no notice.
	stubborn.stop();
	const began = Date.now();
	runner.shutDown();
	assert.equal((await stubborn.done).reason, 'stopped');
	const took = Date.now() - began;
	assert.ok(took < short, `it took ${took} ms, and the wait after a polite stop is ${long} ms`);
	assert.equal(await gone(Number(lines[0])), true);
	// Nothing is started after that.
	const late = await collect(runner, program(`console.log('ran')`));
	assert.deepEqual([late.result.reason, late.lines], ['stopped', []]);
	runner.shutDown();
});

test('a fault in the reader of the lines stops the program instead of the app', async () => {
	const started = createRunner().run({
		...program(`setInterval(() => console.log('line'), 20);`),
		onLine: () => {
			throw new Error('reader broke');
		},
	});
	const result = await started.done;
	assert.deepEqual([result.reason, result.stderrTail], ['failed', 'reader broke']);
});

// A helper the program starts, which heeds neither a polite stop nor its input closing.
const STUBBORN = `
	const { spawn } = require('node:child_process');
	const helper = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore' });
	console.log(helper.pid);
`;

test('what the program started does not outlive it, whether the program was stopped or ended by itself', { skip: process.platform === 'win32' }, async () => {
	// Stopped.
	const lines = [];
	const stopped = createRunner({ grace: 200 }).run({ ...program(`${STUBBORN} setInterval(() => {}, 1000);`), onLine: (line) => lines.push(line) });
	while (!lines.length) await wait(10);
	stopped.stop();
	assert.equal((await stopped.done).reason, 'stopped');
	assert.equal(await gone(Number(lines[0])), true, 'the helper outlived a stop');

	// Ended by itself, leaving the helper behind.
	const left = await collect(createRunner(), program(`${STUBBORN} setTimeout(() => process.exit(0), 200);`));
	assert.equal(left.result.reason, 'exit');
	assert.equal(await gone(Number(left.lines[0])), true, 'the helper outlived the program');
});

test('once it is stopped, nothing more it prints is handed over', async () => {
	const lines = [];
	let stoppedAt = null;
	const started = createRunner().run({
		...program(`setInterval(() => { for (let i = 0; i < 50; i += 1) console.log('line'); }, 1);`),
		onLine: (line) => {
			lines.push(line);
			if (lines.length === 5 && stoppedAt === null) {
				started.stop();
				stoppedAt = lines.length;
			}
		},
	});
	await started.done;
	assert.equal(lines.length, stoppedAt);
});
