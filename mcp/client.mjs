// How the MCP server reaches the app: over the app's own local API, with the
// token the app keeps in its data folder. This file imports nothing from the
// rest of the app, so the mcp/ folder can run on its own.
//
// The token is the key to every snippet, so two things are certain before it
// is sent anywhere:
//   - It goes straight to this computer. Node's shared connection settings can
//     be told by the environment to use a proxy; this uses a connection of
//     its own that cannot.
//   - Whoever is listening holds the token already. Another program can take
//     the app's port while the app is closed, so the listener is first asked
//     to prove itself (see the proof route in the app's listener).
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const APP_NAME = 'Snippet Editor';
const DEFAULTS = { apiEnabled: false, apiPort: 27187, aiWrite: false };

// Where Electron keeps this app's data, worked out without Electron.
export function dataDirFor({ env = process.env, platform = process.platform, home = os.homedir() } = {}) {
	if (env.SNIPPET_EDITOR_DATA_DIR) return env.SNIPPET_EDITOR_DATA_DIR;
	if (platform === 'darwin') return path.posix.join(home, 'Library', 'Application Support', APP_NAME);
	if (platform === 'win32') return path.win32.join(env.APPDATA || path.win32.join(home, 'AppData', 'Roaming'), APP_NAME);
	return path.posix.join(env.XDG_CONFIG_HOME || path.posix.join(home, '.config'), APP_NAME);
}

const unreachable = (message) => Object.assign(new Error(message), { code: 'UNREACHABLE' });
const NOT_REACHABLE = 'Snippet Editor is not reachable. Open the app and switch on "API for other tools" in its Settings.';

// One request to 127.0.0.1, answered as a status and parsed JSON. `gone` is
// what to say when nothing, or something else, is listening there.
function createSender(gone) {
	const direct = new http.Agent();
	return function send({ port, method, target, headers = {}, body, timeout }) {
		return new Promise((resolve, reject) => {
			const request = http.request({ host: '127.0.0.1', port, method, path: target, headers, agent: direct, signal: AbortSignal.timeout(timeout) }, (response) => {
				const chunks = [];
				response.on('data', (chunk) => chunks.push(chunk));
				response.on('error', reject);
				response.on('end', () => {
					try {
						resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
					} catch {
						// Something else is listening on that port.
						reject(unreachable(gone));
					}
				});
			});
			request.on('error', (error) => reject(error.code === 'UNREACHABLE' ? error : unreachable(error.name === 'AbortError' || error.code === 'ABORT_ERR' ? 'Snippet Editor did not answer in time.' : gone)));
			request.end(body);
		});
	};
}

// A call to the app's routes on `port`, once the listener there has shown
// that it holds `token`.
async function call(send, { port, token, method, apiPath, query = {}, body, timeout, gone, refused }) {
	// Proof first: only the app can answer this for a number chosen here.
	const nonce = randomBytes(16).toString('hex');
	const proof = await send({ port, method: 'GET', target: `/api/v1/proof?nonce=${nonce}`, timeout });
	const expected = createHmac('sha256', token).update(nonce).digest();
	const given = Buffer.from(typeof proof.body?.proof === 'string' ? proof.body.proof : '', 'hex');
	if (proof.status !== 200 || given.length !== expected.length || !timingSafeEqual(given, expected)) throw unreachable(gone);

	const search = new URLSearchParams(Object.entries(query).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)])).toString();
	const payload = body === undefined ? undefined : JSON.stringify(body);
	const reply = await send({
		port,
		method,
		target: `/api/v1${apiPath}${search ? `?${search}` : ''}`,
		headers: { Authorization: `Bearer ${token}`, ...(payload === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }) },
		body: payload,
		timeout,
	});
	if (reply.status === 401) throw unreachable(refused);
	return reply;
}

export function createApiClient({ dataDir }) {
	const send = createSender(NOT_REACHABLE);

	// Read each time: the person can change a switch while the server runs.
	async function settings() {
		let raw;
		try {
			raw = JSON.parse(await fs.readFile(path.join(dataDir, 'settings.json'), 'utf8'));
		} catch {
			return { ...DEFAULTS };
		}
		return {
			apiEnabled: raw?.apiEnabled === true,
			apiPort: Number.isInteger(raw?.apiPort) && raw.apiPort >= 1024 && raw.apiPort <= 65535 ? raw.apiPort : DEFAULTS.apiPort,
			aiWrite: raw?.aiWrite === true,
		};
	}

	async function request(method, apiPath, { query, body, timeout = 15_000 } = {}) {
		const { apiEnabled, apiPort } = await settings();
		// With its API off the app is not listening, and whatever else holds
		// that port must not be sent the token.
		if (!apiEnabled) throw unreachable(NOT_REACHABLE);

		// Read for each request, so a token replaced in Settings is picked up.
		const token = await fs.readFile(path.join(dataDir, 'api-token'), 'utf8').then((text) => text.trim(), () => '');
		if (!token) throw unreachable(NOT_REACHABLE);

		return call(send, {
			port: apiPort,
			token,
			method,
			apiPath,
			query,
			body,
			timeout,
			gone: NOT_REACHABLE,
			refused: 'Snippet Editor refused the token. Open the app and check "API for other tools" in its Settings.',
		});
	}

	return { settings, request };
}

// In the app's own chat, each message has a listener of its own, and the app
// names it in a file whose path it gives this program. The listener is gone
// when the answer ends, so a call that finds nothing there means just that.
const ENDED = 'This chat has ended. The person can send their message again.';

export function createChatClient({ sessionFile }) {
	const send = createSender(ENDED);

	// Read for each call: the file is the one thing that says where to go.
	async function session() {
		try {
			const raw = JSON.parse(await fs.readFile(sessionFile, 'utf8'));
			if (Number.isInteger(raw?.port) && raw.port >= 1 && raw.port <= 65535 && typeof raw.token === 'string' && raw.token) return raw;
		} catch {
			// Gone or damaged: the same answer either way.
		}
		throw unreachable(ENDED);
	}

	async function request(method, apiPath, { query, body, timeout = 15_000 } = {}) {
		const { port, token } = await session();
		return call(send, { port, token, method, apiPath, query, body, timeout, gone: ENDED, refused: ENDED });
	}

	return {
		// Whether changes are allowed is asked when the person presses Apply,
		// inside the app. Nothing here writes, so nothing here needs to know.
		settings: async () => ({ apiEnabled: true, apiPort: null, aiWrite: false }),
		request,
		// The change the model asked for, handed to the app to show as a card.
		async propose({ tool, args }) {
			const reply = await request('POST', '/chat/proposals', { body: { tool, args }, timeout: 30_000 });
			if (reply.status === 201) return { id: reply.body.id };
			return { error: reply.body?.error?.message ?? `The app answered ${reply.status}.` };
		},
	};
}
