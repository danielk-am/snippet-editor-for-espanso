import http from 'node:http';
import { StringDecoder } from 'node:string_decoder';

// Ollama as the chat's backend.
//
// The app talks to the Ollama on this computer and to nothing else, and holds
// no key. Cloud models are the ones that Ollama itself offers once the person
// has signed in to it.
//
// Ollama has no tools of its own, so the app runs the loop: send the
// conversation and the tool list, read the answer as it arrives, run each
// tool the model asks for inside the app, send the results back, and go
// round again, eight times at most.
//
// Written from Ollama's API reference (/api/chat with `tools` and
// `stream: true`, /api/tags, /api/version) and tested against a stand-in.
// Ollama was not installed on the computer this was built on.

const MOST = 500;
// What one round may hold: tools asked for at once, thinking, and one line.
const MAX_CALLS = 20;
const MAX_THINKING = 400_000;
const MAX_LINE = 8 * 1024 * 1024;
const coded = (code, message) => Object.assign(new Error(message), { code });
const NOT_RUNNING = () => coded('NOT_RUNNING', 'Ollama is not answering on this computer.');
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export function createOllama({ port = 11434, quickMs = 1500 } = {}) {
	// A connection of its own, which the environment cannot point at a proxy.
	const agent = new http.Agent();
	const base = { host: '127.0.0.1', port, agent };

	// A small question with a short wait: is it there, what does it have.
	function quick(path) {
		return new Promise((resolve, reject) => {
			const request = http.request({ ...base, method: 'GET', path, signal: AbortSignal.timeout(quickMs) }, (response) => {
				const chunks = [];
				response.on('data', (chunk) => chunks.push(chunk));
				response.on('error', () => reject(NOT_RUNNING()));
				response.on('end', () => {
					try {
						const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
						if (response.statusCode !== 200 || !isObject(body)) throw new Error('not Ollama');
						resolve(body);
					} catch {
						reject(NOT_RUNNING());
					}
				});
			});
			request.on('error', () => reject(NOT_RUNNING()));
			request.end();
		});
	}

	function refusal(status, said) {
		if (/does not support tools/i.test(said)) return coded('NO_TOOLS', 'This model cannot use tools, so it cannot read your snippets. Pick another model.');
		if (status === 401 || status === 403) return coded('SIGNED_OUT', 'Ollama says you are not signed in. Sign in to Ollama, then try again.');
		return coded('FAILED', `Ollama said: ${said || `error ${status}`}`.slice(0, MOST));
	}

	return {
		async version() {
			const body = await quick('/api/version');
			if (typeof body.version !== 'string') throw NOT_RUNNING();
			return body.version;
		},

		async models() {
			const body = await quick('/api/tags');
			if (!Array.isArray(body.models)) throw NOT_RUNNING();
			return body.models
				.map((item) => item?.name ?? item?.model)
				.filter((name) => typeof name === 'string' && name)
				.sort((a, b) => a.localeCompare(b));
		},

		// One round: the answer as it arrives, and what it asked for.
		chat({ model, messages, tools, signal, idleMs = 180_000, onContent = () => {} }) {
			return new Promise((resolve, reject) => {
				if (signal?.aborted) return reject(coded('STOPPED', 'Stopped.'));
				let settled = false;
				let answering = false;
				let idle;
				const finish = (settle, value) => {
					if (settled) return;
					settled = true;
					clearTimeout(idle);
					signal?.removeEventListener('abort', onAbort);
					settle(value);
				};
				const drop = (error) => {
					request.destroy();
					finish(reject, error);
				};
				const onAbort = () => drop(coded('STOPPED', 'Stopped.'));
				const stir = () => {
					clearTimeout(idle);
					idle = setTimeout(() => drop(coded('IDLE', 'Ollama stopped answering, so it was stopped.')), idleMs);
				};

				const payload = JSON.stringify({ model, messages, tools, stream: true, options: { num_ctx: 16384 } });
				const request = http.request({ ...base, method: 'POST', path: '/api/chat', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, (response) => {
					answering = true;
					const decoder = new StringDecoder('utf8');

					if (response.statusCode !== 200) {
						let text = '';
						response.on('data', (chunk) => {
							if (text.length < 65_536) text += decoder.write(chunk);
						});
						response.on('end', () => {
							let said = '';
							try {
								said = String(JSON.parse(text).error ?? '');
							} catch {
								// Not JSON: the status is all there is.
							}
							finish(reject, refusal(response.statusCode, said));
						});
						return;
					}

					let pending = '';
					let done = false;
					const reply = { content: '', thinking: '', toolCalls: [] };
					const take = (line) => {
						if (!line.trim() || settled) return;
						let chunk;
						try {
							chunk = JSON.parse(line);
						} catch {
							return;
						}
						if (!isObject(chunk)) return;
						if (typeof chunk.error === 'string') return drop(coded('FAILED', `Ollama said: ${chunk.error}`.slice(0, MOST)));
						const message = isObject(chunk.message) ? chunk.message : {};
						if (typeof message.thinking === 'string') {
							reply.thinking += message.thinking;
							if (reply.thinking.length > MAX_THINKING) return drop(coded('TOO_LONG', 'The answer was too long, so it was stopped.'));
						}
						if (Array.isArray(message.tool_calls)) {
							if (reply.toolCalls.length + message.tool_calls.length > MAX_CALLS) {
								return drop(coded('FAILED', `Ollama asked for more tools at once than the app runs (${MAX_CALLS} at most).`));
							}
							for (const call of message.tool_calls) reply.toolCalls.push(call);
						}
						if (typeof message.content === 'string' && message.content) {
							reply.content += message.content;
							try {
								onContent(message.content);
							} catch (error) {
								return drop(error);
							}
						}
						if (chunk.done === true) done = true;
					};
					response.on('data', (chunk) => {
						stir();
						pending += decoder.write(chunk);
						let at;
						while ((at = pending.indexOf('\n')) !== -1) {
							const line = pending.slice(0, at);
							pending = pending.slice(at + 1);
							take(line);
						}
						if (pending.length > MAX_LINE) {
							pending = '';
							drop(coded('FAILED', 'Ollama sent a line longer than the app reads.'));
						}
					});
					response.on('end', () => {
						take(pending + decoder.end());
						if (done) finish(resolve, reply);
						else finish(reject, coded('FAILED', 'Ollama stopped before the answer was complete.'));
					});
					response.on('error', () => finish(reject, coded('FAILED', 'Ollama stopped before the answer was complete.')));
				});
				request.on('error', () => finish(reject, answering ? coded('FAILED', 'Ollama stopped before the answer was complete.') : NOT_RUNNING()));
				signal?.addEventListener('abort', onAbort, { once: true });
				stir();
				request.end(payload);
			});
		},
	};
}

// What a model put where the inputs go: a mapping, sometimes as text.
function inputsOf(given) {
	if (isObject(given)) return given;
	if (typeof given !== 'string') return {};
	try {
		const parsed = JSON.parse(given);
		return isObject(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

const REPORTED = new Set(['NOT_RUNNING', 'NO_TOOLS', 'SIGNED_OUT', 'FAILED', 'IDLE', 'TOO_LONG', 'TIMEOUT']);

// One message answered, as the same events the other backends give. It ends
// with `done` or `error`, or with neither when the person stopped it.
export async function ollamaTurn({ ollama, model, messages, tools, onEvent, signal, maxSteps = 8, idleMs, totalMs = 600_000, maxText = 1_000_000 }) {
	const offered = tools.list().map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } }));
	const history = [...messages];
	const stopped = () => signal?.aborted === true;
	let anyText = false;
	let afterTool = false;
	let length = 0;

	// The whole answer has a time limit, however many rounds it takes and
	// whatever it is doing: writing, thinking, or waiting on a tool.
	const limit = new AbortController();
	const timer = setTimeout(() => limit.abort(), totalMs);
	const outOfTime = () => limit.signal.aborted;
	const either = signal ? AbortSignal.any([signal, limit.signal]) : limit.signal;
	// A tool can take a while (the team's repository, a large file). A stop,
	// or the time running out, does not wait for it.
	const interrupted = new Promise((resolve) => either.addEventListener('abort', () => resolve(null), { once: true }));

	try {
		for (let step = 1; step <= maxSteps; step += 1) {
			const reply = await ollama.chat({
				model,
				messages: history,
				tools: offered,
				signal: either,
				idleMs,
				onContent(text) {
					length += text.length;
					if (length > maxText) throw coded('TOO_LONG', 'The answer was too long, so it was stopped.');
					onEvent({ type: 'text', text: afterTool && anyText ? `\n\n${text}` : text });
					anyText = true;
					afterTool = false;
				},
			});
			if (stopped()) return;
			if (outOfTime()) break;
			if (!reply.toolCalls.length) return void onEvent({ type: 'done' });

			history.push({ role: 'assistant', content: reply.content, ...(reply.thinking ? { thinking: reply.thinking } : {}), tool_calls: reply.toolCalls });
			for (const [position, call] of reply.toolCalls.entries()) {
				const id = `call-${step}-${position + 1}`;
				const name = String(call?.function?.name ?? '');
				onEvent({ type: 'tool', id, name, status: 'started' });
				const result = await Promise.race([tools.call(name, inputsOf(call?.function?.arguments)), interrupted]);
				if (stopped()) return;
				if (outOfTime()) break;
				const failed = result === null || result.isError === true;
				onEvent({ type: 'tool', id, name, status: failed ? 'failed' : 'done' });
				history.push({ role: 'tool', tool_name: name, content: result === null ? `There is no tool named ${name}.` : result.content.map((part) => part.text).join('\n') });
			}
			if (outOfTime()) break;
			afterTool = true;
		}
		if (outOfTime()) onEvent({ type: 'error', code: 'TIMEOUT', message: 'Ollama took too long, so it was stopped.' });
		else onEvent({ type: 'error', code: 'STEPS', message: `The assistant used tools ${maxSteps} times without finishing, so it was stopped.` });
	} catch (error) {
		if (stopped()) return;
		if (outOfTime()) return void onEvent({ type: 'error', code: 'TIMEOUT', message: 'Ollama took too long, so it was stopped.' });
		if (error?.code === 'STOPPED') return;
		if (!REPORTED.has(error?.code)) throw error;
		onEvent({ type: 'error', code: error.code, message: error.message });
	} finally {
		clearTimeout(timer);
	}
}
