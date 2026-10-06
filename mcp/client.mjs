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

export function createApiClient({ dataDir }) {
	const direct = new http.Agent();

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

	// One request to 127.0.0.1, answered as a status and parsed JSON.
	function send({ port, method, target, headers = {}, body, timeout }) {
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
						reject(unreachable(NOT_REACHABLE));
					}
				});
			});
			request.on('error', (error) => reject(error.code === 'UNREACHABLE' ? error : unreachable(error.name === 'AbortError' || error.code === 'ABORT_ERR' ? 'Snippet Editor did not answer in time.' : NOT_REACHABLE)));
			request.end(body);
		});
	}

	async function request(method, apiPath, { query = {}, body, timeout = 15_000 } = {}) {
		const { apiEnabled, apiPort } = await settings();
		// With its API off the app is not listening, and whatever else holds
		// that port must not be sent the token.
		if (!apiEnabled) throw unreachable(NOT_REACHABLE);

		// Read for each request, so a token replaced in Settings is picked up.
		const token = await fs.readFile(path.join(dataDir, 'api-token'), 'utf8').then((text) => text.trim(), () => '');
		if (!token) throw unreachable(NOT_REACHABLE);

		// Proof first: only the app can answer this for a number chosen here.
		const nonce = randomBytes(16).toString('hex');
		const proof = await send({ port: apiPort, method: 'GET', target: `/api/v1/proof?nonce=${nonce}`, timeout });
		const expected = createHmac('sha256', token).update(nonce).digest();
		const given = Buffer.from(typeof proof.body?.proof === 'string' ? proof.body.proof : '', 'hex');
		if (proof.status !== 200 || given.length !== expected.length || !timingSafeEqual(given, expected)) throw unreachable(NOT_REACHABLE);

		const search = new URLSearchParams(Object.entries(query).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)])).toString();
		const payload = body === undefined ? undefined : JSON.stringify(body);
		const reply = await send({
			port: apiPort,
			method,
			target: `/api/v1${apiPath}${search ? `?${search}` : ''}`,
			headers: { Authorization: `Bearer ${token}`, ...(payload === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }) },
			body: payload,
			timeout,
		});
		if (reply.status === 401) throw unreachable('Snippet Editor refused the token. Open the app and check "API for other tools" in its Settings.');
		return reply;
	}

	return { settings, request };
}
