# A faster assistant: design

Status: waiting for Daniel's approval.

This follows the chat assistant (`2026-10-07-chat-assistant-design.md`). It changes how a message is prepared and what the panel shows first. It adds no backend, no tool and no dependency.

## Goal

A find should show its answer at once. Every other message should need fewer steps from the model.

## Decisions already made

| Question | Daniel's answer, 2026-10-07 |
| --- | --- |
| Which speed-ups to build now? | Hits up front, and instant results. Not the faster-model choice, and not keeping Codex running. |
| May real Codex calls be made to measure before and after? | Yes, about eight, on Daniel's ChatGPT sign-in, against a throwaway snippet folder. |

## Where the time goes

The app's own search takes 0.3 ms on Daniel's folder (1 file, 3 snippets) and about 130 ms on a made-up library of 9,000 snippets. The wait is the model.

Three real Codex calls on the current build, today, each against a throwaway copy of the test snippets. One call each, so these are single readings, not averages.

| Message | Tool calls | First words | Done |
| --- | --- | --- | --- |
| "Find my snippet for saying thanks" | 1: search | 5.1 s ("I'll search your snippets") | 9.6 s |
| "Add a snippet ;brb that expands to Be right back." with base.yml open | 3: list files, read file, add | 4.6 s ("I'll read base.yml") | 11.5 s |
| "Change the snippet I have open so it says Kind regards instead of Best." | 3: search, read snippet, change | 4.6 s ("I'll read the open snippet") | 13.4 s |

Codex needs about 5 seconds before its first words, and then about 2 to 2.5 seconds for each further step. Yesterday the same kind of step took about 5 seconds, so the saving from each step removed moves with the day.

Sending also waits about 630 ms to look at the three backends again, whenever the last look is more than a minute old. That is most messages.

## Three ways to do it

1. **The app makes the likely first lookups itself (recommended).** Before the model is asked, the app searches for the words of the message and reads what is open. It shows the matches in the panel and hands the same results to the model. Small, and it keeps every rule the assistant already works under.
2. **Keep the backend running between messages.** Saves about 2 seconds of start-up per message. It changes how an answer starts, stops and is cleaned up, which is the part the review looked at hardest. Not now.
3. **Answer a find with no model at all.** The app would have to guess that a message is a find. A wrong guess gives a list where an answer was wanted. Way 1 shows the same list at once and still lets the model answer.

## What changes

### 1. The app looks first

When a message is sent, the app makes up to three lookups, with the same read-only tools the assistant has:

| Lookup | When | What it holds |
| --- | --- | --- |
| Closest matches | The message has at least one word worth searching for | Up to 8 snippets: file id, position, triggers, label, and the first 120 characters of the text |
| The open snippet | A snippet is open | That snippet whole, and its file's version |
| The open file | A file is open | Its version, prefix, and a summary of up to 25 snippets |

All three together are kept under 12,000 characters. When they do not fit, the open file's summary goes first, then matches from the end of the list.

**Closest matches** is a new kind of search, because the app's search wants every word to appear and a sentence never passes that. It works like this:

- Words that carry no meaning in a request are dropped: "find", "my", "snippet", "for", "the", "add", "please" and the like.
- A word that starts with a sign, such as `;brb` or `:sig`, is kept whole. It is probably a trigger.
- A word also counts in a shorter form, so "thanks" finds "Thank you" and "refunds" finds "refund".
- A snippet is kept when it holds at least half of the words. A word found in a trigger counts most, then a label or search term, then the text.
- The closest come first. The person's own files come before packages when two are equally close.

The existing search, the search tool and the search page stay as they are.

### 2. The panel shows the matches at once

The matches arrive in the panel before the backend has started. They sit at the top of the answer, under the heading "Closest matches": the first three, and a "Show all" button when there are more. Each row shows the triggers, the start of the text and the file name. Pressing a row opens that snippet in the editor.

A row is found again when it is pressed. If the snippet has moved in its file, the app opens it where it is now. If it is gone, the app opens the file.

The matches are kept with the conversation, so they are still there in the history.

### 3. The model is handed the same results

The lookups go into the message under their own tag, `<looked_up_by_the_app>`, each in the exact shape its tool returns. The assistant's instructions gain three points:

- The app has already made these lookups. Answer from them when they hold what is needed, and call a tool only for what they do not cover.
- A match holds some of the words, not always all of them. Say so when none fits.
- Start with the answer. Do not announce a search or a read.

The instruction "read a file before proposing a change to it" becomes "you need the file's current version: use the one in the lookups, or read the file".

The expected effect: a find needs no tool call, and an add or a change to what is open needs one.

### 4. Sending no longer waits for the backends to be looked at

A message uses the last look, however old. When that look is over a minute old, a new one runs behind the answer. Only the first message after the app starts can wait, and the panel already looks when it opens.

If the backend has since been signed out or removed, the answer fails with the same message as today, and the panel looks again.

## What leaves this computer

Today a cloud backend receives your messages and the snippets the assistant asks for. After this change it also receives, with every message, the closest matches and what you have open, whether or not the answer needs them. Daniel accepted that trade on 2026-10-07.

The panel's notice changes to say so: "Sends your messages, the snippets that match them, what you have open, and the snippets it reads, to OpenAI, under your own sign-in." Because what is sent has changed, the notice is shown once more for each backend, and Send waits for OK as it does today.

A local Ollama model still sends nothing.

## Other people's text

A match can come from a team package or an installed package, so text someone else wrote now reaches the model without the model asking. The same three things hold as before: the assistant has the snippet tools only, nothing changes without Apply on a card, and sending to the team is itself a card. Two more are added. The lookups sit inside their own tag, and text in them cannot close that tag or open another. And the instructions already say that snippet text is data.

One real call checks it: a planted snippet that matches the message and tells the assistant to delete everything.

## What could go wrong

| Path | Realistic failure | Handled how | Test | What you see |
| --- | --- | --- | --- | --- |
| Lookups | The message has no word worth searching for | No search is made | Search test | No "Closest matches" block |
| Lookups | Nothing matches | An empty result is not shown and not sent | Lookups test | No block |
| Lookups | The snippet folder cannot be read | The failure is logged, and the answer goes on without lookups | Lookups test with a store that throws | The answer, as today |
| Lookups | The open file is gone, unreadable or has YAML errors | That lookup is left out | Lookups test | The answer, as today |
| Lookups | The window names a file or position that does not exist | It goes through the same read-only tools, which refuse it | Lookups test with a made-up id and a position of -1, 1.5 and "2" | The answer, as today |
| Lookups | A very long trigger, label or snippet | Cut as the tools cut them; the whole block is capped at 12,000 characters | Lookups test with 300 long snippets | Shorter rows |
| Lookups | A library of thousands of snippets | One read of the folder, about 130 ms for 9,000 snippets, before the backend starts | Timed in the search test | Nothing |
| Lookups | Stop is pressed while the app is looking | Checked before the backend starts | Chat test | "Stopped" |
| Lookups | The file changes after the lookup | The version no longer fits, and the proposal is refused with "read again", as today | Existing proposals test | The assistant reads again |
| Model | It ignores the lookups and searches anyway | Nothing breaks: the tools are unchanged | Real call counts the tool calls | A slower answer |
| Model | It answers from a match that does not fit | The instructions say a match may hold only some words | Real call | An answer the matches list lets you check |
| Model | A match carries instructions | Framed as data; tools are read-only; changes are cards | Prompt test for the frame; one real call with a planted snippet | Nothing happens |
| Panel | The matches arrive before the window knows the answer's name | Kept and shown once it does, as other early events are | Window check | The block, at once |
| Panel | A row is pressed after its snippet moved or was deleted | Found again by its triggers; else the file is opened | Unit test for the finder | The snippet where it is now, or its file |
| Panel | A row is pressed with unsaved edits open | The app's own "discard your edits?" step | Window check | That question |
| Panel | History holds matches from an earlier day | Rows are found again when pressed, as above | Store test | The same |
| Panel | Storage is full or damaged | Matches are dropped with the rest, as today | Store test | An empty history |
| Sending | The last look at the backends is stale and the backend is now signed out | The answer fails with the existing message, and the panel looks again | Chat test | "Codex is not signed in" |
| Sending | No look has been made yet | Sending waits for one, as today | Chat test | A short wait, once |
| Notice | The person already pressed OK for a backend before this change | The notice shows once more | Store test | The new notice |

## Checks

- Unit tests for the new search, the lookups, the prompt, the chat, the store and the row finder, each watched to fail first.
- The window check and the packaged check, extended for the matches block.
- Real Codex calls, about five more: the three messages above on the new build, the planted snippet, and one spare. Each on a throwaway folder.
- The README's Assistant section and the earlier design are updated to match.

## Not proven by this piece

- Claude Code and Ollama are not measured. Claude Code is signed out on this Mac and Ollama is not running.
- The timings are single readings on one day.

## Not in this piece

- A faster model per backend.
- Keeping a backend running between messages.
- Carrying an earlier message's matches into a follow-up such as "delete that one". The assistant looks again, as it does today.
- A switch to turn the lookups off.
