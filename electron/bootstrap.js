import { createListenerControl } from '../core/apiListener.js';
import { createRouter } from '../core/apiRouter.js';
import { createChat } from '../core/chat/chat.js';
import { createService } from '../core/service.js';
import { registerIpc } from './ipc.js';

// Everything behind the window, wired once. The app and the end-to-end test
// both start here, so the test exercises the wiring the app really uses.
//
// The last five options are for that test: a stand-in clipboard and browser,
// a git that may use a repository in a temporary folder, and stand-ins for
// the chat's backends. The app passes none of them.
export async function startBackend({ ipcMain, userDataDir, env, onChange, onChatEvent = () => {}, getWindow, isTrustedSender, mcp, clipboard, openExternal, git, allowLocalRepositories, chatOptions = {} }) {
	const service = await createService({ userDataDir, env, onChange, git, allowLocalRepositories });
	const router = createRouter({ service });
	const listener = createListenerControl({ service, router });
	const chat = createChat({ service, router, dataDir: userDataDir, mcp, emit: onChatEvent, ...chatOptions });
	registerIpc({ ipcMain, service, router, listener, chat, getWindow, isTrustedSender, mcp, clipboard, openExternal });
	await listener.apply();
	return {
		service,
		listener,
		chat,
		async dispose() {
			await chat.dispose();
			service.dispose();
			await listener.stop();
		},
	};
}
