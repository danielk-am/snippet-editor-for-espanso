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

// The app's team status lists every connected repository. The pages still
// show one. Until they are redrawn to show several, each hands the status to
// this, which gives it the one that is connected, in the shape the status had
// when there could only be one. With none connected, or with more than one,
// that is "none".
export function oneRepository(status) {
	if (status.repositories.length !== 1) {
		return { id: null, connected: false, repository: null, webUrl: null, branch: null, commit: null, fetchedAt: null, problem: status.problem, problems: [], packages: [], installedOnly: status.installedOnly };
	}
	const [only] = status.repositories;
	// What is wrong with this repository, then what was wrong with the saved list.
	return { ...only, problem: [only.problem, status.problem].filter(Boolean).join(' '), installedOnly: [...only.installedOnly, ...status.installedOnly] };
}

// A page that has no repository to name holds null for its id. To the app
// that is no id at all, so it is left out.
const noId = (id) => id === undefined || id === null;
const idOrNone = (id) => (noId(id) ? undefined : id);

const idOf = (ref) => (ref.source === 'local' ? `local:${ref.name}` : `${ref.source}:${ref.package}:${ref.name}`);
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

	// Team snippets. Every call but `propose` and `openTeamLink` answers the
	// team status: every connected repository, each with its `id`. Where a call
	// names a repository, it is by that id. Left out, the app uses the only one
	// that could be meant, and refuses when there is more than one.
	team: () => request('GET', '/team'),
	// One repository, or all of them when no id is given.
	refreshTeam: (id) => request('POST', noId(id) ? '/team/refresh' : `/team/repositories/${encodeURIComponent(id)}/refresh`),
	installTeamPackage: (name, { repository, acceptCommands } = {}) => request('PUT', `/team/packages/${encodeURIComponent(name)}/installed`, { body: { repository: idOrNone(repository), acceptCommands } }),
	removeTeamPackage: (name) => request('DELETE', `/team/packages/${encodeURIComponent(name)}/installed`),
	// `repository` says which one the proposal is for.
	propose: ({ repository, ...input }) => request('POST', '/team/proposals', { body: { ...input, repository: idOrNone(repository) } }),
	connectTeam: (address) => call('team:connect', address),
	disconnectTeam: (id) => call('team:disconnect', idOrNone(id)),
	openTeamLink: (url) => call('team:openLink', url),

	// What AI tools may do, and how to connect one.
	ai: () => call('ai:get'),
	setAi: (input) => call('ai:set', input),

	// The chat. An answer arrives as `chat:event` messages.
	chatStatus: () => call('chat:status'),
	chatSend: (input) => call('chat:send', input),
	chatStop: (turnId) => call('chat:stop', turnId),
	chatApply: (id) => call('chat:apply', id),
	chatDismiss: (id) => call('chat:dismiss', id),

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
	return file.source === 'local' ? { source: 'local', name: file.name } : { source: file.source, package: file.package, name: file.name };
}

// Files come from three places: your own, packages Espanso installed, and
// team packages this app installed. The last two are read-only.
export const isLocal = (file) => file.source === 'local';
export const sourceLabel = (file) => (file.source === 'team' ? 'Team' : file.source === 'package' ? 'Packages' : 'Local');
// The package a file belongs to, or undefined for one of your own.
export const groupOf = (state, file) => (file.source === 'team' ? state.team : file.source === 'package' ? state.packages : []).find((pkg) => pkg.name === file.package);
export const allFiles = (state) => [...state.files, ...[...state.packages, ...state.team].flatMap((pkg) => pkg.files)];
export const findFile = (state, id) => allFiles(state).find((file) => file.id === id);
