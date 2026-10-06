import { spawn } from 'node:child_process';
import os from 'node:os';

// The one place the app starts git. Three promises hold for every call:
//
//   - No shell. Arguments go to git as a list, so nothing in an address or a
//     package name can become a command.
//   - No questions. Git cannot stop to ask for a password or a passphrase,
//     because nobody would see the question. It fails, and the app says so.
//   - No waiting forever. Each call has a time limit, and when it passes,
//     git and anything git started (ssh, a credential helper) are stopped.

export class GitError extends Error {
	constructor(kind, message, detail = '') {
		super(message);
		this.name = 'GitError';
		this.code = 'GIT_FAILED';
		this.kind = kind;
		this.detail = detail;
	}
}

const MESSAGES = {
	missing: 'Git is not installed on this computer.',
	timeout: 'Git did not finish in time.',
	'too-large': 'Git sent more than the app can read.',
	auth: 'Git could not sign in to that repository. Check that "git ls-remote" works for its address in a terminal.',
	unreachable: 'Git could not reach that repository. Check the address, and that "git ls-remote" works for it in a terminal.',
	identity:
		'Git does not know your name and email yet. Set them in a terminal: git config --global user.name "Your Name" and git config --global user.email "you@example.com".',
	denied: 'You do not have permission to push to this repository.',
};

// Checked in this order: a refused push also says "unable to access", and a
// refused sign-in also says "could not read from remote repository".
const PATTERNS = [
	['identity', /please tell me who you are|author identity unknown|empty ident name|unable to auto-detect email/i],
	['denied', /\[remote rejected\]|permission to \S+ denied|protected branch|hook declined|deny updating|returned error: 403/i],
	['auth', /could not read username|could not read password|authentication failed|permission denied \(publickey|terminal prompts disabled|host key verification failed|invalid username or password|returned error: 401/i],
	['unreachable', /repository not found|does not appear to be a git repository|could not resolve host|could not read from remote repository|unable to access|connection refused|connection timed out|network is unreachable|returned error: 404/i],
];

function explain(stderr) {
	const kind = PATTERNS.find(([, pattern]) => pattern.test(stderr))?.[0] ?? 'failed';
	if (kind !== 'failed') return new GitError(kind, MESSAGES[kind], stderr);
	const lines = stderr.split('\n').map((line) => line.trim()).filter(Boolean);
	const last = (lines.at(-1) ?? 'it gave no reason').replace(/^(fatal|error): /, '').slice(0, 300);
	return new GitError('failed', `Git failed: ${last}`, stderr);
}

export function createGit({ program = 'git', allowLocal = false, env = process.env, maxBuffer = 16 * 1024 * 1024 } = {}) {
	const childEnv = {
		...env,
		GIT_TERMINAL_PROMPT: '0',
		// ext:: runs a command and file: reads any folder; neither is offered.
		GIT_ALLOW_PROTOCOL: allowLocal ? 'https:ssh:file' : 'https:ssh',
		GCM_INTERACTIVE: 'never',
		// Git's own wording, in one language, so its failures can be told apart.
		LC_ALL: 'C',
	};
	delete childEnv.GIT_ASKPASS;
	delete childEnv.SSH_ASKPASS;

	// A hook set up on this computer has no business running inside the app.
	const fixed = ['-c', `core.hooksPath=${os.devNull}`, '-c', 'protocol.ext.allow=never'];
	// Its own process group, so git's helpers can be stopped along with it.
	const grouped = process.platform !== 'win32';

	return function git(args, { cwd, timeout = 15_000, input, binary = false } = {}) {
		return new Promise((resolve, reject) => {
			let child;
			try {
				child = spawn(program, [...fixed, ...args], { cwd, env: childEnv, windowsHide: true, detached: grouped, stdio: ['pipe', 'pipe', 'pipe'] });
			} catch (error) {
				return reject(new GitError('failed', `Git failed: ${error.message}`));
			}

			const out = [];
			const err = [];
			let size = 0;
			let settled = false;
			const stop = () => {
				try {
					if (grouped) process.kill(-child.pid, 'SIGKILL');
					else child.kill('SIGKILL');
				} catch {
					// Already gone.
				}
			};
			const finish = (settle, value) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				settle(value);
			};
			const timer = setTimeout(() => {
				stop();
				finish(reject, new GitError('timeout', MESSAGES.timeout));
			}, timeout);

			const collect = (chunks) => (chunk) => {
				size += chunk.length;
				if (size > maxBuffer) {
					stop();
					return finish(reject, new GitError('too-large', MESSAGES['too-large']));
				}
				chunks.push(chunk);
			};
			child.stdout.on('data', collect(out));
			child.stderr.on('data', collect(err));
			child.on('error', (error) => finish(reject, error.code === 'ENOENT' ? new GitError('missing', MESSAGES.missing) : new GitError('failed', `Git failed: ${error.message}`)));
			child.on('close', (code) => {
				const stdout = Buffer.concat(out);
				if (code === 0) return finish(resolve, binary ? stdout : stdout.toString('utf8'));
				finish(reject, explain(Buffer.concat(err).toString('utf8')));
			});

			child.stdin.on('error', () => {});
			child.stdin.end(input ?? '');
		});
	};
}
