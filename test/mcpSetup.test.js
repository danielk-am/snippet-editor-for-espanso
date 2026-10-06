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

test('Codex takes the same setup as TOML', async () => {
	const { mcpSetupToml } = await import('../electron/mcpSetup.js');
	const setup = { command: 'C:\\Program Files\\Snippet Editor\\Snippet Editor.exe', args: ['C:\\Program Files\\Snippet Editor\\resources\\app.asar.unpacked\\mcp\\server.mjs'], env: { ELECTRON_RUN_AS_NODE: '1' } };
	assert.equal(
		mcpSetupToml(setup),
		[
			'[mcp_servers.snippet-editor]',
			'command = "C:\\\\Program Files\\\\Snippet Editor\\\\Snippet Editor.exe"',
			'args = ["C:\\\\Program Files\\\\Snippet Editor\\\\resources\\\\app.asar.unpacked\\\\mcp\\\\server.mjs"]',
			'',
			'[mcp_servers.snippet-editor.env]',
			'ELECTRON_RUN_AS_NODE = "1"',
			'',
		].join('\n')
	);
});

test('a copy of the app running from a place that will not last is said to be so', async () => {
	const { mcpSetupWarning } = await import('../electron/mcpSetup.js');
	const lasting = [
		{ execPath: '/Applications/Snippet Editor.app/Contents/MacOS/Snippet Editor', env: {} },
		{ execPath: '/opt/snippet-editor/snippet-editor-for-espanso', env: {} },
		{ execPath: 'C:\\Program Files\\Snippet Editor\\Snippet Editor.exe', env: {} },
	];
	for (const where of lasting) assert.equal(mcpSetupWarning(where), '', where.execPath);
	const passing = [
		{ execPath: '/Volumes/Snippet Editor 0.1.0/Snippet Editor.app/Contents/MacOS/Snippet Editor', env: {} },
		{ execPath: '/private/var/folders/kv/x/T/AppTranslocation/1234/d/Snippet Editor.app/Contents/MacOS/Snippet Editor', env: {} },
		{ execPath: '/tmp/.mount_snippeAbCdEf/snippet-editor-for-espanso', env: { APPIMAGE: '/home/someone/Downloads/snippet-editor.AppImage' } },
	];
	for (const where of passing) {
		assert.match(mcpSetupWarning(where), /^This copy of the app is running from a place that will not last/, where.execPath);
	}
});
