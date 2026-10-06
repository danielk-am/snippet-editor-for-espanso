# MCP server Implementation Plan

**Goal:** A small program an AI tool starts, which lets it search and read snippets, and change them once "Let AI tools change snippets" is switched on, by calling the app's local API.

**Architecture:** Three self-contained modules under `mcp/`: the protocol (messages on standard input and output, both MCP shapes), the tools (twelve, each mapping to API routes), and the API client (finds the app's data folder, reads the port and token). `mcp/server.mjs` wires them. Nothing under `mcp/` imports from the rest of the app, so the folder can be packaged unpacked and run by the installed app's own program.

**Tech Stack:** Node built-ins only (`readline`, `fs`, `fetch`). No new dependency.

Spec: `docs/specs/2026-10-06-mcp-server-design.md`.

As in the team snippets plan, each task fixes the contract, the tests and the commands; the code is written test first, straight into the files.

---

## File map

| File | Change | Responsibility |
| --- | --- | --- |
| `mcp/protocol.mjs` | Create | JSON-RPC lines in, lines out; `initialize` and per-request versions; `server/discover`, `tools/list`, `tools/call`, `ping` |
| `mcp/client.mjs` | Create | Data folder, settings, token, and one `request` to the API |
| `mcp/tools.mjs` | Create | Twelve tools: definitions, input checks, calls, results, errors |
| `mcp/server.mjs` | Create | The program an AI tool starts |
| `core/settings.js` | Modify | `aiWrite`, off by default |
| `electron/mcpSetup.js` | Create | The command an AI tool needs to start the server, for this copy of the app |
| `electron/ipc.js`, `electron/preload.cjs`, `shared/channels.js`, `electron/bootstrap.js`, `electron/main.js` | Modify | `ai:get`, `ai:set`, `ai:copySetup` |
| `renderer/components/SettingsPage.js`, `renderer/lib/api.js` | Modify | The "AI tools" card |
| `electron-builder.yml`, `package.json` | Modify | `mcp/` packaged, unpacked; an `mcp` script |
| `test/mcpProtocol.test.js`, `test/mcpClient.test.js`, `test/mcpTools.test.js`, `test/mcpServer.test.js`, `test/mcpSetup.test.js` | Create | One test file per unit; the last starts the real program |
| `test/settings.test.js`, `test/ui-smoke.mjs`, `test/packaged-smoke.mjs` | Modify | The setting, the card, and the packaged program answering `server/discover` |
| `test/mcp-eval/` | Create | Ten questions, their answers, the pass mark and the result |
| `README.md` | Modify | "AI tools (MCP)" section |

---

### Task 1: The protocol

**Contract.** `createProtocol({ serverInfo, instructions, tools, log })` returns `{ handleLine(line), serve({ input, output }) }`. `tools` is `{ list(), call(name, args) }`; `call` returns a result, or `null` for an unknown tool.

| Client sends | Reply |
| --- | --- |
| `initialize` | `protocolVersion` as requested if one of `2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05`, else `2025-11-25`; `capabilities: { tools: {} }`; `serverInfo`; `instructions`. The process then serves requests that carry no version. |
| A request whose `_meta` names `2026-07-28` and gives `clientCapabilities` | Served on its own. The result carries `resultType: "complete"` and the server's name in `_meta`. |
| `_meta` names another version | Error `-32022`, `data: { supported, requested }` |
| `_meta` names a version but no `clientCapabilities` | Error `-32602` |
| No version, before `initialize` (other than `ping`) | Error `-32602`, naming the versions |
| `server/discover` | `supportedVersions: ["2026-07-28"]`, capabilities, instructions |
| `tools/list` | The tools, in a fixed order |
| `tools/call` | The tool's result; unknown tool or bad params: `-32602` |
| `ping` | An empty result |
| A notification | No reply. `notifications/cancelled` drops the reply of the named request |
| Unknown method | `-32601` |
| Not JSON | `-32700` with `id: null` |
| A batch, or not a request | `-32600` |
| A tool that throws | `-32603`, logged, with no detail in the reply |

`serve` reads lines, answers each on one line, runs calls side by side, and resolves when the input closes and every answer is written.

**Tests** (`test/mcpProtocol.test.js`): each row above; the examples from the specification for `initialize`, `server/discover`, `tools/list` and `tools/call`; two calls in flight answered under their own ids; a cancelled call gets no reply; nothing but one JSON object per line is written.

Run: `node --test test/mcpProtocol.test.js`

### Task 2: The API client

**Contract.** `dataDirFor({ env, platform, home })` gives the app's data folder: the override, or the platform's folder for "Snippet Editor". `createApiClient({ dataDir, fetch })` returns `settings()` (`apiEnabled`, `apiPort`, `aiWrite`, with safe defaults when the file is missing or damaged) and `request(method, path, { query, body, timeout })`, which resolves `{ status, body }` or throws an error with `code: 'UNREACHABLE'` and a plain message. It reads the token file on each call, retries once on 401 with the token read again, and never puts the token in an error.

**Tests** (`test/mcpClient.test.js`, against the real listener): the three platforms and the override; a call that succeeds; API off; no token file; nothing listening; a stalled listener; a token replaced mid-run; a 401 that persists; the token absent from every error.

Run: `node --test test/mcpClient.test.js`

### Task 3: The tools

**Contract.** `createTools({ api })` returns `{ list(), call(name, args) }`. `list()` gives twelve definitions: `name`, `title`, `description`, `inputSchema`, `annotations`. `call` checks the input against the schema, refuses a write tool when `aiWrite` is off, calls the API, and returns `{ content: [{ type: 'text', text }], structuredContent, isError }`.

The tools, their inputs and their routes are in the design. Rules: lists default to 50 items and stop at 200, with `total_count`, `has_more` and `next_offset`; a reply over 25,000 characters is cut at a whole item and says so; every API error becomes a tool error in a sentence that names the next call; no reply carries the token, a path or a stack.

**Tests** (`test/mcpTools.test.js`, against the real router and listener on the fixtures): every tool's success with exact results; each input check; paging and the size cut; each write tool with the switch off and on; a stale version; a read-only file; the team tools with no repository and with one; the app unreachable.

Run: `node --test test/mcpTools.test.js`

### Task 4: The program

**Contract.** `node mcp/server.mjs` speaks MCP on its standard streams and exits when its input closes. It writes nothing but messages to standard output.

**Tests** (`test/mcpServer.test.js`): start it as a child process against a running listener; the older handshake, then list and call; the newer per-request form with `server/discover`; a write with the switch off, then on; it exits when its input closes; standard output holds only JSON lines.

Run: `node --test test/mcpServer.test.js`

### Task 5: The setting and the Settings card

**Contract.** `aiWrite` in settings, off by default. `mcpSetup({ packaged, execPath, resourcesPath, appPath })` returns `{ command, args, env }`. Channels `ai:get`, `ai:set` and `ai:copySetup`. Settings shows "AI tools": the switch, what an AI tool can do in each position, and "Copy setup".

**Tests**: `test/settings.test.js`, `test/mcpSetup.test.js`, and a step in `test/ui-smoke.mjs` that flips the switch, checks the settings file and what was copied.

Run: `npm test && npm run test:ui`

### Task 6: Packaging

**Contract.** `mcp/` is in the package and unpacked. The packaged app's own program, with `ELECTRON_RUN_AS_NODE=1`, runs the unpacked `server.mjs`.

**Tests**: `test/packaged-smoke.mjs` starts it that way and gets a `server/discover` answer.

Run: `npm run pack && npm run test:packaged`

### Task 7: Usability check and README

Ten read-only questions with one checkable answer each, against the fixtures, answered by a fresh agent that has only these tools. Pass mark 8 of 10, with no failure caused by a misleading description. Kept in `test/mcp-eval/`. Then the README section and the design's record of changes.

---

## Self-review

Every row of the design's protocol table is in Task 1. Every tool is in Task 3. Every row of the failure table is named by a test in Tasks 1 to 4. Nothing in "Not in this piece" is built.
