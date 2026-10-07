# Snippet Editor for Espanso

A desktop app for browsing, searching and editing your [Espanso](https://espanso.org) snippets without hand-writing YAML. It is an Electron app with no build step: there is no bundler and no compile, so the files you read are the files that run.

## Run it

You need Node 22 or newer.

```bash
npm install
```

```bash
npm start
```

To try every feature on a throwaway copy of sample files, without touching your real Espanso folder:

```bash
npm run demo
```

## Package it

Packaging needs no compile step either. It wraps the same source files with Electron for each system. All of it can be built from one Mac, Apple Silicon included.

```bash
npm run dist
```

That builds everything into `dist/`. To build for one system, use `npm run dist:mac`, `npm run dist:win` or `npm run dist:linux`.

| System | What you get |
| --- | --- |
| macOS | A `.dmg` and a `.zip`, each for Apple Silicon (`arm64`) and Intel (`x64`) |
| Windows | An installer (`.exe`) and a portable `.zip`, 64-bit |
| Linux | An `.AppImage` and a `.tar.gz`, 64-bit |

To check a package on the computer you built it on:

```bash
npm run test:packaged
```

It starts the packaged app against a throwaway copy of the sample files, asks the running window what it shows, saves one snippet, and checks the file and its backup.

What to expect when you hand a package to someone:

- **macOS:** the app is signed ad hoc and not notarised, because that needs a paid Apple Developer ID. On another Mac, the first launch needs a right-click and Open, or approval under System Settings, Privacy & Security.
- **Windows:** the installer is not code-signed, so SmartScreen shows a warning before it runs.
- **Linux:** make the AppImage executable (`chmod +x`), then run it.

How far each package has been checked: the Apple Silicon app is built, run and tested on a Mac. The Intel Mac, Windows and Linux packages are built and inspected (right file type, same app files inside, correct name and version) but have not been run, because that needs those systems.

The icon is `build/icon.png`. `npm run icon` redraws it from the mark in the sidebar. Replace that file to use your own.

## What it does

- **Sources.** The sidebar lists your match files and any installed Espanso packages, each with a snippet count. A file with YAML errors is marked, because Espanso skips it.
- **Snippet editor.** Single, multiple or regex triggers. Plain text, Markdown, HTML, form and image content. All nine Espanso variable types. Word, capitalisation and insert-method options. A live preview shows the YAML that will be written.
- **Other keys.** Espanso options the form does not cover, such as `left_word` or `apps`, are kept as they are and can be edited as YAML beside the form.
- **Raw YAML.** Every file has a raw editor for comments, `imports` and `global_vars`. It refuses to save YAML that does not parse.
- **Search.** Press Cmd+K (Ctrl+K on Windows and Linux) to search triggers, labels, search terms and expansion text across every file and package.
- **File details.** A description and an optional trigger prefix per file. New snippets in a file start with its prefix.
- **Packages are read-only.** Copy a package snippet into one of your own files to change it.
- **Light, dark or system theme.**
- **API for other tools.** Scripts on the same computer can read and change snippets over HTTP. It is off until you switch it on. See "API for other tools" below.
- **Team snippets.** Connect a GitHub repository of shared packages, install the ones you want, and propose your own files back as a pull request. See "Team snippets" below.
- **AI tools.** An MCP server comes with the app, so an AI tool such as Claude or Codex can search and read your snippets, and change them once you allow it. See "AI tools (MCP)" below.
- **Assistant.** A chat panel beside your snippets. It finds, explains and drafts, and every change it suggests is a card you apply yourself. See "Assistant" below.

## API for other tools

Everything the window does with snippets goes through one set of routes. Other tools on the same computer can use those routes over HTTP.

The HTTP side is off until you switch it on in Settings, under "API for other tools". Settings then shows the address and gives you two buttons: one copies the token, one copies a ready `curl` command.

```bash
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:27187/api/v1/state
```

| Method | Path under `/api/v1` | Does |
| --- | --- | --- |
| GET | `/state` | Match folder, files with their snippets, packages |
| GET | `/files/{id}` | One file, with its raw text and version |
| POST | `/files` | Create a file: `name`, optional `description` and `prefix` |
| PUT | `/files/{id}/details` | Change `description` and `prefix` |
| PUT | `/files/{id}/raw` | Replace the raw YAML: `text` |
| DELETE | `/files/{id}?version=` | Delete a file, keeping a backup |
| POST | `/files/{id}/snippets` | Add a snippet: `match`, optional `index` |
| PUT | `/files/{id}/snippets/{index}` | Change a snippet: `match` |
| DELETE | `/files/{id}/snippets/{index}?version=` | Remove a snippet |
| GET | `/search?q=` | Search every file and package |
| POST | `/yaml/preview`, `/yaml/parse`, `/yaml/stringify` | YAML helpers |

A file `{id}` is the `id` from `/state`, such as `local:base.yml`, percent-encoded. Every write needs the `version` you last read for that file. If the file has changed since, the write is refused with `409` and you read it again. That is what stops a script and the window from overwriting each other.

Errors always have the same shape: `{ "error": { "code": "CONFLICT", "message": "…" } }`.

Limits: a request body can be up to 4 MB, a match file up to 2 MB, and the YAML helpers take up to 256 KB of text. Over a limit, the answer is `413`. YAML can hold two things JSON cannot: a number that is not finite, and a list or mapping that contains itself. A file that holds one is listed without its snippets and says why, and its text can still be read. Any other reply that would include one is refused with `422` and the code `UNREPRESENTABLE`. Either way, a script is never handed data that differs from the file.

How it is guarded:

- It listens on `127.0.0.1` only, so other computers cannot reach it.
- Every route that reads or changes anything needs the token. It is kept in `api-token` in the app's data folder, readable only by you. Replace it in Settings at any time.
- One route needs no token: `GET /api/v1/proof?nonce=...`. A caller sends a number of its own and gets back a digest that only the holder of the token can make. So a tool can check it is talking to this app before it sends the token. Another program can take the app's port while the app is closed.
- Any program running under your account can read that file. The token keeps out other people and web pages, not software you choose to run.
- Requests from web pages are refused, so a site open in your browser cannot use it.
- The window does not use the HTTP side at all. It takes the same routes over the app's internal channel, so the token never enters the page.

## Team snippets

A team can keep its shared snippets in one GitHub repository. Connect it in Settings with its address, such as `acme/team-snippets` or `git@github.com:acme/team-snippets.git`. The app uses the `git` on your computer and the sign-in git already has. It saves no password or token.

The repository holds one folder per package:

```
packages/
  goodbyes/
    _manifest.yml     name, title, description, version, author
    package.yml       one or more match files
```

- **Install.** The Team packages page lists every package. Installing one copies it to `match/team/<name>/`, where Espanso loads it. Installed team files are read-only in the app. You can copy a snippet into one of your own files to change it.
- **Update.** The app checks the repository when it starts and when you press "Check for updates", and marks the packages that changed. Nothing is updated until you press Update.
- **Runs commands.** An Espanso snippet can run a shell command or a script when you use it. A package that holds one is marked "Runs commands", and installing or updating it asks first. A package with a file the app cannot read is marked the same way, because it could not be checked.
- **Propose.** "Propose to team", on one of your own files, pushes that file to a new branch named `snippet-editor/<package>-<date>-<time>`. The app then offers GitHub's page for opening a pull request from that branch. It never pushes to the main branch.

What the app does with git: it keeps a bare copy of the repository in its data folder and reads packages straight from the commit, so a symbolic link or a submodule in the repository is skipped, not followed. A proposal is built inside git too. No file from the repository is ever checked out on your computer. Git is run without a shell, with a time limit, and can never stop to ask for a password. If git would have asked, the app says so and you check your access in a terminal.

Over the API, team snippets are under `/api/v1/team`:

| Method | Path | Does |
| --- | --- | --- |
| GET | `/team` | The repository, its packages, and which are installed or have updates |
| POST | `/team/refresh` | Fetch, then the same reply |
| PUT | `/team/packages/{name}/installed` | Install or update; `acceptCommands: true` for a package that runs commands |
| DELETE | `/team/packages/{name}/installed` | Remove the installed copy |
| POST | `/team/proposals` | Push a proposal branch: `fileId`, `package`, `summary`, and `title` and `description` for a new package |

Connecting and disconnecting a repository are done in the window only. Installed team files are read through the ordinary routes, with ids such as `team:goodbyes:package.yml`.

Team packages go in `match/team/`, not in Espanso's own `match/packages/`. Checked with Espanso 2.4.1: it loads `match/team/` like any other match files, and a folder in `match/packages/` without Espanso's own source file makes `espanso package list` fail for every package.

## AI tools (MCP)

The app comes with an MCP server: a small program an AI tool starts, which lets it work with your snippets. It holds no snippets of its own. Every tool call goes to the app's local API, so the app must be open with "API for other tools" switched on.

To connect an AI tool, open Settings, go to "AI tools" and press "Copy setup". Paste the block into the AI tool's MCP settings. The block comes as JSON, for Claude and most tools, or as TOML, for Codex. It names the app's own program and the server file, so you do not need Node installed. It holds no password or token: the server reads the API token from the app's data folder itself.

From a source checkout, the server also runs with:

```bash
npm run mcp
```

Reading and searching work from the start. The tools that change something are refused until you switch on "Let AI tools change snippets" in Settings. The switch takes effect at once.

| Tool | Does | Needs the switch |
| --- | --- | --- |
| `snippets_search` | Finds snippets across every file, package and team package | No |
| `snippets_list_files` | Lists files with their source, counts and problems | No |
| `snippets_get_file` | One file in brief, in full, or as raw YAML, with its version | No |
| `snippets_get_snippet` | One snippet in full, with its file's version | No |
| `snippets_list_team_packages` | The team repository and what it offers | No |
| `snippets_add_snippet`, `snippets_update_snippet`, `snippets_delete_snippet` | Add, change or remove one snippet | Yes |
| `snippets_create_file` | Create a match file | Yes |
| `snippets_replace_file_yaml` | Replace a file's raw YAML | Yes |
| `snippets_install_team_package` | Install or update a team package | Yes |
| `snippets_propose_to_team` | Send one of your files to the team repository as a proposal branch | Yes |

- Every change needs the version of the file the AI tool last read. If the file changed since, the change is refused and the tool is told to read it again. So an AI tool cannot overwrite something it has not seen.
- A snippet can run a command on your computer when it is used. An AI tool can write one only by saying, in the call itself, that you agreed. Your AI tool shows you that call to approve, so read it.
- A reply is at most 25,000 characters. Long lists come in pages, and long YAML comes in parts. The version a change needs comes only with the last part, so a file cannot be replaced by a piece of itself.
- The server talks to the app on this computer directly. It ignores any proxy set in the environment, and it asks the app to prove itself before sending the token.
- Deleting a file, removing a team package, connecting a repository and everything in Settings stay in the window.
- The switch governs this MCP server. Another program on your computer that holds the API token can still change snippets through the API.

The server speaks both forms of MCP in use today: the older one that opens with a handshake (versions `2024-11-05` to `2025-11-25`) and the one from `2026-07-28` that sends its version with every request. It is written by hand, in three files under `mcp/`, with no dependency.

How well an AI tool can use the tools was checked: ten questions with one right answer each, given to a fresh agent with nothing but these tools. It answered 10 of 10. The questions and the result are in `test/mcp-eval/`.

## Assistant

Press Cmd+J (Ctrl+J on Windows and Linux), or the speech-bubble button at the top right, to open a chat panel beside your snippets. Ask in plain words: find a snippet, explain one, draft a new one, tidy the one you have open. The panel is told which file and snippet you have open.

**The closest matches show at once.** When you send a message, the app searches your snippets for its words before any AI is asked, and lists up to eight under "Closest matches" at the top of the answer. In the packaged app they were on screen 17 milliseconds after Send. Press a row to open that snippet. If the file has changed since, the row opens the snippet where it is now, or its file if the snippet is gone. This search is made for sentences: it sets aside words like "find", "my" and "yes", reads a word that starts with a sign (`;brb`) as the name of a trigger, and keeps a snippet that holds at least half of the rest or whose trigger you named. A long message that asks for two things at once may list nothing. The assistant then searches for itself, as it did before.

The same matches go to the assistant with your message, together with the snippet you have open and a summary of the file you have open. So a find needs no further step from it, and a change to what is open needs one.

**It changes nothing by itself.** When it wants to add, change or delete something, you get a card. Every line the change would add or remove is on that card, in a box that scrolls when there are many. Nothing is written until you press Apply, and Apply also needs "Let AI tools change snippets" switched on in Settings. If the file changed after the card was made, the app checks that the card still means the same thing. If it does not, nothing is written and the card tells you to ask again.

It answers through one of three tools on your own computer. The app holds no key and never signs in for you.

| Backend | What it needs | Where your text goes |
| --- | --- | --- |
| Claude Code | Installed, version 2.1.259 or newer, and signed in (`claude auth login`) | To Anthropic, under your own sign-in |
| Codex | Installed and signed in (`codex login`). The copy inside the ChatGPT app works. | To OpenAI, under your own sign-in |
| Ollama | Running on this computer, with a model that can use tools | Nowhere with a local model. To Ollama with a cloud model. |

"Your text" is your messages, the snippets that match them, what you have open, and the snippets the assistant reads. The matches and what you have open go with every message, whether or not the answer turns out to need them.

"Who answers", in the panel's footer and its menu, shows which of the three are ready and the one step each still needs. The assistant does not need "API for other tools" switched on.

How it is kept in bounds:

- **Only the snippet tools.** Each message starts the backend fresh. Claude Code is started with its own tools off. Its first line of output lists the tools it has. Nothing it writes is taken before that line, and if the list holds anything but the app's twelve tools, the answer is stopped before it begins. Codex is started with its shell, web search, sub-agents and image tools off, in a read-only sandbox. With either, the answer is stopped the moment it is seen to do anything the app does not know to be harmless: a command, a changed file, a web search, a tool that is not one of the twelve, or a kind of step the app has not seen before.
- **The assistant's own tools cannot write.** In chat they only read, and a change is handed over as a proposal. Should one ever try to write, it is refused before it reaches the app's routes.
- **A listener that cannot write.** Claude Code and Codex reach your snippets through a listener on this computer that exists only while an answer is under way, with a token made for that answer. It can read, and it can hand over a proposal. It has no route that changes anything.
- **Other people's text stays text.** Packages and team packages hold snippets someone else wrote. The assistant is told that what a snippet says is data, not a request, and a file name, a trigger or the text of a match cannot pass itself off as part of your message: in what the app looks up, every angle bracket is written as an escape, so no tag in any spelling survives, and the text still reads back exactly as the file holds it. A match from someone else's package reaches the assistant without it asking, so this matters more than it did. Whatever the assistant makes of one, it can still only propose.
- **Who answers is your choice.** The first backend found ready becomes the choice, shown in the footer. If it stops being ready, the panel says so. It does not move on to another by itself. With Ollama, a model that stays on your computer is picked before a cloud one. The first time a backend would send your text away, the panel says what and where, and nothing is sent until you have pressed OK. When a later version sends more than you agreed to, it asks once more.
- **Nothing is left running.** An answer has a time limit, and Stop ends it at once. Quitting the app waits, up to four seconds, for an answer under way to be stopped, with its program and its listener.
- **An answer is shown as text.** Nothing in it is a link, and nothing in it can run as part of the page.
- **Commands carry a warning.** A snippet with a `shell` or `script` variable runs a command each time it is used. A card for one says so above Apply. A whole-file change over 256 KB is not made into a card at all: it is too long to check and too long to read.
- **History stays here.** The last 20 conversations, up to 100 messages each, are kept in the window's own storage. "Clear history" removes them. Nothing is added to Claude Code's or Codex's own history.

What was checked, and what was not:

- **Codex was checked for real**, with Codex 0.160.1: finding a snippet, proposing one and applying it, a snippet that tried to give the assistant orders (it summarised the snippet and proposed nothing), and a request to run a command (it said it could not). The order-giving snippet was tried again as a closest match handed over up front: the assistant answered with the right snippet, said the other held instructions meant for it, and proposed nothing.
- **Speed was measured with Codex**, before and after the app began to look first. One reading each, on one day, so these show the size of the change and are not averages. A find: one tool call and 9.6 seconds before, no tool call and 5.1 seconds after, with the matches listed at once. Adding a snippet to the open file: three tool calls and a card at 9.6 seconds before, one and a card at 8.0 after. Changing the open snippet: three tool calls and a card at 11.3 seconds before, one and a card at 7.8 after. What is left is Codex itself: about 5 seconds to its first words, and about 8 to its first tool call. The same find through the packaged app's own window, after a minute's idle: matches on screen at 17 milliseconds, answer done at 4.8 seconds.
- **Claude Code was checked as far as its tool list.** Started signed out, it lists exactly the twelve snippet tools. A whole answer from Claude Code has not been run: it was signed out on the computer this was built on. How its answers are read is tested against output written from Anthropic's documentation.
- **Ollama has not been run.** It was not installed on that computer. That backend is written from Ollama's API reference and tested against a stand-in.
- **Finding the three tools on Windows and Linux has not been run** on those systems.
- **Your own instruction files may travel.** Codex adds your `AGENTS.md` to each message itself (seen). Claude Code may do the same with your `CLAUDE.md` (not checked). The app cannot switch either off without touching that tool's sign-in, which it never does.

An independent review of the faster assistant found fourteen things and no serious one. Thirteen are fixed, each with a test that fails without the fix. The two that mattered most: text in a lookup could close its frame with a tag spelled slightly differently, and the guard against that also changed the text of the snippet you had open before the assistant saw it. The one left is where the keyboard lands when a row is pressed while the panel covers the page. The design lists them all.

An independent review of the first version of this piece found eleven things, each with a reproduction. All are fixed, and the reproductions were run again. The two that mattered most: a snippet that runs a command could be hidden from a card behind a line break only Espanso reads (see "How it treats your files"), and quitting mid-answer could leave a program and its token file behind.

## How it treats your files

Espanso's match folder is the only store. There is no database, so nothing can drift from what Espanso reads.

- **An edit changes only what you edited.** The app never regenerates a file. It finds the value you changed and splices the new text in at that spot, so every other byte stays as you wrote it: comments, blank lines, indentation, quoting, `imports`, `global_vars` and the other snippets.
- **Each edit is checked before it is saved.** The result is parsed again. The snippet must read back as intended and everything else must read back unchanged. If that cannot be shown, the edit is refused and you are pointed to the raw editor. Nothing is written.
- **Text is read the way Espanso reads it.** An unquoted `02134` or `+6591234567` is shown as those characters, not as a number. `npm run test:espanso` checks this against the Espanso installed on your computer.
- **A save writes only the fields you changed.** A field you did not touch keeps its exact value and type. List entries are saved as typed, including a trailing space in a trigger.
- **Backups.** Before each save or delete, the previous version of the file is copied to the backups folder. The newest 20 copies of each file are kept, separately for each match folder.
- **No overwriting newer changes.** Each write is checked against a fingerprint of the file as the editor opened it, and once more just before the swap. If another program changed the file, the write is refused and you are asked to reload.
- **No half-written files.** Files are replaced atomically. A symlinked match file keeps its link, and the file keeps its permissions.
- **Changes on disk are picked up** while the app is open.
- **Line breaks only Espanso reads.** Espanso ends a line at four characters that most YAML readers, this app's among them, take for ordinary text: a carriage return with no line feed after it, and U+0085, U+2028 and U+2029 (checked against Espanso 2.4.1). Text after one of them on a comment line is a comment to most tools and a live snippet to Espanso. So a file that holds one is shown as a file with a problem, naming the line, and can be mended in the raw editor. The app never writes one: in a snippet's own text they are written as escapes, in a description they become spaces, and anywhere else the save is refused. A team package that holds one counts as a package that may run commands.
- **One bad file never blocks the rest.** A file with YAML errors, a broken alias, the wrong encoding, or one that cannot be read is listed with its problem, and the other files open as usual.
- **Package content is treated as untrusted.** A package file is read only if it really lives under `packages/`, so a link inside a package cannot show a file from elsewhere on your disk. Your own match files may be links.

Known limits:

- Only `.yml` and `.yaml` files directly inside the match folder are listed. Files in subfolders other than `packages/` are not shown, though Espanso still loads them.
- Values the app writes are double-quoted, and multi-line text is written as a `|` block where a block can hold it exactly.
- Removing a snippet leaves the comment lines above it in place. When a whole value is replaced, such as a list whose items were reordered, comments inside that value go with it.
- Files larger than 2 MB, files that are not UTF-8, and write-protected files are listed but cannot be edited here.
- Replacing a file atomically gives it a new identity on disk, so a hard link to it or extended attributes on it are not carried over.
- The raw editor saves a file that mixes LF and CRLF line endings with LF throughout.
- Closing the window with unsaved changes in the editor discards them without a prompt.

## Where things live

The match folder is found in this order:

1. The folder chosen in Settings.
2. `SNIPPET_EDITOR_MATCH_DIR`, pointing straight at a match folder.
3. `ESPANSO_CONFIG_DIR`, with `match` inside it.
4. An existing `~/.espanso` or, on macOS, `~/.config/espanso`.
5. The platform default: `~/Library/Application Support/espanso/match` on macOS, `%APPDATA%\espanso\match` on Windows, `$XDG_CONFIG_HOME/espanso/match` on Linux.

The app works this out itself instead of running `espanso path`, because that command creates the config folder as a side effect.

Backups and `settings.json` live in the app's own data folder (`~/Library/Application Support/Snippet Editor` on macOS). Settings shows the match folder and its backups folder.

## Project layout

| Path | What it holds |
| --- | --- |
| `electron/` | Main process: window, menu, IPC handlers, and the sandboxed preload bridge. |
| `core/` | Node-only logic with no Electron in it: YAML round-tripping, the file store, the API router and its HTTP listener, the git runner and the team repository, path resolution, settings. |
| `core/chat/` | The assistant behind the window: finding the backends, the lookups made before one is asked, starting Claude Code and Codex and reading their output, the Ollama loop, proposals, and the listener an answer calls back on. |
| `mcp/` | The MCP server: the protocol, the twelve tools and the client for the app's API. It imports nothing from the rest of the app. The assistant uses the same tools, in a mode where a change is handed over as a proposal. |
| `shared/` | Pure modules used by both sides: the snippet and variable models, the two searches (every word, and closest to a sentence), finding a listed match again, the IPC channel list. |
| `renderer/` | The window: plain ES modules, Preact and htm from one vendored file, and two stylesheets. |
| `test/` | Unit tests, fixtures, the end-to-end smoke test and the packaged-app test. |
| `build/`, `electron-builder.yml` | The app icon and the packaging settings. |

The renderer is sandboxed with context isolation. It reaches the main process only through the channels listed in `shared/channels.js`, and a test fails if the preload script and the handlers disagree with that list.

## Tests

```bash
npm test
```

Runs the unit tests with Node's built-in runner. One of them generates 1,500 match files in different styles from a fixed seed, edits each, and checks that no byte outside the edited snippet changed.

```bash
npm run test:espanso
```

Asks the real Espanso program to read files this app has written, in a temporary folder, and checks that it sees each snippet as written. It also installs a team package and checks that Espanso reads it and that Espanso's own package list still works. It needs Espanso installed and skips itself if it is not. It passes with Espanso 2.4.1.

```bash
npm run test:ui
```

Starts the real app off-screen against a temporary copy of the fixtures, drives it end to end, checks what reached the disk, and saves screenshots to `test/.artifacts/`. It also fails on any console error, any control without an accessible name, and any control smaller than 24 pixels. One step drops deliberately malformed files into the folder and checks that every screen still opens. Another switches the API on in Settings and reads the snippets over HTTP, with and without the token. The assistant is driven too, from "none is ready" to an applied card, with a stand-in for Codex that starts the app's real MCP server and calls no model. That includes the closest matches: listed while the answer is under way, at the panel's narrowest, and opened after the file has changed.

## Colours and design

`renderer/styles/tokens.css` starts with a verbatim copy of the danielk.am colour tokens (blue `#2563EB` primary). Below it, an app layer maps those tokens onto the roles shadcn/ui components expect, prefixed `--ui-`. Components read only the `--ui-` roles, so a brand change is made in one place.

The components follow shadcn/ui's design language as plain CSS. shadcn's own components need React and a Tailwind build, which a no-build app cannot use.

The brand file is light-only, so the dark theme's surface values are this app's own.

## Where this version came from

This is a reconstruction of Snippet Manager for Espanso, not a copy of its source. It is named Snippet Editor, with its own app id and data folder, so the original can be installed beside it without the two sharing anything. The original repository (`snippet-manager-for-espanso`, v1.26.0) could not be reached when this was built, and no local clone was available. It was rebuilt from three records of the original:

- the port manifest in `snippet-manager-wp`, which documents the data model, the editor's known keys and the file-safety rules;
- the UI census in `dk1-blocks-wordpress-ui/docs/PORT-CENSUS-APPS.md`, which describes the original screens and components;
- Espanso's public match-file format.

Not rebuilt in this version:

- The WordPress block editor content type.
- The original branded icon. The packages use a new icon drawn from the sidebar mark.

The MCP server was built afterwards too, as a new piece: nothing of the original's adapter is in those records beyond its existence.

The assistant was built afterwards as well, and is also new. The records say the original had an assistant panel, and nothing about how it worked.

Team snippets were rebuilt afterwards, from the record of the original's data model: one repository, a folder per package with a `_manifest.yml`, read-only copies, and changes proposed by pull request. How the original stored its installed copies is not in those records, so that part is new here.

One behaviour is a best guess. The original applied a file's trigger prefix to its snippets, and the records do not say exactly when. Here the prefix is offered as the start of each new trigger and existing triggers are never rewritten.

## Licence

MIT. See [LICENSE](LICENSE). The one vendored file, Preact with htm, keeps its own licences in `renderer/vendor/`.
