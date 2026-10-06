// Codex as the chat's backend: how it is started, and how what it prints
// becomes the events the panel shows.
//
// It is started fresh for each message with `codex exec --json`. What is
// switched off below was settled by real calls on 2026-10-07 (Codex 0.160.1):
//   - With its shell alone off, Codex still had a web tool, a patch tool,
//     sub-agents and an image tool. A web tool beside snippet access is a way
//     for text to leave, so each is switched off by name.
//   - Its tool runner (code_mode_host) must stay on: with it off, no tool can
//     be called at all, the snippet tools included. The runner's code has no
//     file, network or process access of its own.
//   - The sandbox is read-only, so the patch tool that remains cannot write.
// Codex does not say which tools it has. So the watch is on what it does: if
// it runs a command, changes a file, searches the web or starts another
// agent, the answer is stopped.

const SERVER = 'snippets';
const MOST = 500;
const OFF = ['shell_tool', 'unified_exec', 'apps', 'plugins', 'multi_agent', 'browser_use', 'computer_use', 'image_generation', 'goals', 'sleep_tool', 'tool_suggest', 'skill_search', 'view_image', 'memories'];
const FORBIDDEN = { command_execution: 'ran a command', file_change: 'changed a file', web_search: 'searched the web', collab_tool_call: 'started another agent' };

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// A JSON string is a TOML string too, but for one character TOML wants
// escaped and JSON leaves alone.
const toml = (text) => JSON.stringify(String(text)).replaceAll('\u007f', '\\u007f');

export function codexArgs({ cwd, system, mcp, sessionFile }) {
	const env = { ...mcp.env, SNIPPET_EDITOR_CHAT: sessionFile };
	return [
		'exec',
		'--json',
		'--ephemeral',
		'--skip-git-repo-check',
		'--ignore-user-config',
		'--ignore-rules',
		'-s', 'read-only',
		'-C', cwd,
		...OFF.flatMap((feature) => ['--disable', feature]),
		'-c', 'approval_policy="never"',
		'-c', 'model_reasoning_effort="low"',
		'-c', 'web_search="disabled"',
		'-c', 'agents.enabled=false',
		// Its list of the person's skills is no use here and is long.
		'-c', 'skills.max_context_tokens=1',
		'-c', 'project_doc_max_bytes=0',
		'-c', `developer_instructions=${toml(system)}`,
		'-c', `mcp_servers.${SERVER}.command=${toml(mcp.command)}`,
		'-c', `mcp_servers.${SERVER}.args=[${mcp.args.map(toml).join(', ')}]`,
		'-c', `mcp_servers.${SERVER}.env={${Object.entries(env).map(([key, value]) => `${key} = ${toml(value)}`).join(', ')}}`,
		'-c', `mcp_servers.${SERVER}.default_tools_approval_mode="approve"`,
		// The message is read from standard input.
		'-',
	];
}

// Lines in, events out, the same events as for Claude Code.
export function createCodexParser() {
	let ended = false;
	let anyText = false;
	let lastError = '';
	// How much of each message has been shown, for one that arrives in parts.
	const shown = new Map();
	const started = new Set();

	function push(line) {
		if (ended) return [];
		let data;
		try {
			data = JSON.parse(line);
		} catch {
			return [];
		}
		if (!isObject(data)) return [];
		const out = [];
		const end = (event) => {
			ended = true;
			out.push(event);
		};

		if (data.type === 'turn.completed') end({ type: 'done' });
		else if (data.type === 'turn.failed') {
			const said = typeof data.error?.message === 'string' && data.error.message ? data.error.message : 'Codex stopped before it finished.';
			end({ type: 'error', code: /log ?in|logged out|unauthori[sz]ed|\b401\b/i.test(said) ? 'SIGNED_OUT' : 'FAILED', message: said.slice(0, MOST) });
		} else if (data.type === 'error') {
			// Often a retry under way. Whether it mattered shows in how the turn ends.
			if (typeof data.message === 'string') lastError = data.message;
		} else if ((data.type === 'item.started' || data.type === 'item.updated' || data.type === 'item.completed') && isObject(data.item)) {
			const { item } = data;
			if (Object.hasOwn(FORBIDDEN, item.type)) {
				end({ type: 'error', code: 'UNSAFE', message: `Codex ${FORBIDDEN[item.type]}, which this app does not allow, so it was stopped.` });
			} else if (item.type === 'agent_message' && typeof item.text === 'string') {
				const before = shown.get(item.id) ?? '';
				if (item.text.startsWith(before) && item.text.length > before.length) {
					const more = item.text.slice(before.length);
					out.push({ type: 'text', text: !before && anyText ? `\n\n${more}` : more });
					shown.set(item.id, item.text);
					anyText = true;
				}
			} else if (item.type === 'mcp_tool_call' && item.server === SERVER) {
				const tool = { type: 'tool', id: String(item.id), name: String(item.tool) };
				if (data.type === 'item.completed') {
					// A tool of this app that fails sends words and no data.
					const failed = item.status === 'failed' || item.error != null || (isObject(item.result) && item.result.structured_content == null);
					out.push({ ...tool, status: failed ? 'failed' : 'done' });
				} else if (!started.has(tool.id)) {
					started.add(tool.id);
					out.push({ ...tool, status: 'started' });
				}
			}
		}
		return out;
	}

	return {
		push,
		get ended() {
			return ended;
		},
		get lastError() {
			return lastError;
		},
	};
}
