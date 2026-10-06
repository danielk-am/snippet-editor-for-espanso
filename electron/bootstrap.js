import { createListenerControl } from '../core/apiListener.js';
import { createRouter } from '../core/apiRouter.js';
import { createService } from '../core/service.js';
import { registerIpc } from './ipc.js';

// Everything behind the window, wired once. The app and the end-to-end test
// both start here, so the test exercises the wiring the app really uses.
//
// The last four options are for that test: a stand-in clipboard and browser,
// and a git that may use a repository in a temporary folder. The app passes
// none of them.
export async function startBackend({ ipcMain, userDataDir, env, onChange, getWindow, isTrustedSender, clipboard, openExternal, git, allowLocalRepositories }) {
	const service = await createService({ userDataDir, env, onChange, git, allowLocalRepositories });
	const router = createRouter({ service });
	const listener = createListenerControl({ service, router });
	registerIpc({ ipcMain, service, router, listener, getWindow, isTrustedSender, clipboard, openExternal });
	await listener.apply();
	return {
		service,
		listener,
		async dispose() {
			service.dispose();
			await listener.stop();
		},
	};
}
