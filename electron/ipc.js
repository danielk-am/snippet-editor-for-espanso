import fs from 'node:fs/promises';
import { clipboard, dialog, shell } from 'electron';
import { parseDocument, stringify } from 'yaml';
import { stringifyMatch } from '../core/matchFile.js';

// One handler per channel in shared/channels.js. Failures travel back as
// data, because Electron strips custom fields (the error code) from a thrown
// error on its way to the renderer.
export function registerIpc({ ipcMain, services, getWindow, isTrustedSender }) {
	const handle = (channel, fn) =>
		ipcMain.handle(channel, async (event, ...args) => {
			try {
				if (!isTrustedSender(event)) throw Object.assign(new Error('Request refused.'), { code: 'FORBIDDEN' });
				return { ok: true, data: await fn(...args) };
			} catch (error) {
				return { ok: false, error: { code: error.code ?? 'ERROR', message: error.message } };
			}
		});

	handle('state:load', () => services.state());

	handle('file:read', (ref) => services.store.readFile(ref));
	handle('file:create', (input) => services.store.createFile(input));
	handle('file:delete', (ref, input) => services.store.deleteFile(ref, input));
	handle('file:saveRaw', (ref, input) => services.store.saveRaw(ref, input));
	handle('file:setHeader', (ref, input) => services.store.setHeader(ref, input));

	handle('match:create', (ref, input) => services.store.createMatch(ref, input));
	handle('match:update', (ref, input) => services.store.updateMatch(ref, input));
	handle('match:delete', (ref, input) => services.store.deleteMatch(ref, input));
	handle('match:preview', (match) => stringifyMatch(match));

	handle('yaml:parse', (text) => {
		const doc = parseDocument(String(text ?? ''));
		if (doc.errors.length) {
			throw Object.assign(new Error(doc.errors[0].message.split('\n')[0]), { code: 'PARSE_ERROR' });
		}
		return doc.toJS() ?? null;
	});
	handle('yaml:stringify', (value) => stringify(value, { lineWidth: 0 }));

	handle('settings:chooseMatchDir', async () => {
		const result = await dialog.showOpenDialog(getWindow(), {
			title: 'Choose the Espanso match folder',
			defaultPath: services.store.matchDir,
			properties: ['openDirectory', 'createDirectory'],
		});
		if (result.canceled || !result.filePaths[0]) return { changed: false };
		await services.setMatchDir(result.filePaths[0]);
		return { changed: true };
	});
	handle('settings:resetMatchDir', async () => {
		await services.setMatchDir(null);
		return { changed: true };
	});

	handle('shell:reveal', async (target) => {
		const dir = target === 'backups' ? services.backupDir : target === 'matchDir' ? services.store.matchDir : null;
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
}
