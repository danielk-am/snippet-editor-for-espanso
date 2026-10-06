// One call to the MCP server, from a command line, for the usability check.
//
//   node test/mcp-eval/ask.mjs --list
//   node test/mcp-eval/ask.mjs snippets_search '{"query":"refund"}'
//
// It starts the real server, speaks the protocol to it, and prints what an
// AI tool would be given.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
let dataDir;
try {
	dataDir = readFileSync(`${here}.session`, 'utf8').trim();
} catch {
	console.error('Start the API first: node test/mcp-eval/serve.mjs');
	process.exit(1);
}

const [name, json = '{}'] = process.argv.slice(2);
let args;
try {
	args = JSON.parse(json);
} catch {
	console.error('The second argument must be JSON, such as \'{"query":"refund"}\'.');
	process.exit(1);
}

const server = spawn(process.execPath, [`${here}../../mcp/server.mjs`], { env: { ...process.env, SNIPPET_EDITOR_DATA_DIR: dataDir }, stdio: ['pipe', 'pipe', 'inherit'] });
let out = '';
const replies = new Map();
server.stdout.on('data', (chunk) => {
	out += chunk;
	for (const line of out.split('\n').slice(0, -1)) {
		const message = JSON.parse(line);
		replies.get(message.id)?.(message);
	}
});
const send = (id, method, params) =>
	new Promise((resolve) => {
		replies.set(id, resolve);
		server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
	});

await send(1, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'usability-check', version: '1' } });
if (!name || name === '--list') {
	const { result } = await send(2, 'tools/list');
	for (const tool of result.tools) console.log(`${tool.name}\n  ${tool.description}\n  inputs: ${JSON.stringify(tool.inputSchema.properties)}\n  required: ${JSON.stringify(tool.inputSchema.required)}\n`);
} else {
	const reply = await send(2, 'tools/call', { name, arguments: args });
	if (reply.error) console.log(`PROTOCOL ERROR ${reply.error.code}: ${reply.error.message}`);
	else console.log(`${reply.result.isError ? 'TOOL ERROR: ' : ''}${reply.result.content[0].text}`);
}
server.stdin.end();
