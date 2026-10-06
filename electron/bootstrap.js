import { createListenerControl } from '../core/apiListener.js';
import { createRouter } from '../core/apiRouter.js';
import { createService } from '../core/service.js';
import { registerIpc } from './ipc.js';

// Everything behind the window, wired once. The app and the end-to-end test
// both start here, so the test exercises the wiring the app really uses.
export async function startBackend({ ipcMain, userDataDir, env, onChange, getWindow, isTrustedSender }) {
	const service = await createService({ userDataDir, env, onChange });
	const router = createRouter({ service });
	const listener = createListenerControl({ service, router });
	registerIpc({ ipcMain, service, router, listener, getWindow, isTrustedSender });
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
