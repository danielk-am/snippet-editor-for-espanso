import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { claudeArgs, claudeMcpConfig, createClaudeParser } from '../core/chat/claudeCode.js';

const fixture = (name) => readFileSync(fileURLToPath(new URL(`./fixtures/chat/${name}`, import.meta.url)), 'utf8').split('\n').filter(Boolean);
const run = (lines, parser = createClaudeParser()) => lines.flatMap((line) => parser.push(typeof line === 'string' ? line : JSON.stringify(line)));
const textOf = (events) => events.filter((event) => event.type === 'text').map((event) => event.text).join('');

const TOOLS = ['search', 'list_files', 'get_file', 'get_snippet', 'list_team_packages', 'add_snippet', 'update_snippet', 'delete_snippet', 'create_file', 'replace_file_yaml', 'install_team_package', 'propose_to_team'].map((name) => `mcp__snippets__snippets_${name}`);
const init = (extra = {}) => ({ type: 'system', subtype: 'init', tools: TOOLS, mcp_servers: [{ name: 'snippets', status: 'connected' }], ...extra });
const assistant = (id, content, extra = {}) => ({ type: 'assistant', message: { id, role: 'assistant', content }, parent_tool_use_id: null, ...extra });
const delta = (text) => ({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }, parent_tool_use_id: null });
const start = (id) => ({ type: 'stream_event', event: { type: 'message_start', message: { id } }, parent_tool_use_id: null });
const success = (result = '') => ({ type: 'result', subtype: 'success', is_error: false, result });

// --- how it is started ---------------------------------------------------------------------

test('Claude Code is started with nothing but the snippet tools, and the message is not among its arguments', () => {
	const args = claudeArgs({ mcpConfigFile: '/data/chat/mcp.json', system: 'You help with snippets.' });
	assert.deepEqual(args, [
		'-p',
		'--output-format', 'stream-json',
		'--verbose',
		'--include-partial-messages',
		'--restricted',
		'--tools', '',
		'--strict-mcp-config',
		'--mcp-config', '/data/chat/mcp.json',
		'--allowedTools', 'mcp__snippets',
		'--permission-mode', 'dontAsk',
		'--permission-prompts', 'none',
		'--disable-slash-commands',
		'--no-session-persistence',
		'--effort', 'low',
		'--system-prompt', 'You help with snippets.',
	]);
});

test('the MCP server it is told to start is this app\'s, pointed at this message\'s listener', () => {
	const config = claudeMcpConfig({ mcp: { command: '/Applications/Snippet Editor.app/Contents/MacOS/Snippet Editor', args: ['/res/mcp/server.mjs'], env: { ELECTRON_RUN_AS_NODE: '1' } }, sessionFile: '/data/chat/chat-ab.json' });
	assert.deepEqual(config, {
		mcpServers: {
			snippets: {
				command: '/Applications/Snippet Editor.app/Contents/MacOS/Snippet Editor',
				args: ['/res/mcp/server.mjs'],
				env: { ELECTRON_RUN_AS_NODE: '1', SNIPPET_EDITOR_CHAT: '/data/chat/chat-ab.json' },
			},
		},
	});
});

// --- what it prints ------------------------------------------------------------------------

test('an answer: text as it is written, each tool as it starts and ends, then done', () => {
	// Written from Claude Code's documented output, not recorded: it is signed out on the computer this was built on.
	const events = run(fixture('claude-answer.jsonl'));
	assert.deepEqual(events, [
		{ type: 'text', text: 'I will look ' },
		{ type: 'text', text: 'for that.' },
		{ type: 'tool', id: 'toolu_01', name: 'snippets_search', status: 'started' },
		{ type: 'tool', id: 'toolu_01', name: 'snippets_search', status: 'done' },
		{ type: 'text', text: '\n\nFound ' },
		{ type: 'text', text: 'one: `:refund`.' },
		{ type: 'tool', id: 'toolu_02', name: 'snippets_add_snippet', status: 'started' },
		{ type: 'tool', id: 'toolu_02', name: 'snippets_add_snippet', status: 'failed' },
		{ type: 'text', text: '\n\nThat did not work.' },
		{ type: 'done' },
	]);
});

test('signed out, as Claude Code really reports it: no text, one error that says so', () => {
	// Recorded on 2026-10-07 from Claude Code 2.1.288, signed out.
	const events = run(fixture('claude-signed-out.jsonl'));
	assert.deepEqual(events, [{ type: 'error', code: 'SIGNED_OUT', message: 'Not logged in · Please run /login' }]);
});

test('text is shown once, whether it was streamed, came whole, or both', () => {
	// Whole only: an older Claude Code, or a message it made up itself.
	assert.equal(textOf(run([init(), assistant('m1', [{ type: 'text', text: 'Hello.' }]), success('Hello.')])), 'Hello.');
	// Streamed, then the whole message with every block in it.
	assert.equal(textOf(run([init(), start('m1'), delta('Hel'), delta('lo.'), assistant('m1', [{ type: 'text', text: 'Hello.' }]), success('Hello.')])), 'Hello.');
	// Streamed in one message, whole in the next.
	assert.equal(textOf(run([init(), start('m1'), delta('One.'), assistant('m1', [{ type: 'text', text: 'One.' }]), assistant('m2', [{ type: 'text', text: 'Two.' }]), success('Two.')])), 'One.\n\nTwo.');
	// Nothing but the result: it is still shown.
	assert.equal(textOf(run([init(), success('Only the result.')])), 'Only the result.');
	// Two blocks of the same words in one message are two blocks.
	assert.equal(textOf(run([init(), assistant('m1', [{ type: 'text', text: 'OK' }, { type: 'text', text: 'OK' }]), success('OK')])), 'OK\n\nOK');
});

test('text written after a tool was used starts a new paragraph, however it arrives', () => {
	const use = { type: 'tool_use', id: 't1', name: 'mcp__snippets__snippets_search', input: {} };
	const used = [assistant('m1', [use]), { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] }, parent_tool_use_id: null }];
	assert.equal(textOf(run([init(), start('m1'), delta('Before.'), ...used, start('m2'), delta('After.'), success('After.')])), 'Before.\n\nAfter.');
	assert.equal(textOf(run([init(), ...used, start('m2'), delta('After.'), success('After.')])), 'After.');
});

test('thinking, empty text and a sub-agent\'s messages are not shown', () => {
	const events = run([
		init(),
		start('m1'),
		{ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hidden' } }, parent_tool_use_id: null },
		{ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', text: 'hidden too' } }, parent_tool_use_id: null },
		delta(''),
		{ ...delta('from a sub-agent'), parent_tool_use_id: 'toolu_9' },
		assistant('m9', [{ type: 'text', text: 'from a sub-agent' }], { parent_tool_use_id: 'toolu_9' }),
		assistant('m1', [{ type: 'thinking', thinking: 'hidden' }, { type: 'text', text: '' }]),
		delta('Shown.'),
		success('Shown.'),
	]);
	assert.deepEqual(events, [{ type: 'text', text: 'Shown.' }, { type: 'done' }]);
});

test('a tool is announced once, and ends as done or failed', () => {
	const use = { type: 'tool_use', id: 't1', name: 'mcp__snippets__snippets_get_file', input: {} };
	const events = run([
		init(),
		assistant('m1', [use]),
		assistant('m1', [use, { type: 'tool_use', id: 't2', name: 'mcp__snippets__snippets_add_snippet', input: {} }]),
		{ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }, { type: 'tool_result', tool_use_id: 't2', is_error: true, content: 'no' }] }, parent_tool_use_id: null },
		{ type: 'user', message: { role: 'user', content: 'a plain message' }, parent_tool_use_id: null },
		success(''),
	]);
	assert.deepEqual(events, [
		{ type: 'tool', id: 't1', name: 'snippets_get_file', status: 'started' },
		{ type: 'tool', id: 't2', name: 'snippets_add_snippet', status: 'started' },
		{ type: 'tool', id: 't1', name: 'snippets_get_file', status: 'done' },
		{ type: 'tool', id: 't2', name: 'snippets_add_snippet', status: 'failed' },
		{ type: 'done' },
	]);
});

test('a tool that is not one of the snippet tools, used in the middle of an answer, stops the answer', () => {
	for (const name of ['Bash', 'mcp__other__snippets_search', 'mcp__snippets', 'WebFetch', 7, undefined]) {
		const events = run([init(), start('m1'), delta('Before.'), assistant('m1', [{ type: 'tool_use', id: 't9', name, input: {} }]), delta('After.'), success('After.')]);
		assert.deepEqual(events, [{ type: 'text', text: 'Before.' }, { type: 'error', code: 'UNSAFE', message: `Claude Code used a tool this app did not give it (${String(name)}), so it was stopped.` }], String(name));
	}
	// The same from a sub-agent, which the app does not give it either.
	assert.equal(run([init(), assistant('m1', [{ type: 'tool_use', id: 't9', name: 'Bash', input: {} }], { parent_tool_use_id: 'x' })]).at(-1).code, 'UNSAFE');
});

test('until it has said which tools it has, nothing it writes or does is taken', () => {
	const unsaid = { type: 'error', code: 'UNSAFE', message: 'Claude Code did not say which tools it has, so it was stopped.' };
	assert.deepEqual(run([delta('text'), init(), success('text')]), [unsaid]);
	assert.deepEqual(run([assistant('m1', [{ type: 'text', text: 'Hello.' }]), init()]), [unsaid]);
	assert.deepEqual(run([{ type: 'user', message: { role: 'user', content: [] }, parent_tool_use_id: null }]), [unsaid]);
	assert.deepEqual(run([{ type: 'assistant' }]), [unsaid]);
	// What may come first: other notes from the program itself, and a failure to start.
	assert.deepEqual(run([{ type: 'system', subtype: 'hook_started' }, { type: 'system', subtype: 'plugin_install', status: 'started' }, init(), delta('Fine.'), success('Fine.')]), [{ type: 'text', text: 'Fine.' }, { type: 'done' }]);
	assert.deepEqual(run([{ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['The working folder is missing.'] }]), [{ type: 'error', code: 'FAILED', message: 'The working folder is missing.' }]);
	// A result that claims success with no tools ever listed is not an answer.
	assert.deepEqual(run([success('An answer from nowhere.')]), [unsaid]);
});

test('a result that is an error says what Claude Code said, and why when it is known', () => {
	const failure = (extra, before = []) => run([init(), ...before, { type: 'result', is_error: true, ...extra }]).at(-1);
	assert.deepEqual(failure({ subtype: 'error_during_execution', errors: ['The model is overloaded.', 'Try again.'] }), { type: 'error', code: 'FAILED', message: 'The model is overloaded. Try again.' });
	assert.deepEqual(failure({ subtype: 'error_max_turns', errors: [] }), { type: 'error', code: 'FAILED', message: 'Claude Code stopped before it finished (error_max_turns).' });
	assert.deepEqual(failure({ subtype: 'success', result: 'Credit balance is too low' }, [assistant('m1', [{ type: 'text', text: 'Credit balance is too low' }], { error: 'billing_error' })]), {
		type: 'error',
		code: 'FAILED',
		message: 'Credit balance is too low',
	});
	assert.deepEqual(failure({ subtype: 'success', result: 'Invalid API key · Please run /login' }, [assistant('m1', [{ type: 'text', text: 'Invalid API key · Please run /login' }], { error: 'authentication_failed' })]).code, 'SIGNED_OUT');
	// A very long failure is cut.
	assert.equal(failure({ subtype: 'error_during_execution', errors: ['x'.repeat(2000)] }).message.length, 500);
	// A result with success in name and error in fact is an error.
	assert.equal(run([init(), { type: 'result', subtype: 'error_during_execution', is_error: false, errors: ['odd'] }]).at(-1).type, 'error');
});

test('if Claude Code starts with any tool the app did not give it, or without the snippet tools, that is said at once', () => {
	assert.deepEqual(run([init({ tools: [...TOOLS, 'Bash'] })]), [{ type: 'error', code: 'UNSAFE', message: 'Claude Code started with tools this app did not give it (Bash), so it was stopped.' }]);
	assert.deepEqual(run([init({ tools: ['Read', 'Edit', 'WebFetch', 'Bash', 'Write'] })])[0].message, 'Claude Code started with tools this app did not give it (Read, Edit, WebFetch and 2 more), so it was stopped.');
	assert.deepEqual(run([init({ tools: [], mcp_servers: [{ name: 'snippets', status: 'failed' }] })]), [{ type: 'error', code: 'NO_TOOLS', message: 'Claude Code could not start the snippet tools.' }]);
	assert.deepEqual(run([init({ tools: [], mcp_servers: [] })]), [{ type: 'error', code: 'NO_TOOLS', message: 'Claude Code could not start the snippet tools.' }]);
	assert.deepEqual(run([init({ tools: 'odd', mcp_servers: null })])[0].code, 'NO_TOOLS');
	// The server says it is there, and no tool came with it.
	assert.deepEqual(run([init({ tools: [] })])[0].code, 'NO_TOOLS');
	// After such an error nothing else is passed on.
	assert.deepEqual(run([init({ tools: ['Bash'] }), delta('text'), success('text')]).length, 1);
});

test('what is not a line of JSON, or not a kind of line the app knows, is skipped', () => {
	const events = run(['', 'not json', '[1,2]', '"text"', 'null', '{"type":"system","subtype":"api_retry","attempt":1}', '{"type":"rate_limit_event"}', JSON.stringify(init()), '{"type":"assistant"}', '{"type":"user","message":null}', '{"type":"stream_event"}', '{"type":"something_new","text":"x"}', JSON.stringify(delta('Still here.')), JSON.stringify(success('Still here.'))]);
	assert.deepEqual(events, [{ type: 'text', text: 'Still here.' }, { type: 'done' }]);
});

test('only one ending is reported', () => {
	const parser = createClaudeParser();
	const events = run([init(), delta('Done.'), success('Done.'), success('Done.'), delta('late')], parser);
	assert.deepEqual(events, [{ type: 'text', text: 'Done.' }, { type: 'done' }]);
	assert.equal(parser.ended, true);
});
