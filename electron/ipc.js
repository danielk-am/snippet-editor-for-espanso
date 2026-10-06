import fs from 'node:fs/promises';
import { clipboard as systemClipboard, dialog, shell } from 'electron';
import { isTeamLink } from '../core/teamAddress.js';
import { mcpSetupText, mcpSetupToml, mcpSetupWarning } from './mcpSetup.js';

// One handler per channel in shared/channels.js. Failures travel back as
// data, because Electron strips custom fields (the error code) from a thrown
// error on its way to the renderer.
// `clipboard` and `openExternal` can be swapped for stand-ins, so a test can
// see what was copied or opened without touching the real clipboard or browser.
export function registerIpc({ ipcMain, service, router, listener, chat, getWindow, isTrustedSender, mcp, clipboard = systemClipboard, openExternal = shell.openExternal }) {
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

	// Which repository the app is connected to is a setting, so it is changed
	// from the window only, like the match folder.
	handle('team:connect', (address) => service.connectTeam(address));
	handle('team:disconnect', () => service.disconnectTeam());
	// The window may open the connected repository's own pages in the browser,
	// such as the page that starts a pull request, and nothing else.
	handle('team:openLink', async (url) => {
		if (!isTeamLink(url, service.team()?.address.webUrl ?? null)) throw Object.assign(new Error('That link is not part of the connected repository.'), { code: 'INVALID' });
		await openExternal(url);
		return true;
	});

	// What AI tools may do is a setting too. `setup` is the block an AI tool
	// needs to start the MCP server that comes with this copy of the app.
	const ai = () => ({
		write: service.settings().aiWrite,
		setup: mcp ? mcpSetupText(mcp) : '',
		setupToml: mcp ? mcpSetupToml(mcp) : '',
		warning: mcp ? mcpSetupWarning({ execPath: mcp.command }) : '',
	});
	handle('ai:get', ai);
	handle('ai:set', async (input) => {
		if (typeof input?.write !== 'boolean') throw Object.assign(new Error('`write` must be true or false.'), { code: 'INVALID' });
		await service.saveSettings({ aiWrite: input.write });
		return ai();
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

	// The chat. A message goes in here, and the answer comes back as
	// `chat:event` messages. A change the assistant proposes is written only
	// by `chat:apply`, which the person's own press of Apply sends.
	handle('chat:status', () => chat.status());
	handle('chat:send', (input) => chat.send(input));
	handle('chat:stop', (turnId) => {
		chat.stop(String(turnId ?? ''));
		return true;
	});
	handle('chat:apply', (id) => chat.apply(String(id ?? '')));
	handle('chat:dismiss', (id) => chat.dismiss(String(id ?? '')));
}
