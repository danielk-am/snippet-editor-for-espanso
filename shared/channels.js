// Every request the window may make of the main process. Snippet work all
// goes through one channel, `api:request`, which carries the same routes the
// HTTP API serves. The rest are things only a window can ask for: native
// dialogs, the clipboard, control of the HTTP listener, and the chat.
//
// The preload script carries the same list (it is CommonJS and sandboxed, so
// it cannot import this file); test/channels.test.js keeps the two in step.
export const CHANNELS = [
	'api:request',
	'settings:chooseMatchDir',
	'settings:resetMatchDir',
	'shell:reveal',
	'clipboard:write',
	'team:connect',
	'team:disconnect',
	'team:openLink',
	'ai:get',
	'ai:set',
	'listener:get',
	'listener:set',
	'listener:replaceToken',
	'listener:copy',
	'chat:status',
	'chat:send',
	'chat:stop',
	'chat:apply',
	'chat:dismiss',
];

export const EVENTS = ['data:changed', 'menu:command', 'chat:event'];
