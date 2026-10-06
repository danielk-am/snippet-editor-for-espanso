import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createBackends } from './backends.js';
import { openChannel } from './channel.js';
import { claudeArgs, claudeMcpConfig, createClaudeParser } from './claudeCode.js';
import { codexArgs, createCodexParser } from './codex.js';
import { createOllama, ollamaTurn } from './ollama.js';
import { MAX_MESSAGE, SYSTEM, promptMessages, promptText } from './prompt.js';
import { createProposals } from './proposals.js';
import { createRunner } from './run.js';

// The chat, as the window sees it: a message goes in, and events come back
// until the answer ends.
//
//   { turnId, type: 'text', text }              more of the answer
//   { turnId, type: 'tool', id, name, status }  a tool started, ended or failed
//   { turnId, type: 'proposal', card }          a change, waiting for Apply
//   { turnId, type: 'done' }                    the answer is complete
//   { turnId, type: 'error', code, message }    it ended some other way
//   { turnId, type: 'stopped' }                 the person stopped it
//
// One answer at a time. Each message starts its backend fresh: Claude Code
// and Codex as a program with a listener of its own to call back on, Ollama
// as a request with the tools run here. When the answer ends, by any of the
// three endings, nothing of it is left running or on disk.

const LABEL = { claude: 'Claude Code', codex: 'Codex', ollama: 'Ollama' };
// A model on this computer can take a while to load before its first word.
const LIMITS = { idleMs: 120_000, ollamaIdleMs: 180_000, totalMs: 600_000, maxText: 1_000_000, statusMs: 60_000 };
// An answer that ended this way says the backend itself needs looking at again.
const BACKEND_FAULTS = new Set(['SIGNED_OUT', 'MISSING', 'OLD', 'NOT_RUNNING']);
const TOO_LONG = { type: 'error', code: 'TOO_LONG', message: 'The answer was too long, so it was stopped.' };

const fail = (code, message) => Object.assign(new Error(message), { code });
const count = (number) => number.toLocaleString('en-US');

export function createChat({ service, router, dataDir, mcp, emit, backends = createBackends(), runner = createRunner(), ollama = createOllama(), log = console.error, limits = {} }) {
	const { idleMs, ollamaIdleMs, totalMs, maxText, statusMs } = { ...LIMITS, ...limits };
	const chatDir = path.join(dataDir, 'chat');
	// Where the programs run: a folder with nothing in it, so no file there
	// can hand them instructions or tools.
	const emptyDir = path.join(chatDir, 'empty');
	let active = null;
	let closed = false;
	let prepared = null;
	// What the backends last said, and when. Looking takes over half a second,
	// so a message uses a look from the last minute.
	let known = null;
	const look = async () => {
		const list = await backends.status();
		known = { at: Date.now(), list };
		return list;
	};

	const proposals = createProposals({ router, aiWrite: () => service.settings().aiWrite, log });
	// The way in for one answer's proposals. A card carries the name of the
	// answer that asked for it, and none is made once that answer is over.
	const proposalsOf = (turn) =>
		proposals.forTurn({
			turnId: turn.id,
			isOpen: () => turn.open,
			onCard: (card, turnId) => emit({ turnId, type: 'proposal', card }),
		});

	// Once: the folders, and nothing left over from a run that crashed.
	const prepare = () =>
		(prepared ??= (async () => {
			await fs.mkdir(emptyDir, { recursive: true });
			for (const name of await fs.readdir(chatDir)) {
				if (/^(chat|mcp)-[a-f0-9]+\.json$/.test(name)) await fs.rm(path.join(chatDir, name), { force: true });
			}
		})());

	// --- Claude Code and Codex --------------------------------------------------

	async function viaProgram(turn, id, input) {
		const label = LABEL[id];
		await prepare();
		const channel = await openChannel({ dir: chatDir, router, onProposal: (proposal) => proposalsOf(turn).receive(proposal), log });
		let configFile = null;
		try {
			if (turn.stopped) return { type: 'stopped' };
			const program = await backends.locate(id);
			const missing = { type: 'error', code: 'MISSING', message: `${label} could not be started. Press Check again.` };
			if (!program) return missing;

			let args;
			let parser;
			if (id === 'claude') {
				configFile = path.join(chatDir, `mcp-${randomBytes(8).toString('hex')}.json`);
				await fs.writeFile(configFile, JSON.stringify(claudeMcpConfig({ mcp, sessionFile: channel.file })), { mode: 0o600 });
				args = claudeArgs({ mcpConfigFile: configFile, system: SYSTEM });
				parser = createClaudeParser();
			} else {
				args = codexArgs({ cwd: emptyDir, system: SYSTEM, mcp, sessionFile: channel.file });
				parser = createCodexParser();
			}

			let ending = null;
			let length = 0;
			const running = runner.run({
				program,
				args,
				cwd: emptyDir,
				input: promptText(input),
				idleMs,
				totalMs,
				onLine(line) {
					for (const event of parser.push(line)) {
						if (ending) return;
						if (event.type === 'text') {
							length += event.text.length;
							if (length > maxText) ending = TOO_LONG;
							else emit({ turnId: turn.id, ...event });
						} else if (event.type === 'done' || event.type === 'error') ending = event;
						else emit({ turnId: turn.id, ...event });
						// Its last line is out, or it must not go on: it has no more to do.
						if (ending) running.stop();
					}
				},
			});
			turn.stop = () => running.stop();
			if (turn.stopped) running.stop();
			const result = await running.done;

			if (turn.stopped) return { type: 'stopped' };
			if (ending?.code === 'SIGNED_OUT') return { type: 'error', code: 'SIGNED_OUT', message: `${label} is not signed in. Sign it in from a terminal, then press Check again.` };
			if (ending) return ending;
			if (result.reason === 'missing') return missing;
			if (result.reason === 'idle' || result.reason === 'total') return { type: 'error', code: 'TIMEOUT', message: `${label} took too long, so it was stopped.` };
			if (result.reason === 'too-much') return TOO_LONG;
			const said = (parser.lastError || result.stderrTail || '').trim();
			if (result.reason === 'failed') return { type: 'error', code: 'FAILED', message: `${label} could not be started${said ? `: ${said}` : '.'}` };
			// A flag it does not know: this copy is older than the ones the app was built against.
			if (/unknown option|unrecognized option|unexpected argument/i.test(said)) return { type: 'error', code: 'OLD', message: `This ${label} is older than the app needs. Update ${label}, then try again.` };
			return { type: 'error', code: 'FAILED', message: `${label} stopped unexpectedly${said ? `: ${said}` : '.'}` };
		} finally {
			await channel.close();
			if (configFile) await fs.rm(configFile, { force: true });
		}
	}

	// --- Ollama -----------------------------------------------------------------

	async function viaOllama(turn, model, input) {
		const stopper = new AbortController();
		turn.stop = () => stopper.abort();
		if (turn.stopped) stopper.abort();
		let ending = null;
		await ollamaTurn({
			ollama,
			model,
			messages: promptMessages(input),
			tools: proposalsOf(turn).tools,
			signal: stopper.signal,
			idleMs: ollamaIdleMs,
			totalMs,
			maxText,
			onEvent(event) {
				if (event.type === 'done' || event.type === 'error') ending = event;
				else emit({ turnId: turn.id, ...event });
			},
		});
		if (turn.stopped) return { type: 'stopped' };
		return ending ?? { type: 'error', code: 'FAILED', message: 'Ollama stopped before the answer was complete.' };
	}

	// --- one answer -------------------------------------------------------------

	async function answer(turn, work) {
		let ending;
		try {
			ending = await work();
		} catch (error) {
			log(error);
			ending = { type: 'error', code: 'ERROR', message: 'Something went wrong inside the app.' };
		}
		if (BACKEND_FAULTS.has(ending.code)) known = null;
		// Over: a card still being worked out for this answer is no longer wanted.
		turn.open = false;
		// Free before the ending is told, so the next message can follow it at once.
		if (active === turn) active = null;
		emit({ turnId: turn.id, ...ending });
	}

	return {
		status: look,

		async send(input) {
			if (closed) throw fail('CLOSED', 'The app is closing.');
			const id = input?.backend;
			if (!Object.hasOwn(LABEL, id ?? '')) throw fail('INVALID', 'Choose Claude Code, Codex or Ollama.');
			const messages = Array.isArray(input.messages) ? input.messages : [];
			const latest = messages.at(-1);
			if (latest?.role !== 'user' || typeof latest.text !== 'string' || !latest.text.trim()) throw fail('INVALID', 'Write a message first.');
			if (latest.text.length > MAX_MESSAGE) throw fail('INVALID', `That message is too long: ${count(latest.text.length)} characters, and the most is ${count(MAX_MESSAGE)}.`);
			if (active) throw fail('BUSY', 'An answer is under way. Wait for it, or stop it first.');

			// The place is taken before anything is waited for.
			const turn = { id: randomBytes(8).toString('hex'), open: true, stopped: false, stop: () => {}, finished: null };
			active = turn;
			try {
				const list = known && Date.now() - known.at < statusMs ? known.list : await look();
				// The app began to close while that was being looked up.
				if (closed) throw fail('CLOSED', 'The app is closing.');
				const entry = list.find((item) => item.id === id);
				if (!entry?.ready) throw fail('NOT_READY', entry?.message || `${LABEL[id]} is not ready.`);
				if (id === 'ollama' && !entry.models.some((model) => model.name === input.model)) throw fail('INVALID', "Choose one of Ollama's models first.");
			} catch (error) {
				active = null;
				throw error;
			}
			const asked = { messages, context: input.context };
			turn.finished = answer(turn, () => (id === 'ollama' ? viaOllama(turn, input.model, asked) : viaProgram(turn, id, asked)));
			return { turnId: turn.id };
		},

		stop(turnId) {
			if (!active || active.id !== turnId) return;
			active.stopped = true;
			active.open = false;
			active.stop();
		},

		// For a window that has just loaded: it does not know the name of an
		// answer its predecessor started, and nothing is listening for it.
		stopAny() {
			if (!active) return;
			active.stopped = true;
			active.open = false;
			active.stop();
		},

		apply: (id) => proposals.apply(id),
		dismiss: (id) => proposals.dismiss(id),

		async dispose() {
			closed = true;
			const turn = active;
			if (turn) {
				turn.stopped = true;
				turn.open = false;
				turn.stop();
				await turn.finished;
			}
			runner.stopAll();
		},
	};
}
