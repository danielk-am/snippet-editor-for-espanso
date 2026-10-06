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
import readline from 'node:readline';

export const MODERN = ['2026-07-28'];
export const LEGACY = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SUPPORTED = [...MODERN, ...LEGACY];

const VERSION_KEY = 'io.modelcontextprotocol/protocolVersion';
const CAPABILITIES_KEY = 'io.modelcontextprotocol/clientCapabilities';
const SERVER_KEY = 'io.modelcontextprotocol/serverInfo';

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
	// Set by `initialize`, for the life of this process.
	let handshake = false;
	// Calls under way, and the ones the client no longer wants an answer to.
	const running = new Set();
	const cancelled = new Set();

	const failure = (id, code, message, data) => ({ jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } });

	// Which shape a request is in: 'modern', 'legacy', or an error.
	function shapeOf(method, params) {
		const meta = isObject(params) && isObject(params._meta) ? params._meta : {};
		const requested = meta[VERSION_KEY];
		if (requested !== undefined) {
			if (!MODERN.includes(requested)) throw new ProtocolError(-32022, 'Unsupported protocol version', { supported: SUPPORTED, requested });
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
			handshake = true;
			const requested = isObject(params) ? params.protocolVersion : undefined;
			return { protocolVersion: LEGACY.includes(requested) ? requested : LEGACY[0], capabilities: { tools: {} }, serverInfo, instructions };
		}

		const shape = shapeOf(method, params);
		const wrap = (result) => (shape === 'modern' ? { resultType: 'complete', ...result, _meta: { [SERVER_KEY]: serverInfo } } : result);

		if (method === 'ping') return wrap({});
		if (method === 'server/discover' && shape === 'modern') return wrap({ supportedVersions: MODERN, capabilities: { tools: {} }, instructions });
		if (method === 'tools/list') return wrap({ tools: tools.list() });
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
			return JSON.stringify(failure(null, -32700, 'Parse error'));
		}
		const reply = await handle(message);
		return reply === null ? null : JSON.stringify(reply);
	}

	// Reads lines until the input ends. Calls run side by side, so a slow one
	// does not hold up the rest; each answer is written whole, on one line.
	function serve({ input, output }) {
		return new Promise((resolve) => {
			const pending = new Set();
			let ended = false;
			const settle = () => ended && pending.size === 0 && resolve();
			const lines = readline.createInterface({ input, crlfDelay: Infinity });
			lines.on('line', (line) => {
				const work = handleLine(line)
					.then((reply) => reply !== null && output.write(`${reply}\n`))
					.catch(log)
					.finally(() => {
						pending.delete(work);
						settle();
					});
				pending.add(work);
			});
			lines.on('close', () => {
				ended = true;
				settle();
			});
		});
	}

	return { handleLine, serve };
}
