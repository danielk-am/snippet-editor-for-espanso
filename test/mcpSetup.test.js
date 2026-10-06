import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mcpSetup, mcpSetupText } from '../electron/mcpSetup.js';

test('from source, the app\'s own program runs the server in the project folder', () => {
	assert.deepEqual(mcpSetup({ packaged: false, execPath: '/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron', resourcesPath: '/ignored', appPath: '/repo' }), {
		command: '/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
		args: ['/repo/mcp/server.mjs'],
		env: { ELECTRON_RUN_AS_NODE: '1' },
	});
});

test('installed, it runs the copy unpacked beside the app\'s archive', () => {
	assert.deepEqual(
		mcpSetup({
			packaged: true,
			execPath: '/Applications/Snippet Editor.app/Contents/MacOS/Snippet Editor',
			resourcesPath: '/Applications/Snippet Editor.app/Contents/Resources',
			appPath: '/Applications/Snippet Editor.app/Contents/Resources/app.asar',
		}),
		{
			command: '/Applications/Snippet Editor.app/Contents/MacOS/Snippet Editor',
			args: ['/Applications/Snippet Editor.app/Contents/Resources/app.asar.unpacked/mcp/server.mjs'],
			env: { ELECTRON_RUN_AS_NODE: '1' },
		}
	);
});

test('the text to copy is the block an AI tool\'s settings take, and holds no secret', () => {
	const setup = { command: '/Applications/Snippet Editor.app/Contents/MacOS/Snippet Editor', args: ['/x/mcp/server.mjs'], env: { ELECTRON_RUN_AS_NODE: '1' } };
	const text = mcpSetupText(setup);
	assert.deepEqual(JSON.parse(text), { mcpServers: { 'snippet-editor': setup } });
	assert.ok(text.endsWith('}\n'));
	assert.ok(!/token|Bearer|password/i.test(text));
});
