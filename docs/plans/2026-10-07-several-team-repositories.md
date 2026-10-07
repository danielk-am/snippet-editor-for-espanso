# Several Team Repositories Implementation Plan

**Goal:** The app connects to up to ten team repositories at once, each with its own packages, update checks and proposals, where today connecting a second replaces the first.

**Architecture:** The setting becomes a list. The service holds one `team` object per repository, keyed by its address. A package belongs to the repository named in its marker, compared by host, owner and name. Routes, tools, cards and the window name a repository only where more than one could be meant.

**Tech Stack:** As the app: Node, `node --test`, Electron, Preact and htm, real `git` against temporary repositories in tests. No new dependency.

**Spec:** `docs/specs/2026-10-07-several-team-repositories-design.md`. It is the authority. It extends `docs/specs/2026-10-06-team-snippets-design.md`.

This plan is lean: files, exact names, tests by name, and the failure rows each task covers. The code exists; the work is to change what assumes one repository.

---

## Rules for every task

1. Test first. Write or change the test, run it, see it fail for the stated reason, then change the code. Say in the report what the failing run printed.
2. Run tests as `node --test ./test/<file>` with the leading `./`. Before the commit, `npm test` must exit 0.
3. Follow the code around you: tabs, plain short comments that say why, messages a person can act on. No em dashes.
4. Work only in this worktree. Do not touch the main checkout or its `dist/`. Do not push.
5. Commit at the end of the task on branch `several-team-repos`, message `Area: what changed`, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
6. No real model is called. Nothing but 127.0.0.1 and temporary folders is reached.

## Shared names

```js
// core/teamAddress.js: a parsed address gains two fields.
address = { url, host, owner, repo, webUrl, key, id }
//   key: `${host}/${owner}/${repo}` in lower case. Two addresses with one key are one repository.
//   id:  the first 12 hex characters of sha256(url). It already names the copy's folder.
repositoryKey(url, { allowLocal }) -> key, or '' when the text is not an address

// core/settings.js
teamRepositories: string[]          // normalised urls; at most 10; no two with one key
MAX_TEAM_REPOSITORIES = 10

// core/service.js
service.teams() -> team[]                      // in the order connected
service.team(id) -> team | null                // one repository; with no id and exactly one connected, that one
service.connectTeam(input) -> teamStatus()
service.disconnectTeam(id) -> teamStatus()
service.refreshTeam(id?) -> teamStatus()       // one, or all when no id
service.teamStatus() -> { connected, repositories: [repositoryStatus], installedOnly: [{ name, repository }], problem }
//   repositoryStatus: what team.status() answers today, plus `id`
//   a package in it: today's fields, with `installed` and `updateAvailable` true only for this repository's own, plus `installedFrom`

// errors
AMBIGUOUS (409): more than one repository could be meant; the message lists them
NOT_FOUND (404): "That repository is not connected."
EXISTS (409): "A package named X is already installed from <owner/repo>. Remove it first, then install this one."
INVALID (400): "This repository is already connected, as <url>." / "Ten repositories are connected. Disconnect one first."
```

---

### Task 1: The setting becomes a list, and an address knows its repository

**Files:** `core/settings.js`, `core/teamAddress.js`; tests `test/settings.test.js`, `test/teamAddress.test.js`.

- `DEFAULTS.teamRepositories = []`. `clean(raw)` keeps up to ten text entries of 300 characters or fewer, in order, without repeats. A saved `teamRepository` (text) with no `teamRepositories` is read as a list of one. `teamRepository` is no longer written.
- `parseRepositoryAddress` adds `key` and `id`. Export `repositoryKey`.

**Tests:** defaults; the old key read as a list of one and gone after a save; wrong shapes ignored (`teamRepositories: 'x'`, entries that are not text, an eleventh entry dropped, a repeat dropped); HTTPS, SSH and the short form of one repository give one `key` and different `id`s where the url differs; a local folder address (tests only) has a `key`.

**Failure rows:** Start, first row.

### Task 2: A package belongs to the repository in its marker

**Files:** `core/teamPackages.js`, `core/team.js`; tests `test/teamPackages.test.js`, and the `createTeam` cases in `test/team.test.js`.

- `teamPackages.install({ name, files, repository, commit, tree })` refuses with `EXISTS` when the folder's marker names a repository with another key. A marker that names none (damaged) may be overwritten by any.
- `team.status()`: for each package, `installed` and `updateAvailable` are true only when the marker's repository has this repository's key. `installedFrom` is the other repository's url when the name is held by another, else `''`. Its `installedOnly` lists markers of this repository's key that it no longer offers.
- `team.install` refuses a name held by another repository before reading any file.

**Tests:** install over another repository's package is refused and the folder is left exactly as it was; install over its own updates; a damaged marker is repaired by any; two installs of one name from two repositories at the same moment give one installed and one refused; status shows `installedFrom` and no update for another repository's package; a marker whose url differs from the connected one only in address form (SSH against HTTPS) still counts as its own.

**Failure rows:** Install rows 1, 2 and 5; Update row.

### Task 3: The service holds several

**Files:** `core/service.js`; tests `test/team.test.js`, `test/service.test.js`.

- State is a map from url to `team`, in the order of the setting. `configure()` builds one per saved address; an address that is refused, or whose key repeats an earlier one, is skipped and named in the top-level `problem`.
- `connectTeam`: the same url answers its status and copies nothing; another address with a connected key is `INVALID`; an eleventh is `INVALID`; on failure the list is unchanged. The setting is written only after the copy succeeds.
- `disconnectTeam(id)`: removes that copy only. An id that is not connected answers the current status.
- `refreshTeam(id?)`: one, or all at once; a failure is recorded on its own repository.
- At start, every repository is fetched in the background. `teamFetched()` resolves when all have ended.
- `teamStatus()` as in "Shared names". Top-level `installedOnly` holds markers whose key matches no connected repository.
- `state().teamConnected` is true when at least one is connected.
- `removeTeamPackage(name)` and `setMatchDir` keep working for all.

**Tests:** rewrite every test in `test/team.test.js` that asserts one repository. "connecting another repository replaces the first, and its copy is removed" becomes "connecting another keeps the first, each with its own copy". Add: the same address twice copies once; the other address form is refused and names the connected one; an eleventh is refused; two different repositories connected at the same moment both end connected; a failed connect leaves the others; disconnecting one leaves the others and their copies; disconnect twice; disconnect while that repository fetches; one unreachable at start and the others list; a settings file with a refused address or a repeated repository loads the rest and says which was skipped; refresh all with one failing; a package from a repository that is not connected is listed in the top-level `installedOnly` with its address and can be removed; the match folder changes with two connected.

**Failure rows:** every Start, Connect, Disconnect, Check for updates and Left behind row, and the Match folder row.

### Task 4: Routes, the window's channels, and which links may open

**Files:** `core/apiRouter.js`, `electron/ipc.js`, `shared/channels.js`, `electron/preload.cjs`, `renderer/lib/api.js` (the calls only); tests `test/team.test.js` (routes), `test/apiRouter.test.js`, `test/channels.test.js`, `test/chatChannel.test.js`, `test/teamAddress.test.js`.

- Routes as the spec's table. `PUT /team/packages/:name/installed` and `POST /team/proposals` read `repository` (an id) from the body. Without it: exactly one candidate is used; more than one is `AMBIGUOUS` and lists them as `owner/repo (id)`; none connected is `NOT_CONNECTED` as today.
- `POST /team/repositories/:id/refresh`. `POST /team/refresh` refreshes all.
- `team:disconnect` carries the id. Checking for updates stays a route; no channel is added for it.
- `team:openLink` opens a link that `isTeamLink` accepts for any connected repository. The refusal reads "That link is not part of a connected repository."
- The per-answer chat listener keeps passing every GET and closing everything else: the new POST route must answer 405 there.

**Tests:** each route with none, one and two repositories connected; `AMBIGUOUS` for install and for propose, with both names in the message; an id that is not connected is 404; a link inside the second connected repository opens and one for a repository disconnected since is refused.

**Failure rows:** Install rows 3 and 4; Propose rows; Link rows.

### Task 5: The MCP tools and the assistant's cards

**Files:** `mcp/tools.mjs`, `core/chat/proposals.js`; tests `test/mcpTools.test.js`, `test/chatProposals.test.js`, `test/mcp-eval/serve.mjs`, `test/mcp-eval/questions.json`.

- `snippets_list_team_packages`: reply `{ connected, repositories: [{ id, address, problem }], packages: [{ repository, name, ..., installed, installed_from, update_available, runs_commands }], total_count, has_more, next_offset, installed_only: [{ name, repository }] }`; optional `repository` (an id) narrows it; paging runs across all.
- `snippets_install_team_package` and `snippets_propose_to_team`: optional `repository`. `explain()` turns `AMBIGUOUS` into words that name the repositories and the argument to add.
- Descriptions no longer say "the" repository.
- Install card: a line `Repository: <owner/repo>`, and `made.repository` (the url). At Apply it is stale when that repository is not connected or no longer offers the package; the install rule's refusal is shown when the name was taken meanwhile. The install call passes the repository's id.
- Send card: `made.repository` is checked against the connected set, not against one field. The proposal call passes the repository's id.

**Tests:** list with two repositories and paging across them; install without `repository` when two offer the name explains what to add; a send card still applies after another repository is connected; a send card is stale after its own repository is disconnected; an install card names its repository and is stale in each of the three cases.

**Failure rows:** every Assistant row.

### Task 6: The window

**Files:** `renderer/components/SettingsPage.js` (`TeamCard`), `TeamPage.js`, `ProposeDialog.js`, `FileView.js` if needed, `renderer/styles/app.css`; `test/ui-smoke.mjs` step "team snippets".

- Settings: a list of connected repositories, each with its address and Copy, branch, last checked, problem, "Check for updates" and "Disconnect" (confirm names the repository). Under it, "Connect another repository" with the address field, hidden at ten. The field keeps class `setting__team`.
- Team packages: one section per repository, headed `owner/repo`, with "Check for updates" and its problem. A package held by another repository shows "Installed from owner/repo" and Install is off with that reason as its description. Then the two left-behind lists. With none connected, the page is as today.
- Propose to team: with more than one connected, a "Repository" select first; the package list follows it. With one, no select.
- The page reloads its status after every action.

**Window check:** connect two local test repositories; both sections show; install one package from each; the clash shows "Installed from" and a disabled Install; propose to the second and see its branch arrive there and not in the first; the pull request link of the second opens and a link for neither is refused; disconnect the first and its section goes while its installed package moves to "From repositories that are not connected". The check still fails on any console error, any control without a name, and any control under 24 pixels.

**Failure rows:** every Window row.

### Task 7: Documents, every check, review, landing

- `README.md`: the feature bullet, the "Team snippets" section, the route table, the MCP tool table, the `/state` row, and the note on what was rebuilt.
- `docs/specs/2026-10-06-team-snippets-design.md`: one line under "One repository at a time" and under "Not in this piece" pointing at the new design.
- `docs/specs/2026-10-07-several-team-repositories-design.md`: "Changed while building".
- Checks, all in this worktree: `npm test`, `npm run test:ui`, `npm run test:quit`, `npm run pack` then `npm run test:packaged`, `npm run test:espanso`.
- A fresh reviewer on the whole branch against the spec's failure rows. One fix pass.
- Fetch and compare `main` with `origin/main`, merge, push, read back.

---

## Self-review

- **Spec coverage.** Settings and address: 1. Package ownership and the clash rule: 2. Repositories: 3. Routes, channels, links: 4. Tools and cards: 5. Window: 6. Tests listed in the spec, documents and landing: 7.
- **Failure coverage.** Start: 1 and 3. Connect, Disconnect, Check for updates, Left behind, Match folder: 3. Install, Update: 2 and 4. Propose, Link: 4. Assistant: 5. Window: 6.
- **Names.** `key`, `id`, `teamRepositories`, `installedFrom`, `AMBIGUOUS` are spelled one way throughout.
