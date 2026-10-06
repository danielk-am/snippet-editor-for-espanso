// The app's API, running for a test: the real service, router and listener
// on a throwaway copy of the fixtures, on a spare port.
import { cpSync, mkdtempSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createListenerControl } from '../../core/apiListener.js';
import { createRouter } from '../../core/apiRouter.js';
import { createService } from '../../core/service.js';

const FIXTURES = fileURLToPath(new URL('../fixtures/match', import.meta.url));

export function sparePort() {
	return new Promise((resolve) => {
		const probe = net.createServer();
		probe.listen(0, '127.0.0.1', () => {
			const { port } = probe.address();
			probe.close(() => resolve(port));
		});
	});
}

export async function startApi(t, { enabled = true, aiWrite = false, serviceOptions = {} } = {}) {
	const root = mkdtempSync(join(tmpdir(), 'snippet-editor-mcp-'));
	const matchDir = join(root, 'match');
	const dataDir = join(root, 'data');
	cpSync(FIXTURES, matchDir, { recursive: true });
	const service = await createService({ userDataDir: dataDir, env: { SNIPPET_EDITOR_MATCH_DIR: matchDir }, ...serviceOptions });
	const listener = createListenerControl({ service, router: createRouter({ service, log: () => {} }) });
	const port = await sparePort();
	await service.saveSettings({ aiWrite });
	await listener.set({ enabled, port });
	t.after(async () => {
		await listener.stop();
		service.dispose();
	});
	return { root, matchDir, dataDir, service, listener, port };
}
