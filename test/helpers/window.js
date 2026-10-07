// The window's way into the app, for a test: the real handlers from
// electron/ipc.js behind the bridge the preload script would put in front of
// them, and the window's own api module on top. No window is opened.
import module from 'node:module';
import { CHANNELS } from '../../shared/channels.js';

// electron/ipc.js imports Electron's clipboard, dialog and shell by name. In
// plain Node the `electron` package is only the path of the program, so an
// empty stand-in takes its place. Every test file runs in a process of its
// own, so this reaches no other test.
const STAND_IN = 'data:text/javascript,export const clipboard = {}; export const dialog = {}; export const shell = {};';
const resolve = (specifier, context, next) => (specifier === 'electron' ? { url: STAND_IN, shortCircuit: true } : next(specifier, context));
if (module.registerHooks) module.registerHooks({ resolve });
// Node before 22.15 has only the older way to say the same thing.
else module.register(`data:text/javascript,${encodeURIComponent(`const STAND_IN = ${JSON.stringify(STAND_IN)}; export const resolve = ${resolve};`)}`);

// The main process's side. `opened` and `copied` hold what would have reached
// the browser and the clipboard.
export async function mainProcess({ service, router, trusted = () => true, ...rest }) {
	const { registerIpc } = await import('../../electron/ipc.js');
	const handlers = new Map();
	const opened = [];
	const copied = [];
	registerIpc({
		ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
		service,
		router,
		isTrustedSender: trusted,
		clipboard: { writeText: (text) => copied.push(text) },
		openExternal: async (url) => void opened.push(url),
		...rest,
	});
	// As the preload script does it: a channel that is not declared goes
	// nowhere. What is sent and what comes back are copied, as they are on
	// their way between the window and the main process.
	const invoke = async (channel, ...args) => {
		if (!CHANNELS.includes(channel)) throw new Error(`Unknown channel: ${channel}`);
		return structuredClone(await handlers.get(channel)({}, ...structuredClone(args)));
	};
	return { invoke, opened, copied };
}

// renderer/lib/api.js, as the window loads it. It reads the bridge once, when
// it is first loaded, so the tests of one file share the module and each
// points it at its own main process.
let current = null;
export async function windowApi(main) {
	current = main;
	globalThis.window ??= { snippetEditor: { platform: 'test', on: () => () => {}, invoke: (...args) => current.invoke(...args) } };
	return import('../../renderer/lib/api.js');
}
