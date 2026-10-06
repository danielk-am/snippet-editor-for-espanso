# MCP server: design

Status: awaiting Daniel's approval. No code is written until it is approved.

This is the third of three connected pieces. It builds on the local API (built) and on team snippets (`2026-10-06-team-snippets-design.md`).

## Goal

An AI tool, such as Claude or Codex, can search and read your snippets, and change them once you allow it, without leaving the conversation.

## Decisions already made

| Question | Daniel's answer, 2026-10-06 |
| --- | --- |
| May AI tools change snippets? | Off until switched on. Reading and searching work from the start. Adding, changing and deleting snippets, installing team packages and sending proposals need a switch in Settings. |
| How do AI tools reach the snippets? | Through the app's API. The app must be open with "API for other tools" switched on. |

## How it fits together

```
AI tool ── starts ──▶ mcp/server.mjs ── HTTP + token ──▶ the app's API ──▶ store ──▶ match files
          (stdio)      (one file, no dependency)          (127.0.0.1)
```

| Piece | File | Job |
| --- | --- | --- |
| Protocol | `mcp/protocol.mjs` (new) | Reads and writes MCP messages on standard input and output. Knows nothing about snippets. |
| Tools | `mcp/tools.mjs` (new) | The twelve tools: their descriptions, their input checks, and how each maps to API routes. |
| API client | `mcp/client.mjs` (new) | Finds the app's data folder, reads the port and the token, and calls the API. |
| Entry | `mcp/server.mjs` (new) | Wires the three together. This is the file an AI tool starts. |
| Settings | `core/settings.js`, Settings page | A switch, "Let AI tools change snippets", and a button that copies the setup for an AI tool. |

The server is a small program the AI tool starts and stops. It listens on no port. It holds no snippets of its own: every tool call is one or more calls to the API, so the window, a script and an AI tool all go through the same checks.

## Two ways to build it

| Approach | For | Against |
| --- | --- | --- |
| **Written by hand, no dependency (recommended)** | The server needs five protocol methods. The app has one runtime dependency today and no build step. The packaged app can run the server with its own program, so nobody needs Node installed. | The protocol must be tracked by hand. It changed shape in July 2026. |
| The official SDK, `@modelcontextprotocol/sdk` | Protocol changes arrive as updates. | A new dependency with its own tree, in an app that has avoided them. Adding one needs your approval. |

The tests pin the hand-written protocol to the examples in the published specification, for both shapes below.

## Protocol

MCP changed in its `2026-07-28` revision. Older clients open with an `initialize` handshake. Newer ones send no handshake: every request carries its protocol version, and the server must answer `server/discover`. The specification calls a server that speaks both "dual-era". This server is dual-era, so it works with AI tools on either side of the change.

| Client sends | Server does |
| --- | --- |
| `initialize` | Answers with the requested version if it is one of `2025-11-25`, `2025-06-18`, `2025-03-26` or `2024-11-05`, else with `2025-11-25`. Serves that process the older way from then on. |
| A request with `_meta` naming version `2026-07-28` | Serves it on its own, with `resultType` in the result and the server's name in `_meta`. |
| A request with `_meta` naming a version it does not speak | Error `-32022` listing the versions it does. |
| A request with neither, before any `initialize` | Error `-32602`, naming the versions it speaks. |
| `server/discover`, `tools/list`, `tools/call`, `ping` | Answered. |
| `notifications/initialized`, `notifications/cancelled` | Accepted. A cancelled call's reply is dropped. |
| Any other method | Error `-32601`. |
| A line that is not JSON, or not a request | Error `-32700` or `-32600`. |

Messages are one JSON object per line. Nothing but messages goes to standard output. Diagnostics go to standard error. The server exits when its input closes.

## Tools

Twelve tools, each named for a job, with one prefix so they stay distinct beside other servers.

| Tool | Does | Changes anything? |
| --- | --- | --- |
| `snippets_search` | Finds snippets by trigger, label or text across every file, package and team package | No |
| `snippets_list_files` | Lists files with their source, description, prefix, snippet count and any problem | No |
| `snippets_get_file` | One file: its snippets in brief, in full, or its raw YAML, with the version a change needs | No |
| `snippets_get_snippet` | One snippet in full, with its file's version | No |
| `snippets_list_team_packages` | The team repository and its packages: installed, update available, runs commands | No |
| `snippets_add_snippet` | Adds a snippet to one of your files | Yes |
| `snippets_update_snippet` | Changes one snippet | Yes |
| `snippets_delete_snippet` | Removes one snippet | Yes, removes |
| `snippets_create_file` | Creates a match file | Yes |
| `snippets_replace_file_yaml` | Replaces a file's raw YAML, for comments, imports and global variables | Yes, replaces |
| `snippets_install_team_package` | Installs or updates a team package | Yes |
| `snippets_propose_to_team` | Sends one of your files to the team repository as a proposal branch | Yes, outside this computer |

Left out on purpose: deleting a file, removing a team package, connecting a repository, and anything in Settings. Those stay in the window.

Rules every tool follows:

- **Results are small.** A list returns at most 50 items by default and 200 at most, with `total_count`, `has_more` and `next_offset`. Every reply is capped at 25,000 characters and says so when it was cut, and how to narrow the request.
- **Names sit beside ids.** A file comes back with its id, its name and its source. A snippet comes back with its position, its triggers and its label.
- **A change needs the version.** Each write tool takes the `version` from the last read of that file. If the file changed since, the tool says so and names the tool to call again. An AI tool cannot overwrite a change it has not seen.
- **Errors teach.** A failed call returns a tool result marked as an error, in a sentence that says what was wrong and what to call next. It carries no path, token or stack.
- **Each description is written for a model:** what the tool does, when to choose it over its neighbours, each input with an example, and what comes back.
- **Hints match effects.** Read tools are marked read-only. Delete and replace are marked destructive. The proposal tool is marked as reaching outside this computer.
- **The token never appears** in a tool result, a description or a log line.

## The switch for changes

Settings gets a card, "AI tools":

- A switch, "Let AI tools change snippets", off by default (`aiWrite` in settings).
- A button, "Copy setup", which copies the few lines an AI tool needs to start the server. It holds paths only, no secret.
- A sentence on what an AI tool can and cannot do in each position of the switch.

With the switch off, the seven write tools are still listed, so the list of tools never changes under a client. Each answers: "Changing snippets is switched off. Ask the person to switch on 'Let AI tools change snippets' in Snippet Editor's Settings." The server reads the switch from the settings file before each write, so a change takes effect at once.

What the switch is and is not: it governs this MCP server. Another program on this computer that holds the API token can still change snippets through the API. That was the API's design, and Settings says so.

## Finding the app

The server reads two files in the app's data folder: `settings.json` for the port and the switches, and `api-token` for the token.

| Platform | Data folder |
| --- | --- |
| macOS | `~/Library/Application Support/Snippet Editor` |
| Windows | `%APPDATA%\Snippet Editor` |
| Linux | `$XDG_CONFIG_HOME/Snippet Editor`, or `~/.config/Snippet Editor` |

`SNIPPET_EDITOR_DATA_DIR` overrides it, for tests and unusual setups.

## Starting it

From source: `node mcp/server.mjs`.

From the installed app, with its own program, so Node is not needed:

```
command:  <the app's program>
args:     <the app's resources>/app.asar.unpacked/mcp/server.mjs
env:      ELECTRON_RUN_AS_NODE=1
```

"Copy setup" fills those in for the copy of the app that is running. The `mcp/` folder is packaged unpacked so a program can read it.

## What could go wrong

| Path | Realistic failure | Handled how | Test | What the AI tool, and you, see |
| --- | --- | --- | --- | --- |
| Start | The app is not running, or its API is off | Found on the first tool call, not at start, so the server still answers `tools/list` | Client test with nothing listening | Tool error: "Snippet Editor is not reachable. Open the app and switch on 'API for other tools' in Settings." |
| Start | No data folder, no settings file, or no token file | The same answer as above | Client test with an empty folder | The same |
| Start | The token was replaced while the server ran | The token file is read again on a 401, once | Client test that swaps the token | The call succeeds |
| Protocol | A line that is not JSON | `-32700`, and the server carries on | Protocol test | A protocol error |
| Protocol | A version the server does not speak | `-32022` with the list (newer shape); the latest it speaks (older shape) | Protocol test, both | The client picks another version |
| Protocol | A request with no version, before `initialize` | `-32602` naming the versions | Protocol test | A protocol error |
| Protocol | Unknown method | `-32601` | Protocol test | A protocol error |
| Protocol | Unknown tool | `-32602`, "Unknown tool" | Protocol test | A protocol error |
| Protocol | Input closes | The server exits | Protocol test | The process ends |
| Protocol | Two calls in flight at once | Each is answered under its own id | Protocol test | Both answers |
| Protocol | A call is cancelled | Its reply is dropped | Protocol test | No reply for that id |
| Tool input | A required input is missing, or of the wrong kind | Checked before the API is called | Tool test per tool | Tool error naming the input, with an example |
| Tool input | A file id or position that does not exist | The API's 404 or 400, reworded | Tool test | Tool error: which tool lists valid ids |
| Read | A reply longer than 25,000 characters | Cut at a whole item, with a note | Tool test with a large file | The note says how to page or narrow |
| Read | Search with no hits | An empty list with a suggestion | Tool test | "No snippets match. Try fewer words." |
| Read | A file holds a value JSON cannot carry | The API's 422, reworded | Tool test | Tool error: open the file in the app |
| Write | The switch is off | Refused before the API is called | Tool test, each write tool | The sentence above |
| Write | The file changed since it was read | The API's 409 | Tool test | Tool error: read the file again, then retry with the new version |
| Write | A package or team file | The API's 403 | Tool test | Tool error: copy the snippet into one of your own files first |
| Write | The same call sent twice | The second carries a stale version | Tool test | The second gets the "changed since" error |
| Write | The app quits mid-call | The API's write is atomic; the call fails | Client test that drops the connection | Tool error: not reachable. The file is whole |
| Team | No repository connected | The API's 409 | Tool test | Tool error: connect one in the app's Settings |
| Team | A package runs commands and that was not accepted | The API's refusal | Tool test | Tool error: ask the person first, then send `accept_commands` |
| Team | A proposal fails at git | The API's 502 | Tool test | Tool error with git's plain reason |
| Any | The API takes too long | 150 seconds for the two team write tools, which wait on git, and 15 for the rest | Client test with a stalled listener | Tool error: the app did not answer in time |

## How it will be tested

- **Protocol tests** drive `mcp/protocol.mjs` with lines of text and check the lines that come back, for both shapes, against the examples in the specification.
- **Tool tests** run each tool against the real router and listener on a temporary copy of the fixtures.
- **A whole-program test** starts `node mcp/server.mjs` as a child process, speaks both shapes to it over its standard streams, and reads, then writes with the switch on.
- **Packaged-app test:** the installed app's own program starts the unpacked server and answers `server/discover`.
- **Usability check, from the MCP skill.** Ten read-only questions with one checkable answer each, against the fixtures, answered by a fresh agent that has only these tools. Pass mark: 8 of 10, with no failure caused by a misleading description. The questions, answers and result are kept in `test/mcp-eval/`.
- Tests are written first and watched to fail.

## Not in this piece

- Running without the app open.
- A separate, weaker token for AI tools.
- Resources, prompts, or anything in MCP beyond tools.
- Deleting files, removing team packages, connecting a repository, or changing settings from an AI tool.
- Registering the server with any AI tool for you. "Copy setup" gives you the lines; you paste them.
