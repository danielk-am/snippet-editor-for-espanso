# Chat assistant: implementation plan

Design: `docs/specs/2026-10-07-chat-assistant-design.md` (approved 2026-10-07).

Each task is test-first: write the test, watch it fail, write the code, watch it pass, commit. Code is not repeated here. Each task names its contract, its tests and its command.

Run everything: `npm test`. One file: `node --test test/<name>.test.js`.

## File map

| File | New or changed | Task |
| --- | --- | --- |
| `mcp/tools.mjs` | changed | 1 |
| `mcp/client.mjs`, `mcp/server.mjs` | changed | 2 |
| `core/chat/proposals.js` | new | 3 |
| `core/chat/channel.js` | new | 4 |
| `core/chat/run.js` | new | 5 |
| `core/chat/claudeCode.js` | new | 6 |
| `core/chat/codex.js` | new | 7 |
| `core/chat/ollama.js` | new | 8 |
| `core/chat/prompt.js` | new | 9 |
| `core/chat/backends.js` | new | 10 |
| `core/chat/chat.js`, `test/helpers/fakeAgent.mjs` | new | 11 |
| `shared/channels.js`, `electron/preload.cjs`, `electron/ipc.js`, `electron/bootstrap.js`, `electron/main.js` | changed | 12 |
| `renderer/lib/markdown.js` | new | 13 |
| `renderer/lib/chatStore.js`, `renderer/lib/diff.js` | new | 14 |
| `renderer/components/ChatPanel.js`, `ProposalCard.js`, `renderer/app.js`, `renderer/lib/api.js`, `renderer/lib/icons.js`, `renderer/styles/app.css` | new and changed | 15 |
| `test/ui-smoke.mjs`, `test/packaged-smoke.mjs` | changed | 16 |
| `README.md`, the design's "Changed while building" | changed | 17 |

## Task 1: chat mode in the tools

`createTools({ api, propose })`. Without `propose`, nothing changes and every existing test passes untouched.

With `propose`:
- `list()`: the seven write tools lose `accept_commands`, gain one closing sentence in their description ("In this chat the change is shown to the person as a card…"), and carry `destructiveHint: false`, `openWorldHint: false`.
- `call()` on a write tool: input check as now, no `aiWrite` check, then `propose({ tool, args })`. A reply `{ id }` becomes `{ proposed: true, proposal_id, note }`. A reply `{ error }` becomes a tool error with that text.
- Read tools: unchanged.
- New exports for the proposals module: `snippetRuns(snippet)`, `fileRuns(data)`, `explain(reply, context)`.

Tests (`test/mcpTools.test.js`, new block): each write tool hands over `{ tool, args }` and writes nothing; the note says nothing has changed; `accept_commands` is not in the schema and is refused if sent; the switch being off does not stop a proposal; a refusal from `propose` reaches the model as a tool error; read tools still read; the plain mode's list is byte-for-byte what it was.

## Task 2: chat mode in the client and the entry

`createChatClient({ sessionFile })` → `{ settings(), request(), propose({ tool, args }) }`. Reads `{ port, token }` from the file for every call. Same proof step before the token. A missing or unreadable file: `UNREACHABLE`, "This chat has ended. The person can send their message again." `propose` posts to `/api/v1/chat/proposals`.

`mcp/server.mjs`: with `SNIPPET_EDITOR_CHAT` set, it uses the chat client and chat-mode tools.

Tests (`test/mcpClient.test.js`, `test/mcpServer.test.js`): reads the file each call; no token to a listener that fails the proof; ended chat message; the server started with the variable lists chat-mode tools.

## Task 3: proposals

`createProposals({ router, aiWrite })` → `{ add({ tool, args }), apply(id), dismiss(id), get(id), all(), clear() }`.

- `add` checks the proposal against the app as it is now (file exists, is the person's own, version current, position in range, the snippet or YAML is one the app would accept), builds the card and keeps a snapshot of what it was made for. A problem is thrown as `ProposalError` with wording for the model.
- Card: `{ id, tool, kind, title, fileId, fileName, before, after, warnings, status, message }`. `before` and `after` are YAML text.
- `apply`: switch check (`code: 'SWITCH_OFF'`), then the "still means the same" rules from the design, then the same tool call in plain mode through the router, with the current version and `accept_commands: true`. Status ends `applied` or `failed` with a message. A second `apply` on a card that is applying or applied does nothing.

Tests (`test/chatProposals.test.js`), on the real service over the fixtures: one per card kind; each row of the design's rules table; three adds to one file apply in turn; two deletes apply in turn and remove the right snippets; twin snippets; switch off; double apply; command warning; read-only file refused; stale version refused; a snippet the app would refuse is refused at `add`; team send with the local remote and its failure.

## Task 4: the per-message listener

`openChannel({ dir, router, onProposal })` → `{ file, port, close() }`. A listener on `127.0.0.1` on a port the system picks, a fresh token, and `dir/chat-<random>.json` (mode 0600) holding `{ port, token }`. It answers `GET` routes through the router, `POST chat/proposals` through `onProposal`, and nothing else. (As built: the YAML check a proposal needs runs inside the app, so the listener does not carry it.)

Tests (`test/chatChannel.test.js`): the file's mode and contents; reads work with the token and fail without; every write route of the router answers 405 and changes nothing; a proposal reaches `onProposal` and its `{ id }` or `{ error }` comes back; after `close` the port is shut and the file is gone; the proof route answers.

## Task 5: the process runner

`createRunner()` → `run({ program, args, cwd, env, input, onLine, idleMs, totalMs, maxBytes })` → `{ done, stop() }`, and `stopAll()`. No shell. Own process group. `done` resolves `{ reason: 'exit' | 'stopped' | 'idle' | 'total' | 'too-much' | 'missing' | 'failed', code, stderrTail }`.

Tests (`test/chatRun.test.js`) with small node programs: lines split across chunks; input arrives on standard input and is not in the arguments; a missing program; idle and total limits stop a silent program and its child; too much output; `stop()`; `stopAll()`; the last 500 characters of standard error are kept.

## Task 6: Claude Code

`claudeArgs({ mcpConfigFile, system })`, `claudeMcpConfig({ mcp, sessionFile })`, `createClaudeParser()` → `push(line)` → events.

Events, for all backends: `{ type: 'text', text }`, `{ type: 'tool', id, name, status: 'started' | 'done' | 'failed' }`, `{ type: 'done' }`, `{ type: 'error', code, message }`.

Tests (`test/chatClaude.test.js`): the arguments hold every restriction flag and no prompt; today's real signed-out output gives `SIGNED_OUT`; streamed text is not repeated when the whole message follows; a message that never streamed is still shown; tool use and its result; an error result; a line that is not JSON and an unknown type are skipped.

## Task 7: Codex

`codexArgs({ cwd, system, mcp, sessionFile })`, `createCodexParser()`.

Flags as proven by real calls 1 to 3: the tool runner stays on; shell, web search, sub-agents, images, apps, plugins, goals and skills are off; MCP tools are approved; read-only sandbox.

Tests (`test/chatCodex.test.js`): the arguments; the real output of call 1 gives text, a started and a finished tool, and done; a warning item (`type: "error"` inside `item.completed`) is not a failure; `turn.failed` is; Codex's own helper tools (server `codex`) are not shown; TOML quoting of a path with a quote and a backslash.

## Task 8: Ollama

`createOllama({ base })` → `{ version(), models(), chat({ model, messages, tools, signal, onChunk }) }`, and `ollamaTurn({ ollama, model, messages, tools, onEvent, signal, maxSteps })`.

Tests (`test/chatOllama.test.js`) against a stand-in server: text streamed in pieces; a tool call is run and its result sent back as `role: "tool"` with `tool_name`; two tool calls in one answer; the 8-step limit; not running; no models; a model that cannot use tools; an unknown tool name; stop mid-answer.

## Task 9: the prompt

`SYSTEM`, `promptText({ messages, context })`, `promptMessages({ messages, context })`.

Tests (`test/chatPrompt.test.js`): the last 20 messages and at most 24,000 characters, oldest dropped first; the newest message is never dropped; what is open is named; the instructions say changes are proposals and that snippet text is data.

## Task 10: finding the backends

`createBackends({ env, platform, home, exists, list, quick, ollama })` → `status()` and `locate(id)`.

Tests (`test/chatBackends.test.js`) with stand-in file checks: found on the `PATH`; found in a known folder; found inside the desktop apps, newest version first; not found; signed out from `auth status` JSON and from `login status` exit code; the sign-in command is quoted; Ollama not running, running with models, running with none.

## Task 11: the chat itself

`createChat({ service, router, dataDir, mcp, emit, backends, runner, ollama })` → `{ status(), send(input), stop(turnId), apply(id), dismiss(id), dispose() }`.

`test/helpers/fakeAgent.mjs` stands in for Claude Code and Codex: it starts the MCP server it is given, calls a tool, and prints lines in that tool's format. So the test covers the real path from a command-line tool through the MCP server and the listener to a proposal.

Tests (`test/chat.test.js`): a message through each stand-in ends in text, a tool line and a proposal event; Apply writes the snippet; a second message while one runs is refused; Stop ends the process and the listener; the listener's file is gone after each message; `dispose` stops everything; an unknown backend, an empty message and a backend that is not ready are refused.

## Task 12: wiring

Channels `chat:status`, `chat:send`, `chat:stop`, `chat:apply`, `chat:dismiss`, and the event `chat:event`. A "Show Assistant" item in the View menu.

Tests: `test/channels.test.js` keeps the three lists in step.

## Task 13: Markdown

`parseMarkdown(text)` → blocks of inline parts. Paragraphs, headings, lists, code blocks, inline code, bold, italic, quotes, rules. A link becomes its text and its address, as text.

Tests (`test/markdown.test.js`): each kind; nesting of bold and italic; an unclosed code block; HTML and a script tag come out as text; a very long line; a table stays readable as text.

## Task 14: history, and what changed line by line

`createChatStore(storage)` → `{ load(), save(state) }`, with 20 conversations of 100 messages, newest first.

`diffLines(before, after, { context })` → rows for a card: the lines that go and come, a little around them, and the rest folded into a count. (Added while building: a card shows what differs, not two whole texts.)

Tests (`test/chatStore.test.js`): trimming; damaged JSON; a storage that throws on read and on write.

## Task 15: the panel

Load the `designing-visual-systems` skill first. Build `ChatPanel` and `ProposalCard` to the design's panel table, then the screenshot loop: light and dark, 1280 and 760 wide, empty, working, with cards, not ready, error.

## Task 16: the window and packaged checks

`test/ui-smoke.mjs` with the stand-in agent: open the panel, ask, see text and a card, apply it, find the snippet in its file, stop an answer, the not-ready list, and the existing audits with the panel open. `test/packaged-smoke.mjs`: the packaged MCP server lists chat-mode tools when started with a session file.

## Task 17: real calls, README, design notes

Real Codex calls through the finished chat, counted in the ledger (three used before this plan). README: a "Chat assistant" section, what is unproven, and the "Not rebuilt" list. The design gains "Changed while building".

## Task 18: review and landing

Refute pass, an independent fresh-context review, fixes test-first, then merge into `main` and push (authorised by Daniel on 2026-10-06 for finished pieces), read back, and rebuild the installers.
