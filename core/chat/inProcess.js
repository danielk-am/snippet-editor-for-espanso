import { carried } from '../apiServer.js';

// The app's routes, for a caller inside the app that works like an outside
// one: the chat's tools. A request and its reply are shaped exactly as a
// socket would carry them (query values as text, bodies as JSON, a file that
// JSON cannot carry marked and not sent), so a tool behaves the same whether
// Ollama called it here or Claude Code called it through the MCP server.
export function createInProcessApi({ router, aiWrite }) {
	return {
		settings: async () => ({ apiEnabled: true, apiPort: null, aiWrite: aiWrite() === true }),

		async request(method, apiPath, { query = {}, body } = {}) {
			const asText = Object.fromEntries(
				Object.entries(query)
					.filter(([, value]) => value !== undefined)
					.map(([key, value]) => [key, String(value)])
			);
			const result = await router({ method, path: `/api/v1${apiPath}`, query: asText, body: body === undefined ? undefined : JSON.parse(JSON.stringify(body)) });
			const { status, text } = carried(result.status, result.body);
			return { status, body: JSON.parse(text) };
		},
	};
}
