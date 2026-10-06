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

async function gone(pid, within = 5000) {
	const until = Date.now() + within;
	while (Date.now() < until) {
		if (!alive(pid)) return true;
		await wait(25);
	}
	return false;
}

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
	const lines = [];
	const started = createRunner().run({ ...program(code), onLine: (line) => lines.push(line), idleMs: 400, totalMs: 20_000 });
	const result = await started.done;
	assert.equal(result.reason, 'idle');
	const { self, child } = JSON.parse(lines[0]);
	assert.equal(await gone(self), true, 'the program is still running');
	if (process.platform !== 'win32') assert.equal(await gone(child), true, 'what it started is still running');
});

test('a program that keeps talking is stopped when its whole time is up', async () => {
	const { result, lines } = await collect(createRunner(), program(`setInterval(() => console.log('still here'), 40);`, { idleMs: 5000, totalMs: 400 }));
	assert.equal(result.reason, 'total');
	assert.ok(lines.length >= 3);
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
