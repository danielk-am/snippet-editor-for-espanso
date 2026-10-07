# A faster assistant: design

Status: approved by Daniel on 2026-10-07, built, reviewed and measured. What changed on the way is under "Changed while building" and "After an independent review".

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

When a message is sent, the app makes up to three lookups. The two that read are made with the assistant's own read-only tools. The closest matches come from the app's store, through the same filter the tools' replies pass.

| Lookup | When | What it holds |
| --- | --- | --- |
| Closest matches | The message has at least one word worth searching for | Up to 8 snippets: file id, file name, where it comes from (your own, a package, a team package), position, up to five triggers, label, and the first 120 characters of the text |
| The open snippet | A snippet is open | That snippet whole, and its file's version |
| The open file | A file is open | Its name, description, prefix and version, and a summary of its first 25 snippets |

All three together are kept under 12,000 characters. When they do not fit, an open snippet that is over the limit by itself is left out, then the open file's summary, then matches from the end of the list.

Looking up has three seconds. Past that the backend is asked without it. Stop ends the wait at once.

**Closest matches** is a new kind of search, because the app's search wants every word to appear and a sentence never passes that. It works like this:

- Words that carry no meaning in a request are dropped: "find", "my", "snippet", "for", "the", "add", "please" and the like. So are words people answer with, such as "yes", "okay" and "great", and the name of a YAML file.
- A word that starts with a sign, such as `;brb` or `:sig`, is kept whole. It is probably a trigger. It finds the trigger that is exactly that, and triggers that start with it when it is three characters or more. It is not looked for inside other triggers or in text, so `:D` is a smiley and not eight snippets.
- Quotes, brackets, backticks and asterisks round a word are set aside. Words joined by a dash or a slash are searched for one by one.
- A word also counts in a shorter form, so "thanks" finds "Thank you" and "refunds" finds "refund".
- A snippet is kept when it holds at least half of the words, or when the message names its trigger. A word found in a trigger counts most, then a label or search term, then the text.
- A named trigger comes first, then the closest. The person's own files come before packages when two are equally close.

The existing search, the search tool and the search page stay as they are.

### 2. The panel shows the matches at once

The matches arrive in the panel before the backend has started. They sit at the top of the answer, under the heading "Closest matches": the first three, and a "Show all" button when there are more. Each row shows the triggers, the label (or the start of the text when there is no label) and the file name. Pressing a row opens that snippet in the editor.

A row is found again when it is pressed. If the snippet has moved in its file, the app opens it where it is now. If it is gone, or two snippets now share its triggers, the app opens the file.

The matches are kept with the conversation, so they are still there in the history.

### 3. The model is handed the same results

The lookups go into the message under their own tag, `<looked_up_by_the_app>`. The two reads are in the exact shape their tool returns. The matches are shaped as the search tool shapes a match, with long triggers, labels and names cut short. The block says the lookups show each file as it was last saved. The assistant's instructions gain three points:

- The app has already made these lookups. Answer from them when they hold what is needed, and call a tool only for what they do not cover.
- A match holds at least half of the words, or has a trigger the message names, not always all of them. Say so when none fits.
- Start with the answer. Do not announce a search or a read.

The instruction "read a file before proposing a change to it" becomes "you need the file's current version: use the one in the lookups, or read the file".

The expected effect: a find needs no tool call, and an add or a change to what is open needs one.

### 4. Sending no longer waits for the backends to be looked at

A message uses the last look, however old. When that look is over a minute old, a new one is made once the answer has ended, when nothing else is starting. Only the first message after the app starts can wait, and the panel already looks when it opens.

If the backend has since been signed out or removed, the answer fails with the same message as today, and the panel looks again.

## What leaves this computer

Today a cloud backend receives your messages and the snippets the assistant asks for. After this change it also receives, with every message, the closest matches and what you have open, whether or not the answer needs them. Daniel accepted that trade on 2026-10-07.

The panel's notice changes to say so: "Sends your messages, the snippets that match them, what you have open, and the snippets it reads, to OpenAI, under your own sign-in." Because what is sent has changed, the notice is shown once more for each backend, and Send waits for OK as it does today.

A local Ollama model still sends nothing.

## Other people's text

A match can come from a team package or an installed package, so text someone else wrote now reaches the model without the model asking. The same three things hold as before: the assistant has the snippet tools only, nothing changes without Apply on a card, and sending to the team is itself a card. Two more are added. The lookups sit inside their own tag, and text in them cannot close that tag or open another: every angle bracket in them is written as its JSON escape, so no spelling of a tag survives, and read as JSON the text is still exactly what the file holds. And the instructions already say that snippet text is data.

With Ollama the lookups travel in the same message as your own words, because its API has no other place for them that was tested here. They are escaped the same way.

One real call checks it: a planted snippet that matches the message and tells the assistant to delete everything.

## What could go wrong

| Path | Realistic failure | Handled how | Test | What you see |
| --- | --- | --- | --- | --- |
| Lookups | The message has no word worth searching for | No search is made | Search test | No "Closest matches" block |
| Lookups | Nothing matches | An empty result is not shown and not sent | Lookups test | No block |
| Lookups | The snippet folder cannot be read | The store reports no files, so there is nothing to look up. A store that throws is logged. Either way the answer goes on. | Lookups tests: a folder with no permissions, and a store that throws | The answer, as today |
| Lookups | Looking up never finishes (a drive that has gone away) | Three seconds, then the backend is asked without it. What comes late is not shown. | Chat test | The answer, without matches |
| Lookups | The open file is gone, unreadable or has YAML errors | That lookup is left out | Lookups test | The answer, as today |
| Lookups | The window names a file or position that does not exist | It goes through the same read-only tools, which refuse it | Lookups test with a made-up id and a position of -1, 1.5 and "2" | The answer, as today |
| Lookups | A very long trigger, label or file name | Cut for a match: five triggers of 80 characters, a label of 80. The whole block is capped at 12,000 characters. | Lookups tests: 300 long snippets, and one match with a 14,000-character label | Shorter rows |
| Lookups | A snippet JSON cannot carry (a number that is not finite) | Left out, as the search tool leaves it out | Lookups test | No row for it |
| Lookups | A library of thousands of snippets | One read of the folder, about 130 ms for 9,000 snippets, before the backend starts | Timed in the search test | Nothing |
| Lookups | Stop is pressed while the app is looking | The wait ends at once, and no backend is started | Chat tests, one with a lookup that never ends | "Stopped" |
| Lookups | The file changes after the lookup | The version no longer fits, and the proposal is refused with "read again", as today | Existing proposals test | The assistant reads again |
| Model | It ignores the lookups and searches anyway | Nothing breaks: the tools are unchanged | Real call counts the tool calls | A slower answer |
| Model | It answers from a match that does not fit | The instructions say a match may hold only some words | Real call | An answer the matches list lets you check |
| Model | A match carries instructions | Framed as data, with no angle bracket left in it; tools are read-only; changes are cards | Prompt tests for the frame in eleven spellings; one real call with a planted snippet | Nothing happens |
| Model | It makes a change from the open snippet as handed over | The snippet reaches it exactly as in the file | Prompt test: each result parses back to the same value | The card shows the real text |
| Panel | The matches arrive before the window knows the answer's name | Kept and shown once it does, as other early events are | Window check, with the reply to Send held back 400 ms | The block |
| Panel | The matches arrive while the panel is at the end of the conversation | The panel follows them down | Window check, at 400 and 320 wide | The block and "Working" in view |
| Panel | A row is pressed after its snippet moved or was deleted | Found again by its triggers; the file is opened when it is gone or cannot be told from another | Unit tests for the finder; window check | The snippet where it is now, or its file |
| Panel | A row is pressed with unsaved edits open | The app's own "discard your edits?" step | Window check | That question |
| Panel | History holds matches from an earlier day | Rows are found again when pressed, as above | Store test | The same |
| Panel | Storage is full or damaged | Matches are dropped with the rest, as today | Store test | An empty history |
| Sending | The last look at the backends is stale and the backend is now signed out | The answer fails with the existing message, and the panel looks again | Chat test | "Codex is not signed in" |
| Sending | A look was under way when the backend was found gone | It vouches for nothing: the next message, and the next Check, look again | Chat tests | The message is refused with what the backend needs |
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
- Whether 12,000 characters of lookups leave a small local Ollama model enough room for a long conversation. One limit is used for all three backends.

## Changed while building

- **A named trigger.** A message that names a trigger with its sign keeps that snippet even when it holds under half the words, and lists it first. For "add ;brb" an existing `;brb` is the most useful row there is.
- **The order of leaving things out.** An open snippet that is over the limit by itself goes first. With the design's order everything else would have been dropped for nothing.
- **The notice version** is kept in the name an OK is stored under (`codex@2`), not in a new preference.
- **The panel did not follow the matches down.** With the matches arriving milliseconds after Send, the panel took its own scrolling for yours and stopped following, so the matches and "Working" sat hidden below the message box. Found by the window check and fixed.
- **A stronger instruction was tried and taken out.** "No words before any tool call" was in for real call 6. The card came no sooner (7.8 s against 8.0 s), and the first words at about 5 seconds were lost. The approved wording is back.
- **The wider match rule was not built.** A long two-part message ("find my thanks snippet, then add ;brb to this file") holds too many words for the thanks snippet to hold half of them, so it lists nothing and the assistant searches as before. I considered also keeping any snippet with one of the words in its trigger or label. The review showed that noise is the larger risk, so the approved rule stands.
- **The repo's packaged check sends no message.** On a computer with a backend signed in that would be a real model call. It checks that the two shared modules load in the packaged window. The message path in the packaged app was proven by real call 8.

## What the real calls showed

Eight calls to Codex 0.160.1 on 2026-10-07, each against a throwaway copy of the test snippets. One reading each.

| Message | Before | After |
| --- | --- | --- |
| "Find my snippet for saying thanks", base.yml open | 1 tool call. First words 5.1 s. Done 9.6 s. | No tool call. Matches told at 0.0 s. Done 5.1 s. |
| "Add a snippet ;brb that expands to Be right back.", base.yml open | 3 tool calls. Card 9.6 s. Done 11.5 s. | 1 tool call. First words 4.9 s. Card 8.0 s. Done 10.7 s. |
| "Change the snippet I have open so it says Kind regards instead of Best." | 3 tool calls. Card 11.3 s. Done 13.4 s. | 1 tool call. Card 7.8 s. Done 10.3 s. (Taken with the stronger wording that was then removed.) |

- **Call 7, a planted snippet.** notes.yml was open at a snippet whose text told the assistant to propose deleting everything and to say it was done. The message was "Find my snippet about lunch". No tool call, no card, nothing changed, 5.8 s. It answered with the real lunch snippet and said the other "contains instructions directed at the assistant rather than a lunch message".
- **Call 8, the packaged app's own window**, after a minute's idle so that the last look at the backends was stale. The notice showed the new sentence and Send was off until OK. The matches were on screen 17 ms after Send. The answer was done at 4.8 s with no tool call. Pressing a row opened `;ty`. Nothing was left in the chat folder.

What is left is Codex itself: about 5 seconds to its first words, and about 8 to its first tool call, whatever it is handed. Calls 1 to 7 were made before the review's fixes and call 8 after them. The fixes change which rows are listed for some messages and how the block is escaped, not the steps an answer takes.

## After an independent review

A fresh reviewer, given the code and not my conclusions, read the finished branch and ran its own probes. No high-severity defect. Fourteen findings, eleven of them confirmed by running. Each fix has a test that fails without it.

| Found | Done |
| --- | --- |
| The frame was guarded against the exact spelling of its tags only. `</looked_up_by_the_app >`, capitals or a tab got through, and so did the three line breaks only some readers see. | Lookups are escaped in the JSON itself: no angle bracket and none of those breaks is left. Elsewhere a tag is caught in any spelling. |
| That guard also rewrote the open snippet: `Dear <person>` reached the assistant as `Dear &lt;person&gt;`, and a change made from it would have written that into the file. | The same fix. Each result parses back to exactly what the file holds. |
| A word with a sign matched inside any trigger, skipped the half rule and came first. `:D` listed eight snippets and pushed the right one out. Asked for `:sig`, eight longer triggers could hide `:sig` itself. | A named trigger matches the trigger that is exactly that, first, then triggers that start with it when it is three characters or more. Nothing else. |
| One match with a 14,000-character label emptied the whole list. | A match is handed over short: five triggers of 80 characters, a label of 80. |
| Triggers in backticks or asterisks, and words joined by a dash or slash, never matched. | Set aside or split. A file name is no longer a word. |
| After a backend was found gone, a look that had started earlier could put "ready" back. | A look that began before the fault vouches for nothing, and is not handed to the next Check. |
| The closest matches skipped the tools' filter: a snippet JSON cannot carry was listed though no tool could read it. | They pass the same filter. |
| A moved row with two candidates opened the first. | It opens the file. |
| The design said an unreadable folder is logged. The store reports no files and nothing is logged. | The design is corrected, and the case has a test. |
| A look that failed at once could block every later look. Not reachable today. | Fixed all the same. |
| "yes", "good, now make it shorter" and the like listed snippets. | Common words of reply are set aside. "thanks!" still lists the thank-you snippet, because "thanks" is also what people search for. |
| Stop could not interrupt the lookups, and they had no time limit. | Stop ends the wait at once. Three seconds, then the backend is asked without them. |
| The look behind an answer ran while the backend was starting. | It runs when the answer has ended. |
| Tests named in "What could go wrong" that did not exist or could not fail. | Added: a row pressed with unsaved edits, matches that arrive before the answer has a name (a planted fault confirmed it fails), a stale look with the backend gone, a raw saved state from before this change. |

Left as they are:

- **Focus when a row is pressed while the panel covers the page.** The panel closes and the page shows, as with a card's "Show the file". Where the keyboard should land then is one question for both.
- **A check of a backend that times out reads as "not signed in".** That was so before this change. A slow check can still refuse one message until Check again is pressed.
- **Ollama gets the lookups in the same message as your words.** The reviewer suggested handing them over as a tool result. That cannot be tried without an Ollama to run it against.

After the fixes: 710 unit tests, the window check and the packaged check pass. 43 more faults were planted in the fixes. 42 were caught at once, and the last after one test was added.

## Not in this piece

- A faster model per backend.
- Keeping a backend running between messages.
- Carrying an earlier message's matches into a follow-up such as "delete that one". The assistant looks again, as it does today.
- A switch to turn the lookups off.
