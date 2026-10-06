import path from 'node:path';

// What an AI tool needs in its settings to start the MCP server that comes
// with this copy of the app. The app's own program runs it, so nobody needs
// Node installed. Paths only: no token or other secret is part of it.
export function mcpSetup({ packaged, execPath, resourcesPath, appPath }) {
	// Installed, the mcp/ folder sits unpacked beside the app's archive,
	// because a program cannot be started from inside the archive.
	const script = packaged ? path.join(resourcesPath, 'app.asar.unpacked', 'mcp', 'server.mjs') : path.join(appPath, 'mcp', 'server.mjs');
	return { command: execPath, args: [script], env: { ELECTRON_RUN_AS_NODE: '1' } };
}

// The block most AI tools take in their MCP settings.
export const mcpSetupText = (setup) => JSON.stringify({ mcpServers: { 'snippet-editor': setup } }, null, 2) + '\n';

// Codex keeps its MCP servers in a TOML file. A JSON string is also a valid
// TOML string, which takes care of backslashes and spaces in a path.
export const mcpSetupToml = ({ command, args, env }) =>
	[
		'[mcp_servers.snippet-editor]',
		`command = ${JSON.stringify(command)}`,
		`args = [${args.map((arg) => JSON.stringify(arg)).join(', ')}]`,
		'',
		'[mcp_servers.snippet-editor.env]',
		...Object.entries(env).map(([key, value]) => `${key} = ${JSON.stringify(value)}`),
		'',
	].join('\n');

// The setup names where this copy of the app is. Some places do not last:
// a disk image, the folder macOS runs a freshly downloaded app from, or the
// mount an AppImage makes for one run. A setup copied there stops working.
export function mcpSetupWarning({ execPath, env = process.env }) {
	const passing = execPath.startsWith('/Volumes/') || execPath.includes('/AppTranslocation/') || Boolean(env.APPIMAGE);
	if (!passing) return '';
	const fix = env.APPIMAGE ? 'On Linux, use the tar.gz build for this.' : 'Move the app to your Applications folder, open it from there, and copy the setup again.';
	return `This copy of the app is running from a place that will not last, so this setup will stop working. ${fix}`;
}
