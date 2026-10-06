#!/usr/bin/env node
// A stand-in for Claude Code and for Codex, for tests. No model is called.
//
// It is started with the arguments the app really passes, finds the MCP
// server the app told it to start, starts it, and prints lines in the same
// format as the tool it stands in for. What it "says" and which tools it
// calls are scripted by the person's message, one step per line:
//
//   SAY <text>                 answer with this text (\\n in it is a new line)
//   SEARCH <words>             call snippets_search
//   ADD <trigger>=<text>       read base.yml, then call snippets_add_snippet
//   UPDATE <position>=<text>   read that snippet of base.yml, then call snippets_update_snippet
//   DELETE <position>          read base.yml, then call snippets_delete_snippet
//   COMMAND <trigger>          propose a snippet that runs a command
//   BIG <lines>                propose a snippet ;big whose text has that many lines
//   PID                        answer with its own process number
//   WAIT <milliseconds>        pause
//   HANG                       stop printing and stay alive
//   FLOOD                      print text without end
//   EXIT <code> <stderr>       end at once with this code, saying this on standard error
//   SIGNEDOUT                  end the way the real tool does when signed out
//   EXTRATOOL                  (Claude Code) list a tool the app did not give
//   SHELL                      (Codex) report running a command
//   ARGS                       answer with its own arguments and working folder
//
// The same file stands in for both: `exec` as the first argument means Codex.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const codex = args[0] === 'exec';
const print = (line) => process.stdout.write(`${JSON.stringify(line)}\n`);

let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += chunk;
const message = /<new_message>\n([\s\S]*)\n<\/new_message>/.exec(input)?.[1] ?? '';
const steps = message.split('\n').filter(Boolean);

// --- the MCP server the app named ---------------------------------------------------------

function serverSetup() {
	if (!codex) return JSON.parse(readFileSync(args[args.indexOf('--mcp-config') + 1], 'utf8')).mcpServers.snippets;
	const value = (key) => args.find((arg) => arg.startsWith(`mcp_servers.snippets.${key}=`)).slice(`mcp_servers.snippets.${key}=`.length);
	// A TOML inline table of strings, read as JSON.
	const env = JSON.parse(value('env').replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*) = /g, '$1"$2": '));
	return { command: JSON.parse(value('command')), args: JSON.parse(value('args')), env };
}

let server = null;
let nextId = 0;
const waiting = new Map();
async function mcp(method, params) {
	if (!server) {
		const setup = serverSetup();
		server = spawn(setup.command, setup.args, { env: { ...process.env, ...setup.env }, stdio: ['pipe', 'pipe', 'inherit'] });
		let out = '';
		server.stdout.setEncoding('utf8');
		server.stdout.on('data', (chunk) => {
			out += chunk;
			let at;
			while ((at = out.indexOf('\n')) !== -1) {
				const reply = JSON.parse(out.slice(0, at));
				out = out.slice(at + 1);
				waiting.get(reply.id)?.(reply);
			}
		});
		await mcp('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fake-agent', version: '1' } });
		server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
	}
	nextId += 1;
	const id = nextId;
	const reply = await new Promise((resolve) => {
		waiting.set(id, resolve);
		server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
	});
	return reply.result;
}
const callTool = (name, input) => mcp('tools/call', { name, arguments: input });

// --- printing, in each tool's own format --------------------------------------------------

let item = 0;
let messageId = 0;
const say = (text) => {
	if (codex) {
		item += 1;
		return print({ type: 'item.completed', item: { id: `item_${item}`, type: 'agent_message', text } });
	}
	messageId += 1;
	print({ type: 'stream_event', event: { type: 'message_start', message: { id: `msg_${messageId}` } }, parent_tool_use_id: null });
	print({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, parent_tool_use_id: null });
	for (const piece of text.match(/.{1,12}/gs) ?? []) print({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } }, parent_tool_use_id: null });
	print({ type: 'assistant', message: { id: `msg_${messageId}`, role: 'assistant', content: [{ type: 'text', text }] }, parent_tool_use_id: null });
};

async function use(name, input) {
	item += 1;
	const id = codex ? `item_${item}` : `toolu_${item}`;
	if (codex) print({ type: 'item.started', item: { id, type: 'mcp_tool_call', server: 'snippets', tool: name, arguments: input, result: null, error: null, status: 'in_progress' } });
	else print({ type: 'assistant', message: { id: `msg_${messageId}`, role: 'assistant', content: [{ type: 'tool_use', id, name: `mcp__snippets__${name}`, input }] }, parent_tool_use_id: null });
	const result = await callTool(name, input);
	if (codex) print({ type: 'item.completed', item: { id, type: 'mcp_tool_call', server: 'snippets', tool: name, arguments: input, result: { content: result.content, structured_content: result.structuredContent ?? null }, error: null, status: 'completed' } });
	else print({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: result.content, ...(result.isError ? { is_error: true } : {}) }] }, parent_tool_use_id: null });
	return result;
}

const finish = (code = 0) => {
	server?.kill();
	process.exit(code);
};

// --- the start of an answer ---------------------------------------------------------------

if (steps[0]?.startsWith('EXIT ')) {
	const [, code, ...words] = steps[0].split(' ');
	process.stderr.write(`${words.join(' ')}\n`);
	process.exit(Number(code));
}

if (steps.includes('SIGNEDOUT')) {
	if (codex) print({ type: 'turn.failed', error: { message: 'Not logged in. Run codex login.' } });
	else {
		print({ type: 'system', subtype: 'init', tools: ['mcp__snippets__snippets_search'], mcp_servers: [{ name: 'snippets', status: 'connected' }] });
		print({ type: 'assistant', message: { id: 'synthetic', role: 'assistant', content: [{ type: 'text', text: 'Not logged in · Please run /login' }] }, parent_tool_use_id: null, error: 'authentication_failed' });
		print({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login' });
	}
	process.exit(1);
}

if (codex) {
	print({ type: 'thread.started', thread_id: 'fake' });
	print({ type: 'turn.started' });
} else {
	const listed = (await mcp('tools/list', {})).tools.map((tool) => `mcp__snippets__${tool.name}`);
	print({ type: 'system', subtype: 'init', tools: steps.includes('EXTRATOOL') ? [...listed, 'Bash'] : listed, mcp_servers: [{ name: 'snippets', status: 'connected' }] });
}

// --- the steps -----------------------------------------------------------------------------

for (const step of steps) {
	const [word, ...rest] = step.split(' ');
	const text = rest.join(' ');
	if (word === 'SAY') say(text.replaceAll('\\n', '\n'));
	else if (word === 'WAIT') await new Promise((resolve) => setTimeout(resolve, Number(text)));
	else if (word === 'UPDATE') {
		const [position, replace] = text.split('=');
		const found = await use('snippets_get_snippet', { file_id: 'local:base.yml', index: Number(position) });
		await use('snippets_update_snippet', { file_id: 'local:base.yml', index: Number(position), snippet: { ...found.structuredContent.snippet, replace: replace.replaceAll('\\n', '\n') }, version: found.structuredContent.version });
	} else if (word === 'DELETE') {
		const file = await use('snippets_get_file', { file_id: 'local:base.yml' });
		await use('snippets_delete_snippet', { file_id: 'local:base.yml', index: Number(text), version: file.structuredContent.version });
	} else if (word === 'BIG') {
		const file = await use('snippets_get_file', { file_id: 'local:base.yml' });
		const replace = Array.from({ length: Number(text) }, (_, index) => `Line ${index + 1} of ${text}`).join('\n');
		await use('snippets_add_snippet', { file_id: 'local:base.yml', snippet: { trigger: ';big', replace }, version: file.structuredContent.version });
	} else if (word === 'PID') say(String(process.pid));
	else if (word === 'COMMAND') {
		const file = await use('snippets_get_file', { file_id: 'local:base.yml' });
		await use('snippets_add_snippet', { file_id: 'local:base.yml', snippet: { trigger: text, replace: '{{ip}}', vars: [{ name: 'ip', type: 'shell', params: { cmd: 'ipconfig getifaddr en0' } }] }, version: file.structuredContent.version });
	}
	else if (word === 'SEARCH') await use('snippets_search', { query: text });
	else if (word === 'ADD') {
		const [trigger, replace] = text.split('=');
		const file = await use('snippets_get_file', { file_id: 'local:base.yml' });
		await use('snippets_add_snippet', { file_id: 'local:base.yml', snippet: { trigger, replace }, version: file.structuredContent.version });
	} else if (word === 'ARGS') say(JSON.stringify({ args, cwd: process.cwd(), input }));
	else if (word === 'SHELL') print({ type: 'item.started', item: { id: 'cmd', type: 'command_execution', command: 'cat /etc/hosts', aggregated_output: '', exit_code: null, status: 'in_progress' } });
	else if (word === 'HANG') await new Promise(() => setInterval(() => {}, 1000));
	else if (word === 'FLOOD') {
		for (;;) {
			say('more and more text '.repeat(50));
			await new Promise((resolve) => setTimeout(resolve, 2));
		}
	}
}

if (codex) print({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } });
else print({ type: 'result', subtype: 'success', is_error: false, result: 'done' });
// The real tools take a moment to leave after their last line.
await new Promise((resolve) => setTimeout(resolve, 300));
finish(0);
