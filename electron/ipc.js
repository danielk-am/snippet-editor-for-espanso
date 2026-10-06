import fs from 'node:fs/promises';
import { clipboard, dialog, shell } from 'electron';

// One handler per channel in shared/channels.js. Failures travel back as
// data, because Electron strips custom fields (the error code) from a thrown
// error on its way to the renderer.
export function registerIpc({ ipcMain, service, router, listener, getWindow, isTrustedSender }) {
	const handle = (channel, fn) =>
		ipcMain.handle(channel, async (event, ...args) => {
			try {
				if (!isTrustedSender(event)) throw Object.assign(new Error('Request refused.'), { code: 'FORBIDDEN' });
				return { ok: true, data: await fn(...args) };
			} catch (error) {
				return { ok: false, error: { code: error.code ?? 'ERROR', message: error.message } };
			}
		});

	// The window's snippet work takes the same routes as the HTTP API, with
	// the same checks and the same replies. Only the carrier differs: this
	// channel instead of a socket, so the window needs no token.
	handle('api:request', (request) =>
		router({
			method: String(request?.method ?? ''),
			path: String(request?.path ?? ''),
			query: request?.query,
			body: request?.body,
		})
	);

	handle('settings:chooseMatchDir', async () => {
		const result = await dialog.showOpenDialog(getWindow(), {
			title: 'Choose the Espanso match folder',
			defaultPath: service.store.matchDir,
			properties: ['openDirectory', 'createDirectory'],
		});
		if (result.canceled || !result.filePaths[0]) return { changed: false };
		await service.setMatchDir(result.filePaths[0]);
		return { changed: true };
	});
	handle('settings:resetMatchDir', async () => {
		await service.setMatchDir(null);
		return { changed: true };
	});

	handle('shell:reveal', async (target) => {
		const dir = target === 'backups' ? service.backupDir : target === 'matchDir' ? service.store.matchDir : null;
		if (!dir) throw Object.assign(new Error('Nothing to show.'), { code: 'INVALID' });
		if (target === 'backups') await fs.mkdir(dir, { recursive: true });
		const failure = await shell.openPath(dir);
		if (failure) throw Object.assign(new Error(`That folder does not exist yet: ${dir}`), { code: 'NOT_FOUND' });
		return true;
	});

	handle('clipboard:write', (text) => {
		clipboard.writeText(String(text ?? ''));
		return true;
	});

	// The HTTP listener is controlled from the window only. Copying the token
	// happens here, so the token itself never enters the page.
	handle('listener:get', () => listener.status());
	handle('listener:set', (input) => listener.set(input));
	handle('listener:replaceToken', () => listener.replaceToken());
	handle('listener:copy', async (what) => {
		clipboard.writeText(await listener.textToCopy(what));
		return true;
	});
}
