import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserWindow, dialog, shell } from 'electron';
import { isSameFile } from '../core/appPage.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const INDEX_FILE = path.join(here, '..', 'renderer', 'index.html');
// Shown in the window frame and taskbar on Windows and Linux. macOS takes
// the icon from the packaged app instead.
export const ICON_FILE = path.join(here, '..', 'build', 'icon-glass.png');

const isAppPage = (url) => isSameFile(url, INDEX_FILE);

// Only the app's own page may call the main process.
export const isTrustedSender = (event) => isAppPage(event.senderFrame?.url ?? '');

export function createMainWindow({ webPreferences, confirmClose = (window) => dialog.showMessageBox(window, {
	type: 'warning', message: 'Save your changes before closing?',
	detail: 'Your snippet or YAML file has unsaved edits.',
	buttons: ['Save', 'Discard', 'Cancel'], defaultId: 0, cancelId: 2, noLink: true,
}).then(({ response }) => response), onCloseAccepted = () => {}, onCloseCancelled = () => {}, ...options } = {}) {
	const win = new BrowserWindow({
		width: 1280,
		height: 820,
		minWidth: 760,
		minHeight: 520,
		show: false,
		title: 'Snippet Editor for Espanso',
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

	// Check the live editor before Electron reaches will-quit, where backend
	// disposal begins. Repeated close requests share one decision.
	let accepted = false;
	let checking = false;
	win.on('close', (event) => {
		if (accepted) return;
		event.preventDefault();
		if (checking) return;
		checking = true;
		(async () => {
			const dirty = await win.webContents.executeJavaScript('Boolean(window.snippetEditorHasUnsavedChanges?.())');
			if (dirty) {
				const choice = await confirmClose(win);
				if (choice !== 0 && choice !== 1) { onCloseCancelled(); return; }
				const done = await win.webContents.executeJavaScript(`window.snippetEditorCloseAction?.('${choice === 0 ? 'save' : 'discard'}') ?? false`);
				if (!done) { onCloseCancelled(); return; }
			}
			accepted = true;
			win.once('closed', onCloseAccepted);
			win.close();
		})().catch(() => onCloseCancelled()).finally(() => { checking = false; });
	});

	win.loadFile(INDEX_FILE);
	return win;
}
