# A faster assistant: implementation plan

Design: `docs/specs/2026-10-07-assistant-speed-design.md` (approved 2026-10-07).

Each task is test-first: write the test, watch it fail, write the code, watch it pass, commit. Code is not repeated here. Each task names its contract, its tests and its command.

Run everything: `npm test`. One file: `node --test test/<name>.test.js`.

## File map

| File | New or changed | Task |
| --- | --- | --- |
| `shared/search.js`, `core/store.js` | changed | 1 |
| `mcp/tools.mjs` | changed | 2 |
| `core/chat/lookups.js` | new | 3 |
| `core/chat/prompt.js` | changed | 4 |
| `core/chat/chat.js` | changed | 5 |
| `renderer/lib/chatStore.js` | changed | 6 |
| `renderer/lib/found.js` | new | 7 |
| `renderer/components/ChatPanel.js`, `renderer/app.js`, `renderer/styles/app.css` | changed | 8 |
| `test/ui-smoke.mjs`, `test/packaged-smoke.mjs` | changed | 9 |
| `README.md`, both designs | changed | 10 |

## Task 1: the closest matches

`keywordsOf(text)` → the words worth searching for, each as `{ word, forms, sign }`. Request words are dropped. A word that starts with a sign is kept whole and has one form. Other words are lower-cased, lose the punctuation around them, and gain shorter forms (without a final `s`, `es`, `ing` or `ed`) when at least 4 letters stay. At most 12 words, each at most 60 characters.

`likelyFiles(files, text, { limit = 8 })` → hits shaped as `searchFiles` shapes them, plus `matched` (how many words) and `weight`. Kept when `matched >= ceil(words / 2)`. Weight per word: 4 in a trigger, 3 in a label or search term, 1 in the text. Order: `matched`, then `weight`, then own files before team before packages, then file and list order.

`store.likely(text, options)`, beside `store.search`.

Tests (`test/search.test.js`, new block): a sentence finds what the plain search misses; request words alone find nothing; a trigger with a sign is found by it; "thanks" finds "Thank you"; half the words keep a snippet and fewer drop it; trigger beats label beats text; own file before a package at equal closeness; the limit; files with no list of matches are skipped; 9,000 snippets in under a second; hostile input (very long text, 5,000 words, regex signs) returns quickly. `searchFiles` is untouched: its tests pass unchanged.

## Task 2: one shape for a match

`foundItem(hit)` exported from `mcp/tools.mjs`: `{ file_id, file, source, package?, index, triggers, label, preview }`. The search tool uses it. Tests (`test/mcpTools.test.js`): the search tool's reply is byte-for-byte what it was; `foundItem` on a hit from `likelyFiles` has the same keys.

## Task 3: the lookups

`createLookups({ store, tools, log, most = 12_000 })` → `lookUp({ text, context })` → `{ found, lookups }`.

- `found`: for the panel. Up to 8 of `{ fileId, fileName, source, index, triggers, label, preview }`, triggers at most 5, each string cut as the tools cut it.
- `lookups`: for the model, in order: `{ tool: 'snippets_get_snippet', args, result }` when a snippet is open, `{ tool: 'snippets_search', note, result }` when there are matches, `{ tool: 'snippets_get_file', args, result }` when a file is open (`detail` summary, `limit` 25).
- Each result is the tool's own `structuredContent`. A tool error, a thrown error or a `problem` in the result leaves that lookup out. A thrown error is logged.
- The whole of `lookups`, as JSON, stays under `most`: the file summary goes first, then matches from the end. `found` always equals the matches that were kept.
- `context` is trusted for nothing: `fileId` must be a string, `index` a whole number of 0 or more.

Tests (`test/chatLookups.test.js`): each lookup appears when it should and not otherwise; results equal what the tool returns; nothing matches means no search lookup and an empty `found`; a store that throws; an open file that is gone, broken or unreadable; made-up ids and positions (-1, 1.5, "2", a package file); 300 long snippets stay under the cap and `found` shrinks with the matches; the three run without waiting on each other.

## Task 4: the prompt

`promptText({ messages, context, lookups })` adds `<looked_up_by_the_app>` between `<open_in_the_app>` and `<new_message>`: one line of words, then for each lookup its call and its result as one line of JSON. `promptMessages` puts the same block before the new message. The frame's tag list gains `looked_up_by_the_app`, and a result's text cannot close or open a frame tag.

`SYSTEM` gains the three points of the design and the reworded line about a file's version.

Tests (`test/chatPrompt.test.js`): the block is there with lookups and absent without; its place; a result holding `</looked_up_by_the_app>` or `<new_message>` cannot break the frame; Ollama's messages carry it; the instructions say to answer from the lookups, that a match may hold only some of the words, and not to announce a search; they still say never to claim a change was made.

## Task 5: the chat

In `send`: the last look at the backends is used however old. With none yet, one is made and waited for. When the last is older than `statusMs`, a new one starts and is not waited for.

In the answer: `lookUp` runs first. `{ turnId, type: 'found', hits }` is emitted when there are hits, before the backend starts. Stop during the lookups ends as stopped. The lookups go into the prompt for all three backends.

Tests (`test/chat.test.js`): `found` is the first event and matches the fixtures; no `found` for a message with no word worth searching; the stand-in's input holds the block (directive `ARGS`); a lookup that throws still answers; stop during a slow lookup; a stale look does not delay `send` and is refreshed behind it; a first message with no look waits for one; a stale "ready" with a signed-out stand-in ends as `SIGNED_OUT` and drops the look.

## Task 6: what the window keeps

`messageOf` keeps `found` on an assistant message: at most 8 rows, each field checked and cut. `prefs.toldVersion`: when it is not the current one, `told` is emptied.

Tests (`test/chatStore.test.js`): `found` survives save and load; damaged rows are dropped; more than 8 are cut; a saved `told` from before this change comes back empty and a new one is kept.

## Task 7: finding a row again

`whereNow(state, hit)` in `renderer/lib/found.js` → the route to open: the snippet at its position when its triggers still match, else the first snippet in that file with the same triggers, else the file, else `null`.

Tests (`test/found.test.js`): unchanged; moved; deleted; file gone; a file with YAML errors.

## Task 8: the panel

The "Closest matches" block at the top of an answer: three rows, "Show all N" when there are more, each row a button that opens the snippet through `whereNow`. The notice and the "Who answers" page use the new sentence. `told` uses the new version.

Checked in task 9.

## Task 9: the window checks

`test/ui-smoke.mjs`: with the stand-in, a find shows the block before the answer ends; a row opens the snippet; the block has no unnamed or small control and nothing overflows at 320 wide; the notice shows the new sentence. `test/packaged-smoke.mjs`: the block appears in the packaged app.

## Task 10: real calls, and the words

The three messages of the design on the new build, the planted snippet, one spare. Then the README's Assistant section, a "What the real calls showed" section in the new design, and a pointer from the earlier design.
