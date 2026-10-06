import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os, { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitError, createGit } from '../core/git.js';

const posix = { skip: process.platform === 'win32' };
const dir = () => mkdtempSync(join(tmpdir(), 'snippet-editor-git-'));

// A stand-in for git: a small shell script, so a test can decide exactly
// what "git" prints, how long it takes and how it ends.
function standIn(body) {
	const file = join(dir(), 'fake-git');
	writeFileSync(file, `#!/bin/sh\n${body}\n`);
	chmodSync(file, 0o755);
	return file;
}

const fails = async (promise, kind) => {
	let caught;
	await promise.catch((error) => (caught = error));
	assert.ok(caught instanceof GitError, `expected a GitError, got ${caught}`);
	assert.deepEqual([caught.code, caught.kind], ['GIT_FAILED', kind], caught.message);
	return caught;
};

test('it runs the real git and returns what git printed', async () => {
	assert.match(await createGit()(['--version']), /^git version \d+\./);
});

test('a missing program says git is not installed', async () => {
	const error = await fails(createGit({ program: join(dir(), 'no-such-git') })(['--version']), 'missing');
	assert.equal(error.message, 'Git is not installed on this computer.');
});

test('the arguments are passed as they are, after two fixed settings, and never through a shell', posix, async () => {
	const git = createGit({ program: standIn('for a in "$@"; do printf "%s\\n" "$a"; done') });
	const printed = (await git(['clone', '--', 'a b; touch /tmp/owned', '$(whoami)'])).trimEnd().split('\n');
	assert.deepEqual(printed, ['-c', `core.hooksPath=${os.devNull}`, '-c', 'protocol.ext.allow=never', 'clone', '--', 'a b; touch /tmp/owned', '$(whoami)']);
});

test('git can never stop to ask: prompts are off, askpass helpers are gone, input is closed', posix, async () => {
	const env = { PATH: process.env.PATH, HOME: '/home/someone', GIT_ASKPASS: '/usr/bin/ask', SSH_ASKPASS: '/usr/bin/ask', GIT_TERMINAL_PROMPT: '1' };
	const seen = Object.fromEntries((await createGit({ program: standIn('env'), env })([])).trim().split('\n').map((line) => line.split(/=(.*)/s).slice(0, 2)));
	assert.equal(seen.GIT_TERMINAL_PROMPT, '0');
	assert.equal(seen.GIT_ALLOW_PROTOCOL, 'https:ssh');
	assert.equal(seen.GCM_INTERACTIVE, 'never');
	assert.equal(seen.LC_ALL, 'C');
	assert.equal(seen.HOME, '/home/someone');
	assert.ok(!('GIT_ASKPASS' in seen) && !('SSH_ASKPASS' in seen));
	// A program that reads its input gets the end of it at once.
	assert.equal(await createGit({ program: standIn('cat') })([], { timeout: 2000 }), '');
	assert.equal(await createGit({ program: standIn('cat') })([], { input: 'given\n' }), 'given\n');
});

test('one call can add to the environment, but cannot switch the questions back on', posix, async () => {
	const git = createGit({ program: standIn('printf "%s|%s|%s" "$GIT_INDEX_FILE" "$GIT_TERMINAL_PROMPT" "${GIT_ASKPASS:-none}"'), env: { PATH: process.env.PATH } });
	assert.equal(await git([], { env: { GIT_INDEX_FILE: '/tmp/index-1', GIT_TERMINAL_PROMPT: '1', GIT_ASKPASS: '/usr/bin/ask' } }), '/tmp/index-1|0|none');
	assert.equal(await git([]), '|0|none');
});

test('local folders are allowed as a transport only when the caller says so', posix, async () => {
	const allowed = await createGit({ program: standIn('printf "%s" "$GIT_ALLOW_PROTOCOL"'), allowLocal: true })([]);
	assert.equal(allowed, 'https:ssh:file');
});

test('a command over its time limit is stopped, along with anything it started', posix, async () => {
	const started = Date.now();
	const pidFile = join(dir(), 'helper.pid');
	const program = standIn('sleep 20 &\necho $! > "$PID_FILE"\nwait');
	const error = await fails(createGit({ program, env: { PATH: process.env.PATH, PID_FILE: pidFile } })(['fetch'], { timeout: 300 }), 'timeout');
	assert.equal(error.message, 'Git did not finish in time.');
	assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
	// The helper it started, as ssh would be, is gone too. A busy computer can
	// take a moment to clear a stopped process away, so look for a while.
	const helper = Number(readFileSync(pidFile, 'utf8'));
	const gone = () => {
		try {
			process.kill(helper, 0);
			return false;
		} catch (failure) {
			return failure.code === 'ESRCH';
		}
	};
	for (let waited = 0; waited < 5000 && !gone(); waited += 50) await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(gone(), true, `process ${helper} is still running`);
});

test('output over the limit is refused', posix, async () => {
	const git = createGit({ program: standIn('head -c 200000 /dev/zero | tr "\\0" x'), maxBuffer: 1000 });
	const error = await fails(git([]), 'too-large');
	assert.equal(error.message, 'Git sent more than the app can read.');
});

test('binary output comes back as bytes, untouched', posix, async () => {
	const bytes = await createGit({ program: standIn('printf "\\377\\000\\101"') })([], { binary: true });
	assert.deepEqual([...bytes], [255, 0, 65]);
});

test('each way git fails is told apart and worded plainly', posix, async () => {
	const failing = (stderr) => createGit({ program: standIn('printf "%s\\n" "$FAKE" >&2; exit 128'), env: { PATH: process.env.PATH, FAKE: stderr } })(['x']);
	const cases = [
		['auth', "fatal: could not read Username for 'https://github.com': terminal prompts disabled"],
		['auth', 'git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.'],
		['auth', 'Host key verification failed.\nfatal: Could not read from remote repository.'],
		['auth', "remote: Invalid username or password.\nfatal: Authentication failed for 'https://github.com/acme/team.git/'"],
		['unreachable', 'remote: Repository not found.\nfatal: repository not found'],
		['unreachable', "fatal: unable to access 'https://github.invalid/a/b.git/': Could not resolve host: github.invalid"],
		['unreachable', "fatal: '/tmp/nowhere.git' does not appear to be a git repository"],
		['unreachable', "fatal: repository '/tmp/nowhere.git' does not exist"],
		['identity', 'Author identity unknown\n\n*** Please tell me who you are.\n\nfatal: unable to auto-detect email address (got x@y.(none))'],
		['denied', " ! [remote rejected] snippet-editor/x -> snippet-editor/x (pre-receive hook declined)\nerror: failed to push some refs to 'github.com:acme/team.git'"],
		['denied', "remote: Permission to acme/team.git denied to someone.\nfatal: unable to access 'https://github.com/acme/team.git/': The requested URL returned error: 403"],
		['failed', 'fatal: not a git repository (or any of the parent directories): .git'],
	];
	for (const [kind, stderr] of cases) await fails(failing(stderr), kind);
	assert.equal((await fails(failing('warning: something\nfatal: not a git repository'), 'failed')).message, 'Git failed: not a git repository');
	assert.match((await fails(failing('Permission denied (publickey).'), 'auth')).message, /^Git could not sign in to that repository\./);
	assert.match((await fails(failing('remote: Repository not found.'), 'unreachable')).message, /^Git could not reach that repository\./);
	assert.match((await fails(failing('*** Please tell me who you are.'), 'identity')).message, /git config --global user\.name/);
	assert.equal((await fails(failing('! [remote rejected] a -> a (hook declined)'), 'denied')).message, 'You do not have permission to push to this repository.');
});

test('the real git refuses a transport that could run a command', async () => {
	const marker = join(dir(), 'owned');
	await fails(createGit()(['ls-remote', '--', `ext::sh -c "touch ${marker}"`]), 'failed');
	assert.equal(existsSync(marker), false);
});

test('every git call under way can be stopped at once, as when the app quits', posix, async () => {
	const pidFile = join(dir(), 'helper.pid');
	const git = createGit({ program: standIn('sleep 20 &\necho $! > "$PID_FILE"\nwait'), env: { PATH: process.env.PATH, PID_FILE: pidFile } });
	const running = [git(['fetch'], { timeout: 30_000 }), git(['push'], { timeout: 30_000 })];
	await new Promise((resolve) => setTimeout(resolve, 300));
	const started = Date.now();
	git.stopAll();
	for (const call of running) assert.equal((await fails(call, 'stopped')).message, 'Git was stopped because the app is closing.');
	assert.ok(Date.now() - started < 3000);
	const helper = Number(readFileSync(pidFile, 'utf8'));
	for (let waited = 0; waited < 5000; waited += 50) {
		try {
			process.kill(helper, 0);
		} catch {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	assert.fail(`process ${helper} is still running`);
});
