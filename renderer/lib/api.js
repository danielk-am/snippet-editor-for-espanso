// The renderer's only way to the main process: the allow-listed bridge the
// preload script exposes. Failures arrive as data and are rethrown here with
// their code, so callers can tell a conflict from a parse error.
const bridge = window.snippetEditor;

async function call(channel, ...args) {
	const result = await bridge.invoke(channel, ...args);
	if (result.ok) return result.data;
	throw Object.assign(new Error(result.error.message), { code: result.error.code });
}

export const platform = bridge.platform;

export const api = {
	load: () => call('state:load'),
	readFile: (ref) => call('file:read', ref),
	createFile: (input) => call('file:create', input),
	deleteFile: (ref, input) => call('file:delete', ref, input),
	saveRaw: (ref, input) => call('file:saveRaw', ref, input),
	setHeader: (ref, input) => call('file:setHeader', ref, input),
	createMatch: (ref, input) => call('match:create', ref, input),
	updateMatch: (ref, input) => call('match:update', ref, input),
	deleteMatch: (ref, input) => call('match:delete', ref, input),
	previewMatch: (match) => call('match:preview', match),
	parseYaml: (text) => call('yaml:parse', text),
	stringifyYaml: (value) => call('yaml:stringify', value),
	chooseMatchDir: () => call('settings:chooseMatchDir'),
	resetMatchDir: () => call('settings:resetMatchDir'),
	reveal: (target) => call('shell:reveal', target),
	copy: (text) => call('clipboard:write', text),
	on: (event, listener) => bridge.on(event, listener),
};

export function refOf(file) {
	return file.source === 'local'
		? { source: 'local', name: file.name }
		: { source: 'package', package: file.package, name: file.name };
}

export const allFiles = (state) => [...state.files, ...state.packages.flatMap((pkg) => pkg.files)];
export const findFile = (state, id) => allFiles(state).find((file) => file.id === id);
