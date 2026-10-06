import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

// The one place the chat starts another program: Claude Code or Codex.
//
//   - No shell. Arguments go as a list, and the person's message goes in on
//     standard input, so it is never part of a command line that other
//     programs on the computer can read.
//   - No waiting forever. A program that goes silent, or runs past its whole
//     time, or prints without end, is stopped.
//   - Nothing left behind. The program runs in a group of its own, so what it
//     started (the MCP server) is stopped with it.
//
// What it prints is handed over one line at a time. How it ended is a
// reason, never an exception:
//   exit      it ended by itself, with `code`
//   stopped   stop() or stopAll() was called
//   idle      it printed nothing for `idleMs`
//   total     it ran for `totalMs`
//   too-much  it printed more than `maxBytes`, or one line over `maxLine`
//   missing   there is no such program
//   failed    it could not be started, or the reader of its lines broke

const TAIL = 500;

export function createRunner({ grace = 2000 } = {}) {
	const grouped = process.platform !== 'win32';
	const live = new Set();

	function run({ program, args = [], cwd, env = process.env, input = '', onLine, idleMs = 120_000, totalMs = 600_000, maxBytes = 64 * 1024 * 1024, maxLine = 8 * 1024 * 1024 }) {
		let settle;
		const done = new Promise((resolve) => (settle = resolve));
		let reason = null;
		let note = '';
		let finished = false;
		let idle;
		let whole;
		let force;
		let child;

		const signal = (name) => {
			try {
				if (grouped) process.kill(-child.pid, name);
				else child.kill(name);
			} catch {
				// Already gone.
			}
		};

		// Ask it to end, and after a moment make it.
		const end = (why, message = '') => {
			if (finished || reason) return;
			reason = why;
			note = message;
			signal('SIGTERM');
			force = setTimeout(() => signal('SIGKILL'), grace);
		};
		const stop = () => end('stopped');

		const finish = (result) => {
			if (finished) return;
			finished = true;
			clearTimeout(idle);
			clearTimeout(whole);
			clearTimeout(force);
			live.delete(stop);
			// The program has gone. Whatever it started and left behind goes too:
			// a helper may heed neither a polite stop nor its input closing.
			if (child?.pid) signal('SIGKILL');
			settle(result);
		};

		try {
			child = spawn(program, args, { cwd, env, windowsHide: true, detached: grouped, stdio: ['pipe', 'pipe', 'pipe'] });
		} catch (error) {
			finish({ reason: 'failed', code: null, stderrTail: String(error.message).slice(-TAIL) });
			return { done, stop };
		}
		live.add(stop);

		const stir = () => {
			clearTimeout(idle);
			idle = setTimeout(() => end('idle'), idleMs);
		};
		stir();
		whole = setTimeout(() => end('total'), totalMs);

		const decoder = new StringDecoder('utf8');
		let pending = '';
		let size = 0;
		let errors = '';

		const hand = (line) => {
			if (reason) return;
			try {
				onLine(line.endsWith('\r') ? line.slice(0, -1) : line);
			} catch (error) {
				end('failed', String(error?.message ?? error));
			}
		};

		child.stdout.on('data', (chunk) => {
			stir();
			size += chunk.length;
			if (size > maxBytes) return end('too-much');
			pending += decoder.write(chunk);
			let at;
			while ((at = pending.indexOf('\n')) !== -1) {
				const line = pending.slice(0, at);
				pending = pending.slice(at + 1);
				hand(line);
			}
			if (pending.length > maxLine) {
				pending = '';
				end('too-much');
			}
		});
		child.stderr.on('data', (chunk) => {
			stir();
			errors = (errors + chunk.toString('utf8')).slice(-4 * TAIL);
		});

		child.on('error', (error) => finish({ reason: error.code === 'ENOENT' ? 'missing' : 'failed', code: null, stderrTail: error.code === 'ENOENT' ? '' : String(error.message).slice(-TAIL) }));
		child.on('close', (code) => {
			// What came last may have no line end.
			pending += decoder.end();
			if (pending && !reason) hand(pending);
			finish({ reason: reason ?? 'exit', code: reason ? null : code, stderrTail: reason === 'failed' ? note.slice(-TAIL) : errors.trim().slice(-TAIL) });
		});

		child.stdin.on('error', () => {});
		child.stdin.end(input);

		return { done, stop };
	}

	return {
		run,
		stopAll() {
			for (const stop of [...live]) stop();
		},
	};
}
