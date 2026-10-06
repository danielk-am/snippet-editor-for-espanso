import { app, BrowserWindow, ipcMain, Menu } from 'electron';
import { createServices } from './services.js';
import { registerIpc } from './ipc.js';
import { ICON_FILE, createMainWindow, isTrustedSender } from './window.js';

let win = null;
const send = (channel, ...args) => {
	if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
};

function open() {
	win = createMainWindow();
	win.once('ready-to-show', () => win.show());
	win.on('closed', () => {
		win = null;
	});
}

function buildMenu() {
	const command = (label, accelerator, name) => ({ label, accelerator, click: () => send('menu:command', name) });
	const isMac = process.platform === 'darwin';
	return Menu.buildFromTemplate([
		...(isMac
			? [
					{
						label: app.name,
						submenu: [
							{ role: 'about' },
							{ type: 'separator' },
							command('Settings…', 'Cmd+,', 'settings'),
							{ type: 'separator' },
							{ role: 'hide' },
							{ role: 'hideOthers' },
							{ role: 'unhide' },
							{ type: 'separator' },
							{ role: 'quit' },
						],
					},
				]
			: []),
		{
			label: 'File',
			submenu: [
				command('New Snippet', 'CmdOrCtrl+N', 'new-snippet'),
				command('New File…', 'CmdOrCtrl+Shift+N', 'new-file'),
				{ type: 'separator' },
				command('Search…', 'CmdOrCtrl+K', 'search'),
				...(isMac ? [] : [{ type: 'separator' }, command('Settings', 'Ctrl+,', 'settings'), { role: 'quit' }]),
			],
		},
		{ role: 'editMenu' },
		{ role: 'viewMenu' },
		{ role: 'windowMenu' },
	]);
}

if (!app.requestSingleInstanceLock()) {
	app.quit();
} else {
	app.on('second-instance', () => {
		if (!win) return;
		if (win.isMinimized()) win.restore();
		win.focus();
	});

	app.whenReady().then(async () => {
		const services = await createServices({
			userDataDir: app.getPath('userData'),
			onChange: () => send('data:changed'),
		});
		registerIpc({ ipcMain, services, getWindow: () => win, isTrustedSender });
		// Run from source, macOS shows Electron's own icon in the Dock. The
		// packaged app carries its icon in the bundle and needs no help.
		if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(ICON_FILE);
		Menu.setApplicationMenu(buildMenu());
		open();

		app.on('activate', () => {
			if (BrowserWindow.getAllWindows().length === 0) open();
		});
		app.on('will-quit', () => services.dispose());
	});

	app.on('window-all-closed', () => {
		if (process.platform !== 'darwin') app.quit();
	});
}
