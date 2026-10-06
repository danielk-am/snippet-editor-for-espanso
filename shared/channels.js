// Every request the renderer may make of the main process. The preload
// script carries the same list (it is CommonJS and sandboxed, so it cannot
// import this file); test/channels.test.js keeps the two in step.
export const CHANNELS = [
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
];

export const EVENTS = ['data:changed', 'menu:command'];
