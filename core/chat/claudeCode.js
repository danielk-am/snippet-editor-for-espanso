// Claude Code as the chat's backend: how it is started, and how what it
// prints becomes the events the panel shows.
//
// It is started fresh for each message, with `-p` and its output as one JSON
// object per line. The flags below leave it exactly the snippet tools:
//   --restricted            no tool that runs commands, no settings files
//   --tools ""              none of its built-in tools at all
//   --strict-mcp-config     no MCP server but the one named here
//   --allowedTools          that server's tools run without a question
//   --permission-prompts    anything else is refused, with nobody asked
// Its first line lists the tools it has. That list is read, and if it holds
// anything the app did not give, the answer is stopped before it starts.
// Nothing it writes or does is taken before that line, and a tool it uses
// later that is not one of the snippet tools stops the answer too.

const SERVER = 'snippets';
const PREFIX = `mcp__${SERVER}__`;
const MOST = 500;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export function claudeArgs({ mcpConfigFile, system }) {
	return [
		'-p',
		'--output-format', 'stream-json',
		'--verbose',
		'--include-partial-messages',
		'--restricted',
		'--tools', '',
		'--strict-mcp-config',
		'--mcp-config', mcpConfigFile,
		'--allowedTools', `mcp__${SERVER}`,
		'--permission-mode', 'dontAsk',
		'--permission-prompts', 'none',
		'--disable-slash-commands',
		'--no-session-persistence',
		'--effort', 'low',
		'--system-prompt', system,
	];
}

// The file `--mcp-config` names: this app's MCP server, told where this
// message's listener is.
export function claudeMcpConfig({ mcp, sessionFile }) {
	return { mcpServers: { [SERVER]: { command: mcp.command, args: mcp.args, env: { ...mcp.env, SNIPPET_EDITOR_CHAT: sessionFile } } } };
}

// Lines in, events out:
//   { type: 'text', text }                      more of the answer
//   { type: 'tool', id, name, status }          started, done or failed
//   { type: 'done' }                            the answer is complete
//   { type: 'error', code, message }            it ended some other way
export function createClaudeParser() {
	let ended = false;
	let listed = false;
	let anyText = false;
	let needsBreak = false;
	let currentId = null;
	let lastError = null;
	// Text already shown as it was written, by the message it belongs to.
	// Each message is also printed whole once it is complete.
	const streamed = new Map();
	const tools = new Map();

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

		const say = (text) => {
			if (!text) return;
			out.push({ type: 'text', text: needsBreak && anyText ? `\n\n${text}` : text });
			anyText = true;
			needsBreak = false;
		};
		const end = (event) => {
			ended = true;
			out.push(event);
		};

		if (data.type === 'system' && data.subtype === 'init') {
			const given = Array.isArray(data.tools) ? data.tools : [];
			const foreign = given.filter((name) => typeof name !== 'string' || !name.startsWith(PREFIX));
			if (foreign.length) {
				const named = foreign.length > 3 ? `${foreign.slice(0, 3).join(', ')} and ${foreign.length - 3} more` : foreign.join(', ');
				end({ type: 'error', code: 'UNSAFE', message: `Claude Code started with tools this app did not give it (${named}), so it was stopped.` });
			} else {
				const server = Array.isArray(data.mcp_servers) ? data.mcp_servers.find((item) => item?.name === SERVER) : null;
				if (!given.length || server?.status !== 'connected') end({ type: 'error', code: 'NO_TOOLS', message: 'Claude Code could not start the snippet tools.' });
				else listed = true;
			}
			return out;
		}

		// Until it has said which tools it has, only its own notes and a
		// failure to start are taken.
		const fromTheModel = data.type === 'assistant' || data.type === 'user' || data.type === 'stream_event';
		if (!listed && (fromTheModel || (data.type === 'result' && data.is_error !== true && data.subtype === 'success'))) {
			end({ type: 'error', code: 'UNSAFE', message: 'Claude Code did not say which tools it has, so it was stopped.' });
			return out;
		}

		// A tool that is not one of the app's, whoever in the answer uses it.
		if (data.type === 'assistant' && Array.isArray(data.message?.content)) {
			const foreign = data.message.content.find((block) => block?.type === 'tool_use' && !(typeof block.name === 'string' && block.name.startsWith(PREFIX)));
			if (foreign) {
				end({ type: 'error', code: 'UNSAFE', message: `Claude Code used a tool this app did not give it (${String(foreign.name)}), so it was stopped.` });
				return out;
			}
		}

		// A sub-agent's messages are not the answer.
		if (data.parent_tool_use_id != null) return out;

		if (data.type === 'stream_event' && isObject(data.event)) {
			const event = data.event;
			if (event.type === 'message_start') currentId = event.message?.id ?? null;
			else if (event.type === 'content_block_start' && event.content_block?.type === 'text') needsBreak = anyText;
			else if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && typeof event.delta.text === 'string' && event.delta.text) {
				say(event.delta.text);
				streamed.set(currentId, (streamed.get(currentId) ?? '') + event.delta.text);
			}
			return out;
		}

		if (data.type === 'assistant' && isObject(data.message) && Array.isArray(data.message.content)) {
			// A message Claude Code wrote itself to report a failure. Its text
			// comes again in the result, where it is reported as the failure.
			if (typeof data.error === 'string') {
				lastError = data.error;
				return out;
			}
			const already = streamed.get(data.message.id) ?? streamed.get(null) ?? '';
			for (const block of data.message.content) {
				if (block?.type === 'text' && typeof block.text === 'string' && block.text) {
					if (already.includes(block.text)) continue;
					needsBreak = anyText;
					say(block.text);
				} else if (block?.type === 'tool_use' && typeof block.id === 'string' && !tools.has(block.id)) {
					const name = block.name.slice(PREFIX.length);
					tools.set(block.id, name);
					out.push({ type: 'tool', id: block.id, name, status: 'started' });
					needsBreak = true;
				}
			}
			return out;
		}

		if (data.type === 'user' && isObject(data.message) && Array.isArray(data.message.content)) {
			for (const block of data.message.content) {
				if (block?.type !== 'tool_result' || !tools.has(block.tool_use_id)) continue;
				out.push({ type: 'tool', id: block.tool_use_id, name: tools.get(block.tool_use_id), status: block.is_error === true ? 'failed' : 'done' });
			}
			return out;
		}

		if (data.type === 'result') {
			if (data.is_error === true || data.subtype !== 'success') {
				const said = Array.isArray(data.errors) && data.errors.length ? data.errors.join(' ') : typeof data.result === 'string' && data.result ? data.result : `Claude Code stopped before it finished (${data.subtype}).`;
				end({ type: 'error', code: lastError === 'authentication_failed' ? 'SIGNED_OUT' : 'FAILED', message: said.slice(0, MOST) });
			} else {
				if (!anyText && typeof data.result === 'string') say(data.result);
				end({ type: 'done' });
			}
		}
		return out;
	}

	return {
		push,
		get ended() {
			return ended;
		},
	};
}
