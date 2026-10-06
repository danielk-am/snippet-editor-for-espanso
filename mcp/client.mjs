// How the MCP server reaches the app: over the app's own local API, with the
// token the app keeps in its data folder. This file imports nothing from the
// rest of the app, so the mcp/ folder can run on its own.
import fs from 'node:fs/promises';
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

export function createApiClient({ dataDir, fetch = globalThis.fetch }) {
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

	async function request(method, apiPath, { query = {}, body, timeout = 15_000 } = {}) {
		const { apiEnabled, apiPort } = await settings();
		if (!apiEnabled) throw unreachable(NOT_REACHABLE);

		const url = new URL(`http://127.0.0.1:${apiPort}/api/v1${apiPath}`);
		for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, String(value));

		// Read for each request, so a token replaced in Settings is picked up.
		const token = await fs.readFile(path.join(dataDir, 'api-token'), 'utf8').then((text) => text.trim(), () => '');
		if (!token) throw unreachable(NOT_REACHABLE);

		let response;
		try {
			response = await fetch(url, {
				method,
				headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
				body: body === undefined ? undefined : JSON.stringify(body),
				signal: AbortSignal.timeout(timeout),
			});
		} catch (error) {
			throw unreachable(error?.name === 'TimeoutError' ? 'Snippet Editor did not answer in time.' : NOT_REACHABLE);
		}
		if (response.status === 401) throw unreachable('Snippet Editor refused the token. Open the app and check "API for other tools" in its Settings.');
		try {
			return { status: response.status, body: await response.json() };
		} catch {
			// Something else is listening on that port.
			throw unreachable(NOT_REACHABLE);
		}
	}

	return { settings, request };
}
