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

Limits: a request body can be up to 4 MB, a match file up to 2 MB, and the YAML helpers take up to 256 KB of text. Over a limit, the answer is `413`. YAML can hold two things JSON cannot: a number that is not finite, and a list or mapping that contains itself. A reply that would include one is refused with `422` and the code `UNREPRESENTABLE`, so a script is never handed data that differs from the file.

How it is guarded:

- It listens on `127.0.0.1` only, so other computers cannot reach it.
- Every route needs the token. It is kept in `api-token` in the app's data folder, readable only by you. Replace it in Settings at any time.
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

To connect an AI tool, open Settings, go to "AI tools" and press "Copy setup". Paste the block into the AI tool's MCP settings. It names the app's own program and the server file, so you do not need Node installed. It holds no password or token: the server reads the API token from the app's data folder itself.

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
- A reply is at most 25,000 characters. Long lists come in pages.
- Deleting a file, removing a team package, connecting a repository and everything in Settings stay in the window.
- The switch governs this MCP server. Another program on your computer that holds the API token can still change snippets through the API.

The server speaks both forms of MCP in use today: the older one that opens with a handshake (versions `2024-11-05` to `2025-11-25`) and the one from `2026-07-28` that sends its version with every request. It is written by hand, in three files under `mcp/`, with no dependency.

How well an AI tool can use the tools was checked: ten questions with one right answer each, given to a fresh agent with nothing but these tools. It answered 10 of 10. The questions and the result are in `test/mcp-eval/`.

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
| `mcp/` | The MCP server: the protocol, the twelve tools and the client for the app's API. It imports nothing from the rest of the app. |
| `shared/` | Pure modules used by both sides: the snippet and variable models, search, the IPC channel list. |
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

Starts the real app off-screen against a temporary copy of the fixtures, drives it end to end, checks what reached the disk, and saves screenshots to `test/.artifacts/`. It also fails on any console error, any control without an accessible name, and any control smaller than 24 pixels. One step drops deliberately malformed files into the folder and checks that every screen still opens. Another switches the API on in Settings and reads the snippets over HTTP, with and without the token.

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

- The AI assistant panel.
- The WordPress block editor content type.
- The original branded icon. The packages use a new icon drawn from the sidebar mark.

The MCP server was built afterwards too, as a new piece: nothing of the original's adapter is in those records beyond its existence.

Team snippets were rebuilt afterwards, from the record of the original's data model: one repository, a folder per package with a `_manifest.yml`, read-only copies, and changes proposed by pull request. How the original stored its installed copies is not in those records, so that part is new here.

One behaviour is a best guess. The original applied a file's trigger prefix to its snippets, and the records do not say exactly when. Here the prefix is offered as the start of each new trigger and existing triggers are never rewritten.

## Licence

MIT. See [LICENSE](LICENSE). The one vendored file, Preact with htm, keeps its own licences in `renderer/vendor/`.
