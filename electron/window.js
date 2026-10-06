import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserWindow, shell } from 'electron';
import { isSameFile } from '../core/appPage.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const INDEX_FILE = path.join(here, '..', 'renderer', 'index.html');
// Shown in the window frame and taskbar on Windows and Linux. macOS takes
// the icon from the packaged app instead.
export const ICON_FILE = path.join(here, '..', 'build', 'icon.png');

const isAppPage = (url) => isSameFile(url, INDEX_FILE);

// Only the app's own page may call the main process.
export const isTrustedSender = (event) => isAppPage(event.senderFrame?.url ?? '');

export function createMainWindow({ webPreferences, ...options } = {}) {
	const win = new BrowserWindow({
		width: 1280,
		height: 820,
		minWidth: 760,
		minHeight: 520,
		show: false,
		title: 'Snippet Editor',
		backgroundColor: '#FFFFFF',
		titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
		...(process.platform === 'darwin' ? {} : { icon: ICON_FILE }),
		...options,
		webPreferences: {
			preload: path.join(here, 'preload.cjs'),
			contextIsolation: true,
			sandbox: true,
			nodeIntegration: false,
			...webPreferences,
		},
	});

	// The window shows one local page. Links open in the browser; nothing
	// else may navigate or open a window.
	win.webContents.setWindowOpenHandler(({ url }) => {
		if (url.startsWith('https://')) shell.openExternal(url);
		return { action: 'deny' };
	});
	win.webContents.on('will-navigate', (event, url) => {
		if (!isAppPage(url)) event.preventDefault();
	});

	win.loadFile(INDEX_FILE);
	return win;
}
