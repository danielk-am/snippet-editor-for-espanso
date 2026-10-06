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

## How it treats your files

Espanso's match folder is the only store. There is no database, so nothing can drift from what Espanso reads.

- **An edit changes only what you edited.** The app never regenerates a file. It finds the value you changed and splices the new text in at that spot, so every other byte stays as you wrote it: comments, blank lines, indentation, quoting, `imports`, `global_vars` and the other snippets.
- **Each edit is checked before it is saved.** The result is parsed again. The snippet must read back as intended and everything else must read back unchanged. If that cannot be shown, the edit is refused and you are pointed to the raw editor. Nothing is written.
- **Text is read the way Espanso reads it.** An unquoted `02134` or `+6591234567` is shown as those characters, not as a number.
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
| `core/` | Node-only logic with no Electron in it: YAML round-tripping, the file store, path resolution, settings. |
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
npm run test:ui
```

Starts the real app off-screen against a temporary copy of the fixtures, drives it end to end, checks what reached the disk, and saves screenshots to `test/.artifacts/`. It also fails on any console error, any control without an accessible name, and any control smaller than 24 pixels. One step drops deliberately malformed files into the folder and checks that every screen still opens.

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

- Organisation sync with a reviewed Git repository, and proposing changes by pull request.
- The MCP adapter.
- The AI assistant panel.
- The WordPress block editor content type.
- The original branded icon. The packages use a new icon drawn from the sidebar mark.

One behaviour is a best guess. The original applied a file's trigger prefix to its snippets, and the records do not say exactly when. Here the prefix is offered as the start of each new trigger and existing triggers are never rewritten.
