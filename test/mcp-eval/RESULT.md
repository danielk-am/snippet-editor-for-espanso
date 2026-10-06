# Usability check: result

Run on 2026-10-06, against `questions.json` in this folder.

| | |
| --- | --- |
| Who answered | A fresh agent with no other context. Its only means were `ask.mjs --list` and `ask.mjs <tool> <arguments>`, and it was told not to read any file. |
| Pass mark, set before the run | 8 of 10, with no failure caused by a misleading description |
| Result | 10 of 10 correct |
| Tool calls | 14 for the ten questions, with no tool error |

The limit of this check: the agent reached the tools through a command line, not through an MCP client of its own. What it was shown is the server's real `tools/list` and real tool results.

## What confused it, and what was changed

Nothing made it answer wrongly. These cost it an extra call or a moment of doubt, and each was fixed in the tool descriptions afterwards:

| What it said | Change |
| --- | --- |
| It could not tell whether `preview` was the whole text. | The search and file tools now say a preview is cut to 120 characters and ends in "..." when longer. |
| Every example file id was a local one, so it listed team files to learn the shape. | The file id input now gives a local, a package and a team example. |
| "Package" meant two things, and a team package and an Espanso package shared a name. | The list tools now say the two are separate even when they share a name. |
| `total_count` next to `snippet_count` read like a count of snippets. | The file list now says it counts files. |
| It was unsure a trigger such as `;sig` would work as a search. | The query input now gives a trigger as an example. |
| It did not know a file's `global_vars` are outside any one snippet. | The single-snippet tool now says so and points to the raw text. |
| It did not know how paging applies to raw text, or what `installed_only` means. | Both are now stated. |

The set was not run again after these wording changes: no answer was wrong, and the changes only add to what the descriptions say.

## Running it again

```bash
node test/mcp-eval/serve.mjs
```

Leave that running. In another terminal, give an agent the questions and the two `ask.mjs` commands, then compare its answers with `questions.json` by exact match.
