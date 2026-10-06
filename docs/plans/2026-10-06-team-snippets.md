# Team snippets Implementation Plan

**Goal:** Connect the app to one GitHub repository of team packages, install and update packages as read-only copies Espanso loads, and propose a local file back as a branch for a pull request.

**Architecture:** A git runner (`core/git.js`) is the only place that starts `git`. A team repository object (`core/teamRepo.js`) owns a bare copy in the app's data folder and reads packages straight from the commit. Installed copies live in `match/team/<name>/` and are managed by `core/teamPackages.js`. A facade (`core/team.js`) joins the two for the service and the router. The store reads installed team files as a third, read-only source.

**Tech Stack:** Node built-ins, the system `git`, the existing `yaml` dependency, Node's test runner, Electron 44.

Spec: `docs/specs/2026-10-06-team-snippets-design.md`.

**How this plan is written.** Each task fixes the contract, the tests and the commands. The code itself is written straight into the files, test first, and is not repeated here. In the first piece the plan carried every line of code, and after review fixes the plan and the files had drifted apart. The commits are the record of the code.

---

## File map

| File | Change | Responsibility |
| --- | --- | --- |
| `core/teamAddress.js` | Create | Accepts or refuses a repository address; gives its clone address and web address |
| `core/git.js` | Create | Runs `git`: no shell, no prompts, a time limit, a plain error per failure |
| `core/teamRepo.js` | Create | The bare copy: connect, fetch, list packages, read files, push a proposal |
| `core/teamPackages.js` | Create | `match/team/`: install, update, remove, markers |
| `core/team.js` | Create | Joins repository and installed copies; what the routes call |
| `core/store.js` | Modify | A third read-only source, `team` |
| `core/settings.js` | Modify | `teamRepository` |
| `core/service.js` | Modify | Holds the team facade; connect and disconnect |
| `core/apiRouter.js` | Modify | Five `/team` routes; `team:` file ids; two new error codes |
| `electron/ipc.js`, `electron/preload.cjs`, `shared/channels.js`, `electron/bootstrap.js` | Modify | `team:connect`, `team:disconnect`, `team:openLink` |
| `renderer/lib/api.js` | Modify | Team calls; helpers for the third source |
| `renderer/components/TeamPage.js`, `renderer/components/ProposeDialog.js` | Create | The Team packages page and the proposal dialog |
| `renderer/components/Sidebar.js`, `SettingsPage.js`, `FileView.js`, `SearchResults.js`, `SnippetList.js`, `SnippetEditor.js`, `CommandPalette.js`, `Overview.js`, `renderer/app.js`, `renderer/styles/app.css` | Modify | The Team group, the Settings card, the Propose button, and the third source wherever a file's source is shown |
| `test/helpers/teamRemote.js` | Create | Builds a throwaway team repository with real `git` |
| `test/teamAddress.test.js`, `test/git.test.js`, `test/teamRepo.test.js`, `test/teamPackages.test.js`, `test/team.test.js` | Create | One test file per new unit |
| `test/store.test.js`, `test/apiRouter.test.js`, `test/settings.test.js`, `test/service.test.js`, `test/ui-smoke.mjs`, `test/espanso-check.mjs` | Modify | The new source, routes, setting, and steps |
| `README.md` | Modify | "Team snippets" section |

---

### Task 1: Repository addresses

**Contract.** `parseRepositoryAddress(input, { allowLocal = false })` returns `{ url, host, owner, repo, webUrl }` or throws an error with code `INVALID`.

- Accepts `owner/repo`, `https://host/owner/repo` with or without `.git` or a trailing slash, `git@host:owner/repo.git`, `ssh://git@host[:port]/owner/repo.git`.
- `owner/repo` becomes `https://github.com/owner/repo.git`. HTTPS addresses gain `.git`. SSH addresses are kept as given, with `.git`.
- `webUrl` is `https://<host>/<owner>/<repo>`, with no port from an SSH address.
- Refuses: anything else; an address with a user name or password; `ext::`, `file:`, a leading `-`; white space or control characters; more than 300 characters; more or fewer than two path parts.
- With `allowLocal`, an absolute path is accepted: `{ url: <path>, host: 'local', owner: '', repo: <folder name>, webUrl: null }`.

**Tests** (`test/teamAddress.test.js`): each accepted form with its exact result; each refused form; the credentials message; `allowLocal` on and off.

Run: `node --test test/teamAddress.test.js`

### Task 2: The git runner

**Contract.** `createGit({ program = 'git', allowLocal = false, env = process.env })` returns `git(args, { cwd, timeout = 15000, input, binary = false })`, a promise of stdout (text, or a Buffer when `binary`).

- `execFile`, never a shell. Always prefixed with `-c core.hooksPath=<null device> -c protocol.ext.allow=never`.
- Environment: `GIT_TERMINAL_PROMPT=0`, `GIT_ALLOW_PROTOCOL=https:ssh` (plus `file` with `allowLocal`), `LC_ALL=C`, `GCM_INTERACTIVE=never`; `GIT_ASKPASS` and `SSH_ASKPASS` removed. Standard input is closed unless `input` is given.
- Output limit 16 MB.
- Failure is a `GitError` with `code: 'GIT_FAILED'`, a `kind` and a plain `message`:

| kind | When | Message |
| --- | --- | --- |
| `missing` | The program is not found | Git is not installed on this computer. |
| `timeout` | The time limit passed | Git did not finish in time. |
| `too-large` | Output over the limit | Git sent more than the app can read. |
| `auth` | Sign-in refused or a prompt was needed | Git could not sign in to that repository. … |
| `unreachable` | Repository or host not found | Git could not reach that repository. … |
| `identity` | No name or email for commits | Git does not know your name and email yet. … |
| `denied` | Push rejected | You do not have permission to push to this repository. |
| `failed` | Anything else | Git failed: `<last line git wrote>` |

**Tests** (`test/git.test.js`): a real `git --version`; a missing program; a command over its time limit (a stand-in program that sleeps); the environment a child sees (a stand-in program that prints it); standard input closed; `ext::` refused; each stderr pattern mapped to its kind; binary output.

Run: `node --test test/git.test.js`

### Task 3: The team repository, reading

**Contract.** `createTeamRepo({ dataDir, address, git, now, limits })` returns:

- `connect()`: clones bare into `dataDir/team/<12 hex of sha256(url)>/repo.git` through a temporary folder, or fetches if already there. Removes leftovers first.
- `fetch()`: fetches the default branch; records the time in `fetched-at`.
- `status()`: `{ branch, commit, fetchedAt }`, with `commit: null` for an empty repository.
- `packages()`: `{ packages, problems }` read from the commit with `git ls-tree` and `git cat-file --batch`. Each package: `name, title, description, version, author, manifestError, files: [{ name, matchCount, size }], matchCount, runsCommands, tree, problems, webUrl`.
- `packageFiles(name)`: `[{ name, bytes }]` for install, manifest included.
- `disconnect()`: removes the copy.
- Every method runs one at a time.

Rules: package names match `^[a-z0-9][a-z0-9-]{0,79}$`; only regular files directly inside `packages/<name>/`, named as the store allows or `_manifest.yml`, 2 MB at most; links, submodules, subfolders, oversize and badly named files are left out and reported; limits of 200 packages, 50 files a package and 64 MB read in one listing; a listing is cached per commit. `runsCommands` is true when any snippet or global variable has `type: shell` or `type: script`.

**Tests** (`test/teamRepo.test.js`, with `test/helpers/teamRemote.js`): connect and list a seeded repository; fetch picks up a new commit; an empty repository; no `packages/` folder; a bad manifest; each kind of file that is left out; limits; `runsCommands`; two connects at once make one clone; a leftover temporary folder is removed; a missing remote gives `unreachable`; disconnect removes the copy.

Run: `node --test test/teamRepo.test.js`

### Task 4: The team repository, proposing

**Contract.** `propose({ package, fileName, text, summary, title, description })` returns `{ branch, commit, compareUrl, created }`.

- Fetches first. Branch `snippet-editor/<package>-<UTC yyyymmdd-hhmmss>`, from the default branch, in a temporary worktree.
- Writes `packages/<package>/<fileName>`. For a package that does not exist yet, also `_manifest.yml` with `name`, `title`, `description`, `version: 0.1.0` and `author` from git's `user.name`; `title` and `description` (3 to 1000 characters) are then required.
- Refuses with `INVALID`: a bad package or file name, an empty summary or one over 100 characters, a file identical to the one already there, a package path that is a link or a file in the repository.
- Commits with the summary. Pushes only `refs/heads/<branch>`, never forced. Removes the worktree and the local branch whether or not the push succeeded.
- `compareUrl` is `<webUrl>/compare/<default>...<branch>?expand=1`, or `null` without a web address.

**Tests** (added to `test/teamRepo.test.js`): a proposal to an existing package arrives on the remote as one commit on a new branch with the default branch untouched; a new package gets its manifest; an identical file is refused; no identity gives `identity`; a remote that rejects the push gives `denied` and leaves nothing behind; a link at the package path is refused and nothing is written outside the worktree; two proposals in the same second get different branches.

Run: `node --test test/teamRepo.test.js`

### Task 5: Installed packages

**Contract.** `createTeamPackages({ matchDir })` returns:

- `installed()`: a Map of name to marker `{ repository, package, commit, tree, state, installedAt }` for folders in `match/team/` that carry `.snippet-editor.json`.
- `install({ name, files, repository, commit, tree })`: marker first with `state: 'installing'`; each file written as `_incoming-<name>` then renamed; files no longer in the package removed; marker last with `state: 'installed'`. Refuses with `EXISTS` when the folder is there without a marker.
- `remove(name)`: removes a marked folder; `NOT_FOUND` when absent; `READ_ONLY` when it has no marker.
- One operation at a time.

**Tests** (`test/teamPackages.test.js`): install writes exactly the files and the marker; update replaces changed files and removes dropped ones; an unmarked folder is refused and untouched; an interrupted install (marker `installing`, a leftover `_incoming-` file) is repaired by installing again; remove; two installs at once leave a whole folder; a read-only match folder fails cleanly.

Run: `node --test test/teamPackages.test.js`

### Task 6: The store's third source

**Contract.** `team` is read like `package`, from `match/team/<name>/`: ids `team:<name>:<file>`; `inventory()` gains `team: [...]` in the shape of `packages`; `search` covers it; every write answers `READ_ONLY`; a link that leaves `match/team/` is not read.

**Tests** (added to `test/store.test.js`): listing, reading, searching, the read-only refusals, and the link check, against a team folder made in the sandbox.

Run: `node --test test/store.test.js`

### Task 7: Facade, setting, service and routes

**Contract.**

- `core/settings.js`: `teamRepository`, a string or `null`.
- `core/team.js`: `createTeam({ dataDir, matchDir, address, git })` with `status()`, `refresh()`, `install(name, { acceptCommands })`, `remove(name)`, `propose(...)`, `disconnect()`. `status()` joins repository packages with markers: `installed`, `updateAvailable` (trees differ, or the marker says `installing`), and lists installed packages the repository no longer has.
- `core/service.js`: `team()` returns the facade or `null`; `connectTeam(input)` parses, saves and clones; `disconnectTeam()`; a background fetch at start. Options `git` and `allowLocalRepositories` for tests.
- `core/apiRouter.js`: the five routes; `refFromId` reads `team:` ids; `GIT_FAILED` answers 502 and `NOT_CONNECTED` 409; install without `acceptCommands` for a package that runs commands answers 400.

**Tests** (`test/team.test.js`, `test/apiRouter.test.js`, `test/settings.test.js`, `test/service.test.js`): each route's success and each router row of the spec's failure table.

Run: `npm test`

### Task 8: The window

**Contract.**

- Channels `team:connect`, `team:disconnect`, `team:openLink` (opens only an `https` link on the connected repository's host).
- Settings card "Team snippets": address field and Connect; when connected, the address, branch, last check, "Check for updates" and "Disconnect".
- Sidebar: a Team group with installed packages and their files, and a link to the Team packages page.
- Team packages page: every package with Install, Update or Remove, and badges for Installed, Update available and Runs commands. Installing a package that runs commands asks first.
- A file's view: "Propose to team", opening the dialog from the spec, ending in "Open pull request page".
- Wherever a file's source is shown, team files read as team files and are read-only.

**Tests** (`test/ui-smoke.mjs`, against a local test repository): connect; install; the package's snippets appear in the sidebar and in search; a new commit shows "Update available"; update; a package that runs commands asks first; propose a file and find the branch on the test repository; remove. Screenshots are reviewed in light and dark and at 760 pixels.

Run: `npm run test:ui`

### Task 9: Espanso check, README, design record

- `test/espanso-check.mjs`: the real Espanso reads an installed team package, and `espanso package list` still works.
- `README.md`: a "Team snippets" section; the layout table; the list of what is not rebuilt.
- The design's "Changed while building" section.

Run: `npm test && npm run test:ui && npm run pack && npm run test:packaged && npm run test:espanso`

---

## Self-review

Every row of the spec's failure table is named by a test in Tasks 2 to 8. Every route and setting in the spec appears in Task 7. Nothing in the spec's "Not in this piece" list is built.
