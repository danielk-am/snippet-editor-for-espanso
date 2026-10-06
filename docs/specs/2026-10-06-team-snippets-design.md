# Team snippets from GitHub: design

Status: approved by Daniel on 2026-10-06.

This is the second of three connected pieces. The first, the local API, is built on the `local-api` branch. The third is the MCP server, in `2026-10-06-mcp-server-design.md`.

## Goal

A team keeps its shared snippets in one GitHub repository. Each person connects the app to that repository, installs the packages they want, hears when a package has changed, and proposes changes back as a pull request.

## Decisions already made

| Question | Daniel's answer, 2026-10-06 |
| --- | --- |
| What may the app send back to the team repository? | Proposals only. The app pushes a new branch and you open a pull request. It never pushes to the main branch, meaning the repository's default branch. |
| How is the pull request opened? | The app opens GitHub's new pull request page for that branch in your browser, and you press Create. |

From the first conversation about this piece: the app uses the `git` already on the computer, with whatever SSH or HTTPS access you already have. The app stores no credentials.

## What the original did

The original app's source cannot be reached from this computer, so this follows the record of its data model that was kept from an earlier port:

- One team repository holds packages under `packages/<name>/`. Each has a `_manifest.yml` with `name`, `title`, `description`, `version` and `author`, beside its match files.
- The app kept a copy of the repository, listed its packages, and installed the ones you chose as managed, read-only copies in Espanso's match folder.
- Team content was read-only in the app. A change went back as a branch and a pull request.

This design keeps that shape.

## Two things checked against the real Espanso (2.4.1)

| Question | Result | What it decides |
| --- | --- | --- |
| Does Espanso load match files from a folder of our own, such as `match/team/goodbyes/`? | Yes. It loads every `.yml` there, except names that start with `_`. | Installed team packages go in `match/team/<name>/`. |
| What happens if a package is put in Espanso's own `match/packages/` without Espanso's source file? | `espanso package list` fails for every package. | Team packages do not go in `match/packages/`. Espanso's own package commands keep working. |

## How it fits together

```
GitHub repository ── git (your own access) ──▶ copy in the app's data folder
                                                   │ list, install, update
                                                   ▼
                                    match/team/<name>/  ◀── Espanso reads these
                                                   ▲
   your own file ── propose ──▶ new branch ── git push ──▶ GitHub ──▶ you open the pull request
```

| Piece | File | Job |
| --- | --- | --- |
| Git runner | `core/git.js` (new) | Runs `git` with fixed arguments, no shell, no prompts, a time limit, and a plain error for each way it fails. |
| Team repository | `core/teamRepo.js` (new) | The copy of the repository: connect, fetch, list packages, read a package's files, push a proposal branch. |
| Installed packages | `core/teamPackages.js` (new) | `match/team/`: install, update, remove, and say what is installed. |
| Store | `core/store.js` | Lists and reads installed team files as a third, read-only source, `team`, beside `local` and `package`. |
| Router | `core/apiRouter.js` | Five new routes under `/api/v1/team`. |
| Service | `core/service.js` | Holds the team repository for the current settings. |
| Window | `renderer/` | A Team group in the sidebar, a Team packages page, a card in Settings, and a "Propose to team" dialog. |

No new dependency. The app needs `git` installed. Without it, the rest of the app works and the Team card says git is missing.

## The team repository

- **Address.** Accepted forms: `https://host/owner/repo`, with or without `.git`; `git@host:owner/repo.git`; `ssh://git@host/owner/repo.git`; and the short form `owner/repo`, which means `https://github.com/owner/repo.git`. Anything else is refused. So is an address that carries a user name and password, because saving it would put a secret in the settings file.
- **Hosts.** GitHub and GitHub Enterprise. The pull request link is built in GitHub's format.
- **One repository at a time.** Connecting another replaces the first. Disconnecting removes the app's copy of the repository. Either way, installed packages stay until you remove them.
- **The copy.** A bare clone in the app's data folder, under `team/<12 characters from the address>/repo.git`. Nothing is checked out, when reading and when proposing. Packages are read with `git ls-tree` and `git cat-file`, straight from the commit, so a symbolic link or a submodule in the repository is never followed. It is skipped and reported.
- **Staying current.** The app fetches when it starts, in the background, and when you press "Check for updates". It never changes an installed package on its own.
- **Limits.** 200 packages, 50 files in a package, 2 MB a file (the size the app opens). Beyond a limit, the package says what was left out.

## Packages

A package is a folder `packages/<name>/` whose name is lowercase letters, digits and dashes, 80 characters or fewer, as in the original. It has a `_manifest.yml` and one or more `.yml` match files.

For each package the app reports: `name`, `title`, `description`, `version`, `author`, its files with snippet counts, whether it is installed, whether an update is available, and any problem with it.

- **Runs commands.** Espanso snippets can run shell commands and scripts when used. A package that holds a `shell` or `script` variable is marked "Runs commands". Installing or updating it needs a second, explicit confirmation.
- **Install.** The package's files are written to `match/team/<name>/`, with a marker file `.snippet-editor.json` that records the repository, the commit and the package's tree id. The marker is written first, so a folder is the app's to repair from the first moment. Each file is written under a name Espanso skips (a leading underscore) and then renamed into place, so Espanso never reads a half-written file. Espanso also loads hidden folders, which rules out staging a whole copy beside the real one.
- **Update available.** The installed tree id differs from the package's tree id in the fetched commit. A commit that touches other packages does not flag this one.
- **Update.** The same as install, replacing the managed copy.
- **Remove.** Deletes `match/team/<name>/`. Only a folder that carries the app's marker can be removed or replaced. A folder of the same name without the marker is left alone, and the install is refused.
- **Read-only.** Installed team files show in the window like package files: readable, searchable, and copyable into one of your own files. They cannot be edited there.

## Proposals

You propose one of your own files to a team package.

1. In a file's view, "Propose to team" opens a dialog: choose a package or name a new one (`title` and `description` needed, `description` 3 to 1000 characters as in the original), and write a one-line summary.
2. The dialog states what will be sent: the file name, the number of snippets, and the repository. Every snippet in that file becomes readable by anyone who can read the repository.
3. The app fetches, then in a temporary working folder:
   - starts a branch `snippet-editor/<package>-<date>-<time>` from the main branch,
   - writes the file to `packages/<package>/<file name>`, and a `_manifest.yml` for a new package,
   - commits it with your summary, under the name and email git already has for you,
   - pushes that one branch. It never pushes the main branch and never forces a push.
4. The temporary folder and the local branch are removed.
5. The window shows "Proposal sent" with a button, "Open pull request page", which opens `https://<host>/<owner>/<repo>/compare/<main>...<branch>?expand=1` in your browser. The window opens only links on the connected repository's host.

A file identical to what the package already holds is refused: there is nothing to propose. Removing a file from a package, and renaming one, are done on GitHub.

## Routes

All under `/api/v1/team`, with the same token, errors and limits as the rest of the API.

| Method | Path | Does | Input | Success |
| --- | --- | --- | --- | --- |
| GET | `/team` | Repository, branch, commit, when it was last fetched, packages, and any problem | none | 200 |
| POST | `/team/refresh` | Fetch, then the same reply as `GET /team` | none | 200 |
| PUT | `/team/packages/{name}/installed` | Install, or update to the fetched commit | `acceptCommands?` | 200 |
| DELETE | `/team/packages/{name}/installed` | Remove the installed copy | none | 200 |
| POST | `/team/proposals` | Push a proposal branch | `fileId`, `package`, `summary`, `title?`, `description?` | 201 with `branch` and `compareUrl` |

Existing routes gain the third source. `/state` adds `team`, the installed team packages with their files. `/files/{id}` reads ids such as `team:goodbyes:package.yml`. `/search` covers them. Every write to a team file answers 403 `READ_ONLY`.

New error codes: `GIT_FAILED` (502), with a plain sentence for the cause, and `NOT_CONNECTED` (409) when no repository is connected.

Connecting and disconnecting a repository are settings. Like the match folder, they stay on the window's own channel and cannot be done over HTTP.

## Settings added

| Setting | Default | Meaning |
| --- | --- | --- |
| `teamRepository` | none | The address of the connected repository |

## How git is run

- Through `execFile`, with an argument list and `--` before any address or path. No shell is involved, so nothing in an address or a package name can become a command.
- Only the `https` and `ssh` transports are allowed (`GIT_ALLOW_PROTOCOL`). The `ext` and `file` transports, which can run commands or read local folders, are off.
- It can never stop to ask a question: `GIT_TERMINAL_PROMPT=0`, no terminal, and input closed. If git would have asked for a password or a passphrase, it fails and the app says how to check access in a terminal.
- Hooks are off for the app's own copy (`core.hooksPath` set to nothing), so a hook set up on the computer does not run inside the app.
- Time limits: 120 seconds to clone, 60 to fetch or push, 15 for anything local. A call that runs over is stopped.
- One git operation at a time for the repository.
- Your own git settings for sign-in, signing and identity are used as they are. The app reads none of them.

## What could go wrong

| Path | Realistic failure | Handled how | Test | What you see |
| --- | --- | --- | --- | --- |
| Connect | Git is not installed | Detected before anything runs | Git runner test with a missing program | "Git is not installed on this computer." |
| Connect | Address is not a repository address, or carries a password | Refused before git runs | Address test, one case per form | "That is not a repository address", with the accepted forms |
| Connect | No access, or the repository does not exist | Git fails without prompting | Repository test against a missing remote | "Git could not reach that repository", with a command to try in a terminal |
| Connect | No network, or a slow one | Time limit | Git runner test with a stalled command | "Git did not finish in time." The previous connection, if any, is kept |
| Connect | Pressed twice | One operation at a time; the second waits and finds it done | Repository test with two calls at once | One clone |
| Connect | The app quits partway | The clone goes to a temporary folder and is moved into place when complete | Repository test that leaves a partial folder | The next start ignores the leftover and removes it |
| Disconnect | Pressed while a fetch or a proposal runs | It waits its turn | Repository test | Disconnected once the running step ends |
| Fetch at start | No network | Runs in the background; failure is recorded, not raised | Service test | The window opens. The Team card says when it last succeeded |
| List | No `packages/` folder | An empty list with a reason | Repository test | "This repository has no packages folder yet." |
| List | A manifest is missing, is not YAML, or is not a mapping | The package is listed with the problem, named from its folder | Repository test | The package shows with "Its manifest could not be read" |
| List | A file is a symbolic link, a submodule, too large, or badly named | Skipped and reported on the package | Repository test with each kind | The package shows what was left out |
| List | More than 200 packages or 50 files | Cut at the limit and reported | Repository test | "Only the first 200 packages are shown." |
| Install | A folder of that name is in `match/team/` without the marker | Refused | Package test | "A folder named X is already there and was not put there by this app." |
| Install | The package runs commands and that was not confirmed | Refused until `acceptCommands` is sent | Package test and router test | The dialog asks again, naming the risk |
| Install | Disk full, or the match folder is read-only | The temporary folder is removed; nothing changes | Package test with a read-only folder | The existing plain disk message |
| Install | The app quits partway | The marker says an install was under way; the package shows as needing an update, and installing again finishes it. Leftover staged files are names Espanso skips | Package test | "Update available". Install again to finish |
| Install | Two installs of one package at once | One at a time | Package test | Both succeed; the folder is whole |
| Update | Nothing to update | Answers the current state | Package test | "Already up to date." |
| Remove | The folder was changed by hand | The marker is all that is checked; the folder is removed | Package test | Removed |
| Remove | Not installed | 404 | Router test | "That package is not installed." |
| Read | An installed team file is opened, searched or copied | The store's existing read path, with the same symbolic-link check as packages | Store test | Read-only, as package files are today |
| Read | A link inside `match/team/` points outside it | Refused, as for packages | Store test | The file is not listed |
| Propose | The file is not one of yours, has no snippets, or has YAML errors | Refused before git runs | Router test | 400 with the reason |
| Propose | Package name not allowed; new package without title or description | Refused before git runs | Router test | 400 naming the field |
| Propose | The package already holds this exact file | Refused | Repository test | "The team package already has this file as it is." |
| Propose | Git has no name or email for you | The commit fails; the message is passed on plainly | Repository test with an empty identity | "Git does not know your name and email yet", with the two commands |
| Propose | You may read the repository but not push | The push fails; the local branch and folder are removed | Repository test with a remote that refuses pushes | "You do not have permission to push to this repository." |
| Propose | Pressed twice | The dialog's button is off while it runs; a second request makes a second branch with a later time | UI test | One proposal from one click |
| Propose | The app quits partway | Temporary folders are removed at the next start; nothing was pushed, or the branch is on GitHub | Repository test for the cleanup | Nothing local is left behind |
| Any git call | Output is very large | Capped at 16 MB | Git runner test | "Git sent more than the app can read." |
| Any route | No repository connected | Answered before git runs | Router test | 409 `NOT_CONNECTED` |

## How it will be tested

- **Git runner, repository and package tests** run the real `git` against repositories made in a temporary folder. No test touches the network or GitHub. For these tests only, the service is started with local folders allowed as addresses. That is an option in code, not a setting, so it cannot be switched on in the app.
- **Router tests** for the five routes and the new source, with expected values written by hand.
- **End-to-end test:** connect to a local test repository through Settings, install a package, see its snippets in the sidebar and in search, see the update notice after the test repository changes, update, propose a file and check the branch arrived, then remove the package.
- **The real Espanso** is asked to read a folder with an installed team package, and its own `package list` is checked to still work.
- **Packaged-app test** must pass unchanged.
- Tests are written first and watched to fail.

## Changed while building

| Change | Why |
| --- | --- |
| `GET /team` answers 200 with `connected: false` when no repository is connected. The other four routes answer 409. | It is a question about state, and the window asks it on every visit. |
| Removing an installed package works with no repository connected. Installed packages the repository does not offer are listed as `installedOnly`. | A copy can outlive its source and must still be removable. |
| At most 12 MB is read in one listing, not 64 MB. | It fits inside the git runner's limit in one call. Beyond it, a package is listed without counts and cannot be installed from the app. |
| Files are staged under one short underscore name and renamed, not staged in a temporary folder. | Checked against Espanso: it loads hidden and underscore-named folders too, so a staged copy would be loaded as a duplicate. A staging name built from the file's own could be too long for the disk. |
| "Propose to team" shows on a file only while a repository is connected. `/state` gains `teamConnected`. | It leaves the page as it was for people who use no team repository. |
| A saved address is checked again each time the app starts. | The settings file can be edited by hand. |
| The check for an unchanged file is made after the file is staged in git, not by comparing bytes first. | One check covers both an identical file and one that differs only in line endings git normalises. |

Also fixed, though it was not part of this piece: dialogs sat left of centre when their text ran long. The proposal dialog names the repository, which made it plain.

### After an independent review

The review found two security defects and two faults in how the app follows a repository. All are fixed, each with a test that failed first.

| Change | Why |
| --- | --- |
| A proposal is built inside git, with no files checked out. The steps above that mention a temporary working folder no longer apply. | On a disk that ignores capital letters, a link in the repository named `Base.yml` received what was written to `base.yml`. With nothing checked out, nothing in a repository is ever written to, or run on, this computer. |
| A name that differs from an existing one only in capital letters is refused, for a package and for a file. | The two would be one file on many disks. |
| The manifest is checked for commands too, and a file the app cannot read counts as one that may run commands. | A shell variable in a manifest that a match file imports, or in YAML this parser refuses but Espanso reads, installed with no question asked. |
| A package the app did not read cannot be installed. | It was not checked for commands. |
| The app asks the repository which branch is its main one at every fetch. | When a team renamed its main branch, the app reported an empty repository for good. |
| The status always answers, with `problem` set, even when git or the copy fails. "Check for updates" copies the repository again if the copy has gone. | A repository that could be connected but not listed left the app connected with no card to disconnect from. |
| A manifest over 64 KB is not read. Manifests count against what one listing reads. | Nine large manifests made a whole listing fail. |
| Of two files in a package that differ only in capitals, one is offered and the other reported. | Only one could be installed on many disks. |
| Reading the status and the packages does not wait behind a fetch. | On a stalled network the Team page waited up to a minute. |
| Connecting and disconnecting run one at a time. Git calls still under way are stopped when the app closes. An empty folder in `match/team/` does not block an install. The port of an HTTPS address stays in its web address. The remote is always named `origin`. | Each was a small fault the review reproduced. |

Left as they are:

- A proposal's commit is not signed, even if your git signs commits. The commit is made with git's low-level command, which does not sign by default.
- If asking for the team status fails for a reason other than git, the Settings card is not drawn.

## Not in this piece

- Pushing to the main branch, by any route.
- Creating the pull request for you, with `gh` or GitHub's API.
- More than one team repository.
- Editing team files in place, removing or renaming a file in a package.
- Updating installed packages without being asked.
- Hosts that are not GitHub.
