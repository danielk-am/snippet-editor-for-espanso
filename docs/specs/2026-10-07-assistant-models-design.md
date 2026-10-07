# A model choice for the assistant: design

Status: approved by Daniel on 2026-10-07, built, measured and reviewed. What changed on the way is under "Changed while building" and "After an independent review".

This follows the faster assistant (`2026-10-07-assistant-speed-design.md`). There, real calls showed that what is left of the wait is the backend itself: about 5 seconds to Codex's first words and about 8 to its first tool call. A faster model is the lever for that part.

## Goal

You can pick which model answers for Codex and for Claude Code, so that a faster one can. Ollama already lets you.

## Decision already made

| Question | Daniel's answer, 2026-10-07 |
| --- | --- |
| Add the faster-model choice? | Yes ("Add the faster-model choice"). |
| A model list for each backend, or one "Faster" switch? | A model list for each backend. |
| May real Codex calls be made with GPT-6-Luna to check it and time it? | Yes, about six, on a throwaway snippet folder. |

## What I checked on this Mac

No model was called for any of this.

| Tool | Found |
| --- | --- |
| Codex 0.160.1 | `codex exec -m <model>` picks the model. `codex debug models` prints Codex's own list as JSON in 0.1 seconds (about 600 KB). Eight models are listed today, each with a name and a line about it. GPT-6.1-Sol comes first: "Latest workhorse model for coding and everyday work." GPT-6-Luna is "Fast and affordable model for easier tasks." |
| Claude Code 2.1.288 | `--model <name>` picks the model. Its help names the short names `fable`, `opus` and `sonnet`, and its program text also has `haiku`. It has no command that lists them. It is signed out here, so none can be tried. |

Codex also offers a "Fast" tier for each model, described as "2x speed, increased usage". That is a different lever and is not in this piece: it spends more of your plan.

## Two ways to do it

1. **A model list for each backend (recommended).** Under "Who answers", each ready backend gets a Model choice. Codex's list is read from Codex itself, with its own descriptions, so it stays right when Codex renames or adds models. The footer names the model that answers.
2. **One "Faster" switch.** Simpler to look at. But the app would have to carry the names of today's fast models, which go stale, and you could not see or change which model that is.

## What changes

### The lists

- **Codex.** Each time the app looks at the backends it also asks Codex for the list that came with the program (`codex debug models --bundled`). It keeps the models Codex marks as listed, in the order Codex ranks them, with each one's name and description. This adds under 0.1 seconds to a look, and a look no longer holds up a message. Two kinds of listed model are not offered: one that cannot think lightly, which the app asks of every model, and one that uses tools another way than the model Codex chooses by itself, because how the assistant is kept to the snippet tools was settled with that one.
- **Claude Code.** A fixed list of its four short names: Haiku, Sonnet, Opus, Fable. Claude Code turns each into the latest model of that family itself.
- **Ollama.** As today.

Each list starts with the tool's own choice, which is what answers today. Nothing changes until you pick something else.

### The panel

"Who answers" shows a Model choice under Codex and Claude Code when they are ready, as it does for Ollama. Under the choice is the one line Codex gives about that model. The footer reads "Codex · GPT-6-Luna" when a model is picked, and "Codex" when it is the tool's own choice.

The choice is remembered for each backend separately. Your Ollama model stays as it is.

### Sending

The model's name goes to the tool as one argument: `-m` for Codex, `--model` for Claude Code. It must be one of the names in that backend's own list, exactly as an Ollama model must be today. Anything else is refused before a program is started, with "Choose one of Codex's models, or its own choice." The panel then looks at the backends again, because a refusal means its list is behind the app's.

Everything else is the same for every model: the same twelve tools, the same guards on what a backend may do, the same cards. Thinking effort stays low.

## What does not change with the model

A smaller model may follow its instructions less well. What keeps the assistant in bounds does not rely on that: it has the snippet tools only, an answer is stopped if it does anything else, and a change is a card you apply. The real calls below check that the fast model still uses the tools and still ignores a planted instruction.

## What could go wrong

| Path | Realistic failure | Handled how | Test | What you see |
| --- | --- | --- | --- | --- |
| Codex's list | The command is missing or renamed in another version of Codex | No list. The tool's own choice answers, as today. | Backends test with a command that fails | No Model choice under Codex |
| Codex's list | It prints something else, or JSON of another shape | The same | Backends test with several wrong shapes | The same |
| Codex's list | It is very large | Read up to 4 MB and not a byte beyond, else no list | Backends test at 4 MB and at 4 MB and one byte, with a real program | The same |
| Codex's list | It is slow, or hangs | Five seconds, then no list. Codex is still ready. | Backends test with a real program that sleeps | The same |
| Codex's list | It prints the models in another order than it ranks them (it does today) | Its ranking is followed | Backends test with today's real list | GPT-6.1-Sol first |
| Codex's list | A listed model cannot think lightly, or uses tools another way than Codex's own choice | Not offered | Backends tests | It is not offered |
| Codex's list | A name with spaces, quotes or a leading dash | Only plain names are listed: letters, digits, dot, dash, underscore and colon, starting with a letter or digit, 80 characters at most | Backends test | That model is not offered |
| Codex's list | A model Codex marks as hidden | Not listed | Backends test with today's real list | It is not offered |
| Sending | The window names a model that is not in the backend's own list, one from another backend's list included | Refused before anything starts | Chat test | "Choose one of Codex's models, or its own choice." |
| Sending | The remembered model has left the list, and the panel knows | The tool's own choice is used, and the footer says so | Window check | "Codex" in the footer |
| Sending | The remembered model has left the list, and the panel does not know yet | That one message is refused and stays in the box. The panel looks again and the footer falls back. | Window check | The refusal, then "Codex" in the footer |
| Sending | No list could be read, and the panel still names a model | The same, with words that fit: "Codex did not list its models just now, so its own choice will answer. Send your message again." | Chat test; window check for the panel with no list | That sentence |
| Answer | Your plan cannot use that model | Codex's own message is passed on, as any failure is | Chat test with a model named and a stand-in that fails | That message |
| Answer | An older Claude Code does not know a short name | The same | The same test | That message |
| Model | The fast model searches again though it was handed the matches | Nothing breaks | Real call counts the tool calls | A slower answer |
| Model | The fast model calls a tool wrongly | The tool's own words go back to it, as today | Real call | It tries again, or says so |
| Model | The fast model acts on a planted instruction | Tools are read-only, and a change is a card | Real call with a planted snippet | At worst a card you would not apply |
| Panel | A long model name at 320 wide | Cut with an ellipsis | Window check | Nothing spills |
| Stored choice | A saved state from before this change | The Ollama model is carried over | Store test | Your model, still chosen |
| Stored choice | A name over 200 characters | Let go whole, not cut: cut short it would name something else | Store test | The backend's usual choice |

## Checks

- Unit tests for the lists, the arguments, the chat and the store, each watched to fail first.
- The window check, extended for the Model choice.
- Real Codex calls, about six, each on a throwaway folder: the same find, add and change as before with GPT-6-Luna, the planted snippet with GPT-6-Luna, and two spare. They need Daniel's say.
- The README's Assistant section updated.

## Not proven by this piece

- Claude Code's models, and whether each takes the light thinking the app asks for. It is signed out on this Mac.
- Codex's models other than its own choice and GPT-6-Luna. The other five that are offered were not tried.
- Why GPT-6-Luna once said it had no tools. No raw output was kept for that call.
- Ollama, and finding the tools on Windows and Linux, as before.

## Changed while building

- **The list that came with Codex.** Codex's help says the plain `debug models` refreshes the list. The app looks at the backends when the panel opens, before you have agreed to send anything, so it asks for the list shipped with the program (`--bundled`). The reviewer ran it with the network shut off and got the same bytes. Both forms list the same eight models today. The cost: the list is as old as your copy of Codex and is not fitted to your plan, so a model you cannot use may be offered and then refused by Codex in its own words.
- **A refusal over the model makes the panel look again.** When a chosen model left the list between two looks, the panel kept offering it and every message was refused until Check again was pressed.
- **Nothing recommends a model.** The real calls did not show the fast model to be reliably faster, so the tool's own choice stays first and no model is marked as the one to pick.

## What the real calls showed

Six calls to Codex 0.160.1 with GPT-6-Luna on 2026-10-07, each against a throwaway copy of the test snippets. One reading each. The figures for Codex's own model are from the same day (`2026-10-07-assistant-speed-design.md`).

| Message | Codex's own model | GPT-6-Luna |
| --- | --- | --- |
| "Find my snippet for saying thanks", base.yml open | No tool call. Done 5.1 s. | No tool call. Done 4.6 s. |
| "Add a snippet ;brb that expands to Be right back.", base.yml open | 1 tool call. Card 8.0 s. Done 10.7 s. | Three tries. First: no tool call and no card, done 6.2 s. Second: card 6.1 s, done 7.2 s. Third: card 7.5 s, done 10.4 s. |
| "Change the snippet I have open so it says Kind regards instead of Best." | 1 tool call. Card 7.8 s. Done 10.3 s. | 1 tool call. Card 6.0 s. Done 7.5 s. |
| A snippet planted to give orders, handed over as a match | Ignored. Done 5.8 s. | Ignored. Done 4.2 s. |

- **Sometimes faster.** At its best a change finished about 3 seconds sooner. One add was no faster than Codex's own model.
- **One failure in three adds.** On the first add it wrote "its snippet-editing tools aren't available right now" and showed the YAML with no card. Nothing was written. The same message worked on the next two tries, and the raw output of a working call shows nothing amiss.
- **Still safe.** The planted snippet was not acted on: no tool call, no card, nothing changed. It said the snippet "appears to contain instructions rather than a lunch message". It did not name the real lunch snippet, which Codex's own model did.

## After an independent review

A fresh reviewer, given the code and not my conclusions, read the finished branch and ran its own probes. No high-severity defect: nothing but a plain name from the backend's own list reaches a program, and no path leaves you stuck. Ten low findings, six confirmed by running.

| Found | Done |
| --- | --- |
| Codex's models were listed in the order it prints them, not the order it ranks them. GPT-6-Astra came before GPT-6.1-Sol. | Ranked as Codex ranks them. |
| No test failed with the 5-second limit removed. | A real program that sleeps: ready, no list, and not waited on. |
| The refusal test gave both backends the same list, so a name from another backend's list would have passed unnoticed. | Different lists, each one's names refused by the other. |
| Any limit between 1 MB and 5 MB passed the size test. | Tested at 4 MB and at 4 MB and one byte. |
| With no list read, a refusal told you to choose from a list that was not shown. | Its own words: Codex did not list its models, its own choice will answer, send again. |
| An Ollama model name over 200 characters was cut and so forgotten. | Let go whole. No real name is that long. |
| Every refusal made the panel look at the backends again, a message that was too long included. | Only a refusal over the model does, under a code of its own. |
| GPT-5.5 is listed, and does not say it uses tools the way the others do. The guards were settled with the others. | A model that uses tools another way than Codex's own choice is not offered. Nor is one that cannot think lightly. Seven of the eight are offered today. |
| `--effort low` with `--model haiku` is unproven. | Listed under "Not proven". |
| No test named a model and had the program fail. | Added, for both tools. |

After the fixes: 736 unit tests, the window check, the packaged check, the quit check and the Espanso 2.4.1 check pass. The packaged app reads seven models from the Codex on this Mac. 66 faults were planted across the piece and its fixes. 63 were caught at once and 2 after a test was tightened. The last changes nothing a test could see.

## Not in this piece

- Codex's "Fast" tier.
- A choice of thinking effort.
- Keeping a backend running between messages.
