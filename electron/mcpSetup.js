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
