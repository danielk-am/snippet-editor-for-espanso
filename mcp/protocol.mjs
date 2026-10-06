// The Model Context Protocol, as much of it as a server with only tools
// needs. It knows nothing about snippets: it reads one JSON message per line,
// answers on one line, and hands tool calls to whoever supplied `tools`.
//
// MCP changed shape in its 2026-07-28 revision, and AI tools in use today sit
// on both sides of the change, so this speaks both:
//
//   - Older clients open with an `initialize` handshake. After it, their
//     requests carry no version.
//   - Newer clients send no handshake. Every request names its version in
//     `_meta`, and each is served on its own.
import { StringDecoder } from 'node:string_decoder';

export const MODERN = ['2026-07-28'];
export const LEGACY = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SUPPORTED = [...MODERN, ...LEGACY];

const VERSION_KEY = 'io.modelcontextprotocol/protocolVersion';
const CAPABILITIES_KEY = 'io.modelcontextprotocol/clientCapabilities';
const SERVER_KEY = 'io.modelcontextprotocol/serverInfo';

// Two characters that JSON allows inside a string but that many line readers
// take for the end of a line. They are written as escapes in every reply, so
// a reply is one line for any reader. Named by number: typed here as the
// characters themselves they would be invisible.
const SEPARATORS = [[String.fromCharCode(0x2028), '\\u2028'], [String.fromCharCode(0x2029), '\\u2029']];
const oneLine = (value) => SEPARATORS.reduce((text, [character, escape]) => text.split(character).join(escape), JSON.stringify(value));

// How long a client may keep the two answers that never change while this
// server runs. The newer shape asks every server to say.
const KEEP = { ttlMs: 3_600_000, cacheScope: 'public' };

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isId = (value) => typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));

class ProtocolError extends Error {
	constructor(code, message, data) {
		super(message);
		this.code = code;
		this.data = data;
	}
}

export function createProtocol({ serverInfo, instructions, tools, log = () => {} }) {
	// The version agreed by `initialize`, for the life of this process.
	let handshake = null;
	// Calls under way, and the ones the client no longer wants an answer to.
	const running = new Set();
	const cancelled = new Set();

	const failure = (id, code, message, data) => ({ jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } });

	// Which shape a request is in: 'modern', 'legacy', or an error.
	function shapeOf(method, params) {
		const meta = isObject(params) && isObject(params._meta) ? params._meta : {};
		const requested = meta[VERSION_KEY];
		if (requested !== undefined) {
			// Only the versions this path serves. Naming an older one here would
			// send a client round in a circle.
			if (!MODERN.includes(requested)) throw new ProtocolError(-32022, 'Unsupported protocol version', { supported: MODERN, requested });
			if (!isObject(meta[CAPABILITIES_KEY])) throw new ProtocolError(-32602, `Invalid params: every request must carry ${CAPABILITIES_KEY} in _meta.`);
			return 'modern';
		}
		// A ping may arrive before the handshake.
		if (handshake || method === 'ping') return 'legacy';
		throw new ProtocolError(
			-32602,
			`This server speaks MCP ${MODERN.join(', ')}, with the version sent in _meta on every request, and ${LEGACY.join(', ')} after an initialize handshake.`,
			{ supported: SUPPORTED }
		);
	}

	async function answer(id, method, params) {
		if (method === 'initialize') {
			const requested = isObject(params) ? params.protocolVersion : undefined;
			handshake = LEGACY.includes(requested) ? requested : LEGACY[0];
			return { protocolVersion: handshake, capabilities: { tools: {} }, serverInfo, instructions };
		}

		const shape = shapeOf(method, params);
		const wrap = (result) => (shape === 'modern' ? { resultType: 'complete', ...result, _meta: { [SERVER_KEY]: serverInfo } } : result);

		if (method === 'ping') return wrap({});
		const kept = shape === 'modern' ? KEEP : {};
		if (method === 'server/discover' && shape === 'modern') return wrap({ supportedVersions: MODERN, capabilities: { tools: {} }, instructions, ...kept });
		if (method === 'tools/list') return wrap({ tools: tools.list(), ...kept });
		if (method === 'tools/call') {
			if (!isObject(params) || typeof params.name !== 'string' || (params.arguments !== undefined && !isObject(params.arguments))) {
				throw new ProtocolError(-32602, 'Invalid params: tools/call needs a tool `name` and, if any, `arguments` as an object.');
			}
			const result = await tools.call(params.name, params.arguments ?? {});
			if (result === null) throw new ProtocolError(-32602, `Unknown tool: ${params.name}`);
			return wrap(result);
		}
		throw new ProtocolError(-32601, `Method not found: ${method}`);
	}

	// One message in. One reply out, or null when none is owed.
	async function handle(message) {
		// Several requests in one message: only the 2025-03-26 version had this.
		if (Array.isArray(message) && message.length && handshake === '2025-03-26') {
			const replies = (await Promise.all(message.map((item) => (Array.isArray(item) ? failure(null, -32600, 'Invalid Request') : handle(item))))).filter((reply) => reply !== null);
			return replies.length ? replies : null;
		}
		if (!isObject(message)) return failure(null, -32600, 'Invalid Request');
		const hasId = Object.hasOwn(message, 'id');
		if (message.jsonrpc !== '2.0' || (hasId && !isId(message.id))) return failure(isId(message.id) ? message.id : null, -32600, 'Invalid Request');

		if (typeof message.method !== 'string') {
			// A reply from the client to something this server never asks.
			if (hasId && (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error'))) return null;
			return failure(hasId ? message.id : null, -32600, 'Invalid Request');
		}

		if (!hasId) {
			if (message.method === 'notifications/cancelled' && isObject(message.params) && running.has(message.params.requestId)) {
				cancelled.add(message.params.requestId);
			}
			return null;
		}

		const { id } = message;
		running.add(id);
		try {
			const result = await answer(id, message.method, message.params);
			return cancelled.has(id) ? null : { jsonrpc: '2.0', id, result };
		} catch (error) {
			if (cancelled.has(id)) return null;
			if (error instanceof ProtocolError) return failure(id, error.code, error.message, error.data);
			log(error);
			return failure(id, -32603, 'Internal error');
		} finally {
			running.delete(id);
			cancelled.delete(id);
		}
	}

	async function handleLine(line) {
		if (!line.trim()) return null;
		let message;
		try {
			message = JSON.parse(line);
		} catch {
			return oneLine(failure(null, -32700, 'Parse error'));
		}
		const reply = await handle(message);
		return reply === null ? null : oneLine(reply);
	}

	// Reads lines until the input ends. Calls run side by side, so a slow one
	// does not hold up the rest; each answer is written whole, on one line.
	//
	// A line ends at a line feed and nowhere else. Node's own line reader also
	// ends a line at the two Unicode separators, which a request may hold.
	//
	// When the input ends, the client has gone. Calls still running get
	// `grace` milliseconds to finish, then the server stops waiting.
	function serve({ input, output, grace = 2000 }) {
		return new Promise((resolve) => {
			const pending = new Set();
			const decoder = new StringDecoder('utf8');
			let buffered = '';
			let ended = false;
			const settle = () => ended && pending.size === 0 && resolve();

			const take = (line) => {
				const work = handleLine(line.endsWith('\r') ? line.slice(0, -1) : line)
					.then((reply) => reply !== null && output.write(`${reply}\n`))
					.catch(log)
					.finally(() => {
						pending.delete(work);
						settle();
					});
				pending.add(work);
			};
			const feed = (text) => {
				buffered += text;
				for (let at = buffered.indexOf('\n'); at >= 0; at = buffered.indexOf('\n')) {
					take(buffered.slice(0, at));
					buffered = buffered.slice(at + 1);
				}
			};

			input.on('data', (chunk) => feed(typeof chunk === 'string' ? chunk : decoder.write(chunk)));
			input.on('end', () => {
				feed(decoder.end());
				if (buffered.trim()) take(buffered);
				ended = true;
				settle();
				if (pending.size) setTimeout(resolve, grace).unref?.();
			});
		});
	}

	return { handleLine, serve };
}
