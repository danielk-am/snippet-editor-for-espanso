import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { codexArgs, createCodexParser } from '../core/chat/codex.js';

const fixture = (name) => readFileSync(fileURLToPath(new URL(`./fixtures/chat/${name}`, import.meta.url)), 'utf8').split('\n').filter(Boolean);
const NAMES = ['search', 'list_files', 'get_file', 'get_snippet', 'list_team_packages', 'add_snippet', 'update_snippet', 'delete_snippet', 'create_file', 'replace_file_yaml', 'install_team_package', 'propose_to_team'].map((name) => `snippets_${name}`);
const run = (lines, parser = createCodexParser({ tools: NAMES })) => lines.flatMap((line) => parser.push(typeof line === 'string' ? line : JSON.stringify(line)));
const item = (kind, id, type, rest = {}) => ({ type: `item.${kind}`, item: { id, type, ...rest } });
const message = (id, text) => item('completed', id, 'agent_message', { text });
const DONE = { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } };

// --- how it is started ---------------------------------------------------------------------

test('Codex is started with its shell, web search, sub-agents and the rest switched off, and the message is not among its arguments', () => {
	const args = codexArgs({
		cwd: '/data/chat/empty',
		system: 'You help with snippets.',
		mcp: { command: '/Applications/Snippet Editor.app/Contents/MacOS/Snippet Editor', args: ['/res/mcp/server.mjs'], env: { ELECTRON_RUN_AS_NODE: '1' } },
		sessionFile: '/data/chat/chat-ab.json',
	});
	const off = ['shell_tool', 'unified_exec', 'apps', 'plugins', 'multi_agent', 'browser_use', 'computer_use', 'image_generation', 'goals', 'sleep_tool', 'tool_suggest', 'skill_search', 'view_image', 'memories'];
	assert.deepEqual(args, [
		'exec',
		'--json',
		'--ephemeral',
		'--skip-git-repo-check',
		'--ignore-user-config',
		'--ignore-rules',
		'-s', 'read-only',
		'-C', '/data/chat/empty',
		...off.flatMap((feature) => ['--disable', feature]),
		'-c', 'approval_policy="never"',
		'-c', 'model_reasoning_effort="low"',
		'-c', 'web_search="disabled"',
		'-c', 'agents.enabled=false',
		'-c', 'skills.max_context_tokens=1',
		'-c', 'project_doc_max_bytes=0',
		'-c', 'developer_instructions="You help with snippets."',
		'-c', 'mcp_servers.snippets.command="/Applications/Snippet Editor.app/Contents/MacOS/Snippet Editor"',
		'-c', 'mcp_servers.snippets.args=["/res/mcp/server.mjs"]',
		'-c', 'mcp_servers.snippets.env={ELECTRON_RUN_AS_NODE = "1", SNIPPET_EDITOR_CHAT = "/data/chat/chat-ab.json"}',
		'-c', 'mcp_servers.snippets.default_tools_approval_mode="approve"',
		'-',
	]);
	// The tool runner must stay on: with it off, no tool can be called at all (real call 2).
	assert.ok(!args.includes('code_mode_host'));
});

test('paths and instructions with quotes, backslashes and new lines are written so TOML reads them back unchanged', () => {
	const args = codexArgs({
		cwd: '/tmp/x',
		system: 'Line one.\nSay "hello" \\ and `this`.\tDone.\u007f',
		mcp: { command: 'C:\\Program Files\\Snippet "Editor"\\app.exe', args: ['C:\\res\\mcp\\server.mjs', 'two words'], env: { A: 'x"y' } },
		sessionFile: 'C:\\data\\chat.json',
	});
	const value = (key) => args[args.findIndex((arg) => arg.startsWith(`${key}=`))].slice(key.length + 1);
	assert.equal(value('developer_instructions'), '"Line one.\\nSay \\"hello\\" \\\\ and `this`.\\tDone.\\u007f"');
	assert.equal(value('mcp_servers.snippets.command'), '"C:\\\\Program Files\\\\Snippet \\"Editor\\"\\\\app.exe"');
	assert.equal(value('mcp_servers.snippets.args'), '["C:\\\\res\\\\mcp\\\\server.mjs", "two words"]');
	assert.equal(value('mcp_servers.snippets.env'), '{A = "x\\"y", SNIPPET_EDITOR_CHAT = "C:\\\\data\\\\chat.json"}');
});

// --- what it prints ------------------------------------------------------------------------

test('an answer as Codex really prints it: a message, a tool that starts and ends, a message, done', () => {
	// Recorded on 2026-10-07 from Codex 0.160.1.
	const events = run(fixture('codex-search.jsonl'));
	assert.equal(events.length, 5);
	assert.deepEqual(events[0], { type: 'text', text: 'I’ll check the available tools, run the shell command if supported, and search the snippets for “refund.”' });
	assert.deepEqual(events[1], { type: 'tool', id: 'item_1', name: 'snippets_search', status: 'started' });
	assert.deepEqual(events[2], { type: 'tool', id: 'item_1', name: 'snippets_search', status: 'done' });
	assert.match(events[3].text, /^\n\n1\. NO_SHELL\n2\. `snippets_search`/);
	assert.deepEqual(events[4], { type: 'done' });
});

test('a tool that failed is marked so: by its status, by its error, or by a reply with no data', () => {
	const call = (id, rest) => item('completed', id, 'mcp_tool_call', { server: 'snippets', tool: 'snippets_add_snippet', arguments: {}, result: null, error: null, status: 'completed', ...rest });
	const events = run([
		call('a', { status: 'failed', error: { message: 'timed out' } }),
		call('b', { error: { message: 'boom' } }),
		call('c', { result: { content: [{ type: 'text', text: 'base.yml changed since you read it.' }], structured_content: null } }),
		call('d', { result: { content: [{ type: 'text', text: '{}' }], structured_content: { proposed: true } } }),
	]);
	assert.deepEqual(events.map((event) => [event.id, event.status]), [['a', 'failed'], ['b', 'failed'], ['c', 'failed'], ['d', 'done']]);
});

test('a tool is announced once, however many times Codex mentions it before it ends', () => {
	const call = { server: 'snippets', tool: 'snippets_get_file', arguments: {}, result: null, error: null, status: 'in_progress' };
	const events = run([item('started', 't', 'mcp_tool_call', call), item('updated', 't', 'mcp_tool_call', call), item('completed', 't', 'mcp_tool_call', { ...call, status: 'completed', result: { content: [], structured_content: {} } })]);
	assert.deepEqual(events.map((event) => event.status), ['started', 'done']);
});

test('anything Codex does that the app does not know to be harmless stops the answer', () => {
	const call = (server, tool) => item('started', 'x', 'mcp_tool_call', { server, tool, arguments: {}, result: null, error: null, status: 'in_progress' });
	for (const [line, what] of [
		[call('files', 'read_file'), 'used a tool this app did not give it (files: read_file)'],
		[call('codex', 'run_anything'), 'used a tool this app did not give it (codex: run_anything)'],
		[call('snippets', 7), 'used a tool this app did not give it (snippets: 7)'],
		[call('snippets', 'snippets_run_shell'), 'used a tool this app did not give it (snippets: snippets_run_shell)'],
		[item('started', 'x', 'browser_action', {}), 'did something this app does not know (browser_action)'],
		[item('completed', 'x', 'image_generation', {}), 'did something this app does not know (image_generation)'],
		[{ type: 'item.completed', item: { id: 'x' } }, 'did something this app does not know (undefined)'],
	]) {
		const events = run([message('m', 'Before.'), line, message('n', 'After.'), DONE]);
		assert.deepEqual(events, [{ type: 'text', text: 'Before.' }, { type: 'error', code: 'UNSAFE', message: `Codex ${what}, so it was stopped.` }], what);
	}
	// Its three ways of asking an MCP server what it holds are its own, and harmless.
	for (const tool of ['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource']) {
		assert.deepEqual(run([call('codex', tool), message('m', 'Fine.'), DONE]), [{ type: 'text', text: 'Fine.' }, { type: 'done' }], tool);
	}
});

test('Codex\'s own helper tools and its notes to itself are not shown', () => {
	const events = run([
		item('started', 'i1', 'mcp_tool_call', { server: 'codex', tool: 'list_mcp_resources', arguments: {}, status: 'in_progress' }),
		item('completed', 'i1', 'mcp_tool_call', { server: 'codex', tool: 'list_mcp_resources', arguments: {}, status: 'completed', result: { content: [], structured_content: null } }),
		item('completed', 'i2', 'reasoning', { text: 'thinking about it' }),
		item('completed', 'i3', 'todo_list', { items: [{ text: 'x', completed: false }] }),
		message('i4', 'Shown.'),
		DONE,
	]);
	assert.deepEqual(events, [{ type: 'text', text: 'Shown.' }, { type: 'done' }]);
});

test('a warning from Codex is not a failure, and a failed turn is', () => {
	// Real: Codex prints this for every message, because the skills list is cut on purpose.
	const warning = item('completed', 'w', 'error', { message: 'Exceeded skills context budget. All skill descriptions were removed and 147 additional skills were not included in the model-visible skills list.' });
	assert.deepEqual(run([warning, message('m', 'Fine.'), DONE]), [{ type: 'text', text: 'Fine.' }, { type: 'done' }]);

	assert.deepEqual(run([warning, { type: 'turn.failed', error: { message: 'You have hit your usage limit. Try again at 9:00 PM.' } }]), [{ type: 'error', code: 'FAILED', message: 'You have hit your usage limit. Try again at 9:00 PM.' }]);
	for (const said of ['Not logged in. Run codex login.', '401 Unauthorized', 'Your session has expired, please log in again']) {
		assert.deepEqual(run([{ type: 'turn.failed', error: { message: said } }]), [{ type: 'error', code: 'SIGNED_OUT', message: said }], said);
	}
	assert.equal(run([{ type: 'turn.failed', error: { message: 'x'.repeat(2000) } }])[0].message.length, 500);
	assert.deepEqual(run([{ type: 'turn.failed' }]), [{ type: 'error', code: 'FAILED', message: 'Codex stopped before it finished.' }]);
});

test('a problem Codex mentions on the way is kept, in case it ends without saying more', () => {
	const parser = createCodexParser({ tools: NAMES });
	assert.equal(parser.lastError, '');
	assert.deepEqual(run([{ type: 'error', message: 'Reconnecting... 1/5' }, { type: 'error', message: 'stream disconnected before completion' }], parser), []);
	assert.equal(parser.lastError, 'stream disconnected before completion');
	assert.equal(parser.ended, false);
});

test('if Codex runs a command, edits a file, searches the web or starts another agent, the answer is stopped', () => {
	for (const [type, what] of [
		['command_execution', 'ran a command'],
		['file_change', 'changed a file'],
		['web_search', 'searched the web'],
		['collab_tool_call', 'started another agent'],
	]) {
		const events = run([message('m', 'Before.'), item('started', 'x', type, {}), message('n', 'After.'), DONE]);
		assert.deepEqual(events, [{ type: 'text', text: 'Before.' }, { type: 'error', code: 'UNSAFE', message: `Codex ${what}, which this app does not allow, so it was stopped.` }], type);
	}
});

test('a message that grows is shown as it grows, once, and messages are set apart', () => {
	const events = run([item('started', 'm1', 'agent_message', { text: '' }), item('updated', 'm1', 'agent_message', { text: 'Hel' }), item('updated', 'm1', 'agent_message', { text: 'Hello' }), message('m1', 'Hello.'), message('m2', 'Second.'), message('m2', 'Second.'), DONE]);
	assert.deepEqual(events, [{ type: 'text', text: 'Hel' }, { type: 'text', text: 'lo' }, { type: 'text', text: '.' }, { type: 'text', text: '\n\nSecond.' }, { type: 'done' }]);
});

test('what is not a line of JSON, or not a kind of line the app knows, is skipped, and only one ending is reported', () => {
	const parser = createCodexParser({ tools: NAMES });
	const events = run(['', 'not json', '[]', 'null', '{"type":"thread.started","thread_id":"t"}', '{"type":"turn.started"}', '{"type":"something.new","item":{"id":"q","type":"agent_message","text":"no"}}', JSON.stringify(message('m', 'Yes.')), JSON.stringify(DONE), JSON.stringify(DONE), JSON.stringify(message('z', 'late'))], parser);
	assert.deepEqual(events, [{ type: 'text', text: 'Yes.' }, { type: 'done' }]);
	assert.equal(parser.ended, true);
});
