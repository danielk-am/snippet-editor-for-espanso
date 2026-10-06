import { createApiServer } from './apiServer.js';
import { loadToken, replaceToken } from './apiToken.js';

// Keeps the HTTP listener in step with the settings: off unless it was
// switched on, restarted when the port changes, and never a reason for the
// rest of the app to fail. The token stays on this side; what the window is
// told never includes it.

const invalid = (message) => Object.assign(new Error(message), { code: 'INVALID' });

export function createListenerControl({ service, router }) {
	let token = null;
	let problem = '';
	const server = createApiServer({ handle: router, getToken: () => token });

	// One change at a time: a second click on the switch waits for the first
	// to finish, so the listener always ends in the state asked for last.
	let queue = Promise.resolve();
	const inTurn = (work) => {
		const run = queue.then(work);
		queue = run.catch(() => {});
		return run;
	};

	const currentToken = async () => (token ??= await loadToken(service.tokenFile));

	async function restart() {
		const { apiEnabled, apiPort } = service.settings();
		await server.stop();
		problem = '';
		if (!apiEnabled) return;
		try {
			await currentToken();
		} catch {
			problem = 'The API token could not be saved, so the API is not running.';
			return;
		}
		try {
			await server.start(apiPort);
		} catch (error) {
			problem = error.code === 'PORT_IN_USE' ? error.message : `The API could not start: ${error.message}`;
		}
	}

	function status() {
		const { apiEnabled, apiPort } = service.settings();
		return { enabled: apiEnabled, running: server.running, port: apiPort, address: `http://127.0.0.1:${apiPort}/api/v1`, problem };
	}

	return {
		apply: () => inTurn(restart),
		status: async () => status(),
		stop: () => inTurn(() => server.stop()),

		async set({ enabled, port } = {}) {
			if (typeof enabled !== 'boolean') throw invalid('`enabled` must be true or false.');
			if (!Number.isInteger(port) || port < 1024 || port > 65535) throw invalid('The port must be a whole number from 1024 to 65535.');
			return inTurn(async () => {
				await service.saveSettings({ apiEnabled: enabled, apiPort: port });
				await restart();
				return status();
			});
		},

		replaceToken: () =>
			inTurn(async () => {
				token = await replaceToken(service.tokenFile);
				return status();
			}),

		async textToCopy(what) {
			const { apiPort } = service.settings();
			if (what === 'token') return currentToken();
			if (what === 'curl') return `curl -H "Authorization: Bearer ${await currentToken()}" http://127.0.0.1:${apiPort}/api/v1/state`;
			throw invalid('Nothing to copy.');
		},
	};
}
