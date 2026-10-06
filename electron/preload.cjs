// Runs sandboxed in the renderer. Exposes a narrow, allow-listed bridge and
// nothing of Node or Electron itself.
const { contextBridge, ipcRenderer } = require('electron');

const CHANNELS = new Set([
	'state:load',
	'file:read',
	'file:create',
	'file:delete',
	'file:saveRaw',
	'file:setHeader',
	'match:create',
	'match:update',
	'match:delete',
	'match:preview',
	'yaml:parse',
	'yaml:stringify',
	'settings:chooseMatchDir',
	'settings:resetMatchDir',
	'shell:reveal',
	'clipboard:write',
]);
const EVENTS = new Set(['data:changed', 'menu:command']);

contextBridge.exposeInMainWorld('snippetEditor', {
	platform: process.platform,
	invoke(channel, ...args) {
		if (!CHANNELS.has(channel)) return Promise.reject(new Error(`Unknown channel: ${channel}`));
		return ipcRenderer.invoke(channel, ...args);
	},
	on(event, listener) {
		if (!EVENTS.has(event)) throw new Error(`Unknown event: ${event}`);
		const wrapped = (_event, ...args) => listener(...args);
		ipcRenderer.on(event, wrapped);
		return () => ipcRenderer.removeListener(event, wrapped);
	},
});
