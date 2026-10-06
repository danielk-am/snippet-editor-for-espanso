// The window's side of the app's API. Snippet work goes to the same routes
// the HTTP API serves, over the bridge the preload script exposes; the main
// process hands each request to the one router. Replies carry a status and a
// body, and a failure is rethrown here with its code, so callers can tell a
// conflict from a parse error.
const bridge = window.snippetEditor;

async function call(channel, ...args) {
	const result = await bridge.invoke(channel, ...args);
	if (result.ok) return result.data;
	throw Object.assign(new Error(result.error.message), { code: result.error.code });
}

async function request(method, path, { query, body } = {}) {
	const reply = await call('api:request', { method, path: `/api/v1${path}`, query, body });
	if (reply.status < 400) return reply.body;
	throw Object.assign(new Error(reply.body.error.message), { code: reply.body.error.code });
}

const idOf = (ref) => (ref.source === 'local' ? `local:${ref.name}` : `package:${ref.package}:${ref.name}`);
const file = (ref) => `/files/${encodeURIComponent(idOf(ref))}`;

export const platform = bridge.platform;

export const api = {
	load: () => request('GET', '/state'),
	readFile: (ref) => request('GET', file(ref)),
	createFile: (input) => request('POST', '/files', { body: input }),
	deleteFile: (ref, { version } = {}) => request('DELETE', file(ref), { query: { version } }),
	saveRaw: (ref, input) => request('PUT', `${file(ref)}/raw`, { body: input }),
	setHeader: (ref, input) => request('PUT', `${file(ref)}/details`, { body: input }),
	createMatch: (ref, input) => request('POST', `${file(ref)}/snippets`, { body: input }),
	updateMatch: (ref, { index, ...input }) => request('PUT', `${file(ref)}/snippets/${index}`, { body: input }),
	deleteMatch: (ref, { index, version }) => request('DELETE', `${file(ref)}/snippets/${index}`, { query: { version } }),
	previewMatch: async (match) => (await request('POST', '/yaml/preview', { body: { match } })).yaml,
	parseYaml: async (text) => (await request('POST', '/yaml/parse', { body: { text } })).value,
	stringifyYaml: async (value) => (await request('POST', '/yaml/stringify', { body: { value } })).yaml,

	// Things only a window can ask for.
	chooseMatchDir: () => call('settings:chooseMatchDir'),
	resetMatchDir: () => call('settings:resetMatchDir'),
	reveal: (target) => call('shell:reveal', target),
	copy: (text) => call('clipboard:write', text),
	listener: () => call('listener:get'),
	setListener: (input) => call('listener:set', input),
	replaceToken: () => call('listener:replaceToken'),
	copyFromListener: (what) => call('listener:copy', what),
	on: (event, listener) => bridge.on(event, listener),
};

export function refOf(file) {
	return file.source === 'local'
		? { source: 'local', name: file.name }
		: { source: 'package', package: file.package, name: file.name };
}

export const allFiles = (state) => [...state.files, ...state.packages.flatMap((pkg) => pkg.files)];
export const findFile = (state, id) => allFiles(state).find((file) => file.id === id);
