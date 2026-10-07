# A model choice for the assistant: implementation plan

Design: `docs/specs/2026-10-07-assistant-models-design.md` (approved 2026-10-07).

Each task is test-first: write the test, watch it fail, write the code, watch it pass, commit. Code is not repeated here. Each task names its contract, its tests and its command.

Run everything: `npm test`. One file: `node --test ./test/<name>.test.js`.

## File map

| File | New or changed | Task |
| --- | --- | --- |
| `core/chat/backends.js` | changed | 1 |
| `core/chat/codex.js`, `core/chat/claudeCode.js` | changed | 2 |
| `core/chat/chat.js` | changed | 3 |
| `renderer/lib/chatStore.js` | changed | 4 |
| `renderer/components/ChatPanel.js`, `renderer/styles/app.css` | changed | 5 |
| `test/ui-smoke.mjs` | changed | 5 |
| `README.md`, the designs | changed | 6 |

## Task 1: the lists

A ready Codex entry carries `models`: `{ name, label, about }` for each model its `debug models` marks `visibility: "list"`, in its order. `name` is the slug and must be plain: a letter or digit, then letters, digits, dot, dash, underscore or colon, 80 characters at most. `label` is the display name (the slug when there is none), cut at 60. `about` is the description, cut at 200. At most 40, no name twice. The command is given 5 seconds and 4 MB. A failure, text that is not JSON, or another shape gives an empty list. It is asked only when Codex is signed in.

A ready Claude Code entry carries the four short names: `haiku`, `sonnet`, `opus`, `fable`, each with a label and a line.

Tests (`test/chatBackends.test.js`): today's real shape (a cut of the real output as a fixture, hidden ones left out, order kept); the command failing, throwing, printing nothing, printing other JSON; odd names (spaces, quotes, a leading dash, 81 characters, a number, a repeat); long labels and descriptions cut; over 40 cut; not asked when signed out or missing; Claude's four names; Ollama's list unchanged.

## Task 2: the arguments

`codexArgs({ ..., model })` puts `-m <model>` straight after `exec`. `claudeArgs({ ..., model })` puts `--model <model>` before `--system-prompt`. With no model, the arguments are exactly what they were. A name that is not plain throws: it is never written as an argument.

Tests (`test/chatCodex.test.js`, `test/chatClaude.test.js`): with and without; byte-for-byte the old list without; a name with a leading dash or a space throws.

## Task 3: the chat

`send({ backend, model })`: for Claude Code and Codex, a model that is given must be the name of one in that backend's list, else `INVALID` "Choose one of Codex's models, or its own choice." No model means the tool's own choice. The name reaches the program as its argument. Ollama is unchanged.

Tests (`test/chat.test.js`): the stand-in's arguments hold `-m` or `--model` with the name; without a model they hold neither; a name not in the list is refused and nothing starts; a backend with no list refuses any name; Ollama as before.

## Task 4: what the window keeps

`prefs.models`: `{ claude, codex, ollama }`, each a string of at most 200 characters, replacing `prefs.model`. A saved `model` from before becomes `models.ollama`.

Tests (`test/chatStore.test.js`): kept and read back; the old shape carried over; damaged values become empty.

## Task 5: the panel

Under "Who answers", a ready backend with a list shows a Model choice. For Claude Code and Codex the first item is "its own choice". Under it, the line about the chosen model. The footer names the model when one is picked. A remembered model that is no longer listed counts as the tool's own choice.

`test/ui-smoke.mjs`: the choice appears for the stand-in Codex; picking one changes the footer and reaches the stand-in as `-m`; a remembered model that leaves the list falls back, in the footer and in the arguments; nothing unnamed, small or spilling at 320 wide.

## Task 6: real calls, and the words

With GPT-6-Luna: the same find, add and change as before, the planted snippet, two spare. Then the README's Assistant section and "What the real calls showed" in the design.
