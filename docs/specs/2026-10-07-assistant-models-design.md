# A model choice for the assistant: design

Status: waiting for Daniel's approval.

This follows the faster assistant (`2026-10-07-assistant-speed-design.md`). There, real calls showed that what is left of the wait is the backend itself: about 5 seconds to Codex's first words and about 8 to its first tool call. A faster model is the lever for that part.

## Goal

You can pick which model answers for Codex and for Claude Code, so that a faster one can. Ollama already lets you.

## Decision already made

| Question | Daniel's answer, 2026-10-07 |
| --- | --- |
| Add the faster-model choice? | Yes ("Add the faster-model choice"). |

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

- **Codex.** Each time the app looks at the backends it also asks Codex for its list. It keeps the models Codex marks as listed, in Codex's order, with each one's name and description. This adds about 0.1 seconds to a look, and a look no longer holds up a message.
- **Claude Code.** A fixed list of its four short names: Haiku, Sonnet, Opus, Fable. Claude Code turns each into the latest model of that family itself.
- **Ollama.** As today.

Each list starts with the tool's own choice, which is what answers today. Nothing changes until you pick something else.

### The panel

"Who answers" shows a Model choice under Codex and Claude Code when they are ready, as it does for Ollama. Under the choice is the one line Codex gives about that model. The footer reads "Codex · GPT-6-Luna" when a model is picked, and "Codex" when it is the tool's own choice.

The choice is remembered for each backend separately. Your Ollama model stays as it is.

### Sending

The model's name goes to the tool as one argument: `-m` for Codex, `--model` for Claude Code. It must be one of the names in that backend's list, exactly as an Ollama model must be today. Anything else is refused before a program is started.

Everything else is the same for every model: the same twelve tools, the same guards on what a backend may do, the same cards. Thinking effort stays low.

## What does not change with the model

A smaller model may follow its instructions less well. What keeps the assistant in bounds does not rely on that: it has the snippet tools only, an answer is stopped if it does anything else, and a change is a card you apply. The real calls below check that the fast model still uses the tools and still ignores a planted instruction.

## What could go wrong

| Path | Realistic failure | Handled how | Test | What you see |
| --- | --- | --- | --- | --- |
| Codex's list | The command is missing or renamed in another version of Codex | No list. The tool's own choice answers, as today. | Backends test with a command that fails | No Model choice under Codex |
| Codex's list | It prints something else, or JSON of another shape | The same | Backends test with several wrong shapes | The same |
| Codex's list | It is very large, or slow | Read up to 4 MB, within 5 seconds, else no list | Backends test | The same |
| Codex's list | A name with spaces, quotes or a leading dash | Only plain names are listed: letters, digits, dot, dash, underscore and colon, starting with a letter or digit, 80 characters at most | Backends test | That model is not offered |
| Codex's list | A model Codex marks as hidden | Not listed | Backends test with today's real list | It is not offered |
| Sending | The window names a model that is not in the list | Refused before anything starts | Chat test | "Choose one of Codex's models" |
| Sending | The remembered model is no longer in the list | The tool's own choice is used, and the footer says so | Window check | "Codex" in the footer |
| Sending | No list could be read, and a model is remembered | No model is passed | Chat test | The tool's own choice answers |
| Answer | Your plan cannot use that model | Codex's own message is passed on, as any failure is | Chat test with a stand-in | That message |
| Answer | An older Claude Code does not know a short name | The same | Chat test with a stand-in | That message |
| Model | The fast model searches again though it was handed the matches | Nothing breaks | Real call counts the tool calls | A slower answer |
| Model | The fast model calls a tool wrongly | The tool's own words go back to it, as today | Real call | It tries again, or says so |
| Model | The fast model acts on a planted instruction | Tools are read-only, and a change is a card | Real call with a planted snippet | At worst a card you would not apply |
| Panel | A long model name at 320 wide | Cut with an ellipsis | Window check | Nothing spills |
| Stored choice | A saved state from before this change | The Ollama model is carried over | Store test | Your model, still chosen |

## Checks

- Unit tests for the lists, the arguments, the chat and the store, each watched to fail first.
- The window check, extended for the Model choice.
- Real Codex calls, about six, each on a throwaway folder: the same find, add and change as before with GPT-6-Luna, the planted snippet with GPT-6-Luna, and two spare. They need Daniel's say.
- The README's Assistant section updated.

## Not proven by this piece

- Claude Code's models. It is signed out on this Mac.
- Ollama, and finding the tools on Windows and Linux, as before.

## Not in this piece

- Codex's "Fast" tier.
- A choice of thinking effort.
- Keeping a backend running between messages.
