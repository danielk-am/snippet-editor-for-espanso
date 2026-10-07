# Several team repositories: design

Status: draft for Daniel's approval. Written 2026-10-07. Nothing is built.

This extends `2026-10-06-team-snippets-design.md`. Everything there still holds unless this page says otherwise.

## Goal

Today the app connects to one team repository, and connecting another replaces the first. With this piece it connects to up to ten at once. Each keeps its own packages, its own update checks and its own proposals.

## Decisions already made

Daniel, 2026-10-07.

| Question | Answer |
| --- | --- |
| Should this be designed? | Yes, now. Built after the faster-assistant work, which has since landed on `main`. |
| Two repositories offer a package with the same name. What happens? | The second is refused while the first is installed. |

## A correction to what I told you when asking

I said Espanso has one packages folder and that a longer folder name might confuse Espanso's own package commands. That was wrong. Team packages are not in Espanso's `match/packages/`. They are in the app's own `match/team/<name>/`, which Espanso's package commands never look at.

So the other choice, a folder per repository, would work with Espanso. Its real cost is different: every team file's id would change, and every package already installed would have to move. "Refuse the second" keeps both as they are, which is why it is still what I recommend. If the corrected picture changes your answer, say so and I will redo the parts it touches.

| Way | For | Against |
| --- | --- | --- |
| **Refuse the second (chosen)** | `match/team/<name>/` and ids such as `team:goodbyes:package.yml` stay exactly as they are. Nothing installed today moves. The API, the MCP tools and the assistant keep naming a team file the same way. | Two teams that both publish `greetings` cannot both be installed. You remove one to install the other. |
| A folder per repository | No clash, ever. | Ids gain a repository part. Installed packages move to new folders. Saved conversations and anything outside the app that kept an id point at nothing. Espanso reading three folders deep is likely but unchecked. |

## Decided with this design

These are mine. Approving the design approves them.

1. **A repository is known by its host, owner and name**, not by the exact address typed. The HTTPS and SSH addresses of one repository are the same repository. Connecting the second form is refused, and it names the form already connected.
2. **A package belongs to the repository it was installed from.** The marker file has always recorded that. Until now nothing read it: a package was "installed" for whichever repository was connected, by name alone. From here, only its own repository shows it as installed or offers an update.
3. **Ten repositories at most.** Each still has its own limit of 200 packages.
4. **The API's team replies change shape.** `GET /team` answers a list of repositories. Nothing outside this repository is known to use these routes, and the app is at 0.1.0. The alternative, a second set of routes beside the old ones, would leave two ways to ask one question.
5. **Where a repository need not be named, it is not asked for.** With one repository connected, every call and every dialog works as it does today. With several, a call that could mean more than one is refused and told which to choose from.
6. **A package installed from a repository that is no longer connected stays installed and is listed apart, with its address.** It is not handed to another repository that happens to offer the same name. Remove it first, then install the other. Today such a package silently counts as the new repository's.
7. **File ids, the sidebar's Team group and search do not change.**

## What changes

| Piece | File | Change |
| --- | --- | --- |
| Settings | `core/settings.js` | `teamRepositories`, a list of addresses, replaces `teamRepository`. A saved `teamRepository` is read as a list of one and written in the new form at the next save. |
| Address | `core/teamAddress.js` | Adds a repository's `key` (host, owner and name, lower case) and its `id` (the twelve characters that already name its folder). `isTeamLink` is unchanged; the caller tries each connected repository. |
| Service | `core/service.js` | Holds a set of repositories. `connectTeam(address)` adds one. `disconnectTeam(id)` removes one. `teamStatus()` answers for all. `team(id)` finds one. |
| Team | `core/team.js` | A package's `installed` and `updateAvailable` are true only for the repository in its marker. Adds `installedFrom`, the other repository's address, when the name is taken. Refuses an install whose name another repository holds. |
| Installed packages | `core/teamPackages.js` | `install` refuses to overwrite a folder whose marker names another repository. |
| Router | `core/apiRouter.js` | The routes below. |
| MCP tools | `mcp/tools.mjs` | The three team tools gain `repository`. |
| Assistant cards | `core/chat/proposals.js` | The install card names and remembers its repository. Both cards check that their own repository is still connected. |
| Window | `electron/ipc.js`, `renderer/` | Settings lists repositories. The Team page groups packages by repository. The "Propose to team" dialog asks which repository when there is more than one. |

No new dependency. No change to how git is run.

## Repositories

- **Connecting** adds to the list. The same address again does nothing and answers its status. The other address form of a connected repository is refused. An eleventh is refused.
- **Disconnecting** takes the repository's id. It removes that repository's copy and leaves every other one alone. Its installed packages stay.
- **Checking for updates** can be asked of one repository or of all. At start the app fetches all of them in the background, each with its own time limit. One that cannot be reached is marked with its problem; the others list as usual.
- **Each repository has its own queue**, as now, so a slow fetch of one does not hold up another. Connecting and disconnecting still run one at a time.

## Packages

For each package of a repository the app reports what it does today, with two differences.

| Field | Meaning now |
| --- | --- |
| `installed` | Installed, and from this repository. |
| `updateAvailable` | Installed from this repository, and its content there has changed. |
| `installedFrom` (new) | The address of the other repository this name is installed from. Empty when it is free or is this repository's own. |

- **Install** needs the name to be free, or already this repository's. Otherwise: "A package named X is already installed from owner/repo. Remove it first, then install this one."
- **Remove** is still by name, since a name is installed once. It works whether or not the package's repository is connected.
- **A marker that cannot be read** names no repository. As today, the package shows as needing an update, and installing it again from any repository that offers it repairs it.
- **Left behind.** A package whose repository is connected but no longer offers it is listed under that repository as "no longer in the repository". A package whose repository is not connected is listed under "From repositories that are not connected", with the address.

## Proposals

A proposal goes to one repository. With one connected, nothing changes. With several, the dialog starts with "Repository", then offers that repository's packages and "A new package". A new package may use a name that exists in another repository: it is that repository's own namespace.

The pull request link is opened only if it lies inside the pages of a repository that is connected at that moment. Today a link kept on an applied card stops opening as soon as a different repository is connected. With several, it opens for as long as its own repository stays connected.

## Routes

All under `/api/v1`. `{id}` is a repository's id from `GET /team`.

| Method | Path | Does | Change |
| --- | --- | --- | --- |
| GET | `/team` | `{ connected, repositories: [...], installedOnly: [...] }`. Each repository carries what the whole reply carries today, plus `id`; its own `installedOnly` holds packages it no longer offers. The top-level `installedOnly` holds packages whose repository is not connected, each as `{ name, repository }`. | Shape |
| POST | `/team/refresh` | Fetches every repository, then the same reply as `GET /team` | Now all |
| POST | `/team/repositories/{id}/refresh` | Fetches one | New |
| PUT | `/team/packages/{name}/installed` | Installs or updates. Body `repository?`, `acceptCommands?`. Without `repository` it works when exactly one connected repository offers that name. | Gains `repository` |
| DELETE | `/team/packages/{name}/installed` | Removes the installed copy | None |
| POST | `/team/proposals` | Body gains `repository?`, needed when more than one is connected | Gains `repository` |

`/state` keeps `teamConnected`, true when at least one repository is connected.

New error code: `AMBIGUOUS` (409), with the repositories to choose from in the message. `NOT_FOUND` (404) covers an id that is not connected.

Connecting and disconnecting stay on the window's own channel. `team:disconnect` now carries the id.

## MCP tools and the assistant

| Tool | Change |
| --- | --- |
| `snippets_list_team_packages` | Each package carries `repository`. The reply lists `repositories` with their ids, addresses and problems. An optional `repository` narrows it. Paging runs across all of them. |
| `snippets_install_team_package` | Optional `repository`. If the name is offered by more than one, the error says so and lists them. |
| `snippets_propose_to_team` | Optional `repository`, needed when more than one is connected. |

In the assistant, the install card gains a line, "Repository: owner/repo", and remembers it. At Apply it is refused as stale if that repository has been disconnected, no longer offers the package, or the name has meanwhile been installed from another. The send card already remembers its repository; its check now asks "is that repository still connected" and no longer "is it the one connected".

## The window

- **Settings.** The Team card lists each connected repository: its address with Copy, its branch, when it was last checked, any problem, "Check for updates" and "Disconnect". Under the list, "Connect another repository" with the address field, until there are ten.
- **Team packages.** One section per repository, headed by its owner and name, with "Check for updates" and any problem. A package whose name is installed from another repository shows "Installed from owner/repo" and its Install button is off, with the reason. Below the sections, the two kinds of left-behind packages.
- **Propose to team.** As described above.
- **Sidebar, search, the command palette.** Unchanged.

With one repository connected, the Team page shows one section and the dialog shows no repository choice, so nothing looks different from today except the section heading.

## What could go wrong

Rows of the first team design carry over with their tests. These are for what is new.

| Path | Realistic failure | Handled how | Test | What you see |
| --- | --- | --- | --- | --- |
| Start | The settings file still holds `teamRepository` | Read as a list of one; saved in the new form at the next save | Settings test | Your repository, connected as before |
| Start | The list holds an address the app refuses, or the same repository twice (edited by hand) | That entry is skipped and reported; the rest load | Service test | The others, and a line naming the one that was skipped |
| Start | One repository cannot be reached | Each fetch fails on its own, in the background | Service test with one remote gone | The others list. That one says when it last succeeded and why not now. |
| Connect | The same address again | Nothing is copied twice | Service test | Its status, unchanged |
| Connect | The other address form of a connected repository | Refused before git runs | Address and service tests | "This repository is already connected, as <address>." |
| Connect | An eleventh | Refused before git runs | Service test | "Ten repositories are connected. Disconnect one first." |
| Connect | Two different repositories at the same moment | One at a time | Service test with two calls at once | Both connected |
| Connect | It fails | The list is as it was. Other repositories are untouched. | Service test with one already connected | The reason, and the others still there |
| Disconnect | An id that is not connected, or pressed twice | The second finds it gone | Service and router tests | The current list |
| Disconnect | While that repository is fetching or sending a proposal | It waits its turn. Others keep working. | Service test | Disconnected once the running step ends |
| Check for updates | One of several fails | The rest are fetched. The failure is recorded on that one. | Service test | One section with a problem line |
| Install | The name is installed from another repository | Refused, in `team.js` and again in `teamPackages.js` | Team and package tests | The message naming the other repository |
| Install | Two repositories' packages of one name installed at the same moment | Installs run one at a time; the second meets the rule above | Package test with two calls at once | One installed, one refused |
| Install | No repository named, and two offer the name | 409 `AMBIGUOUS` | Router and tool tests | "Two repositories offer X: A and B. Say which." |
| Install | No repository named, and one offers it | Installed from that one | Router test | Installed |
| Install | The marker names no repository (damaged) | Any repository offering the name may repair it | Package test | "Update available"; installing finishes it |
| Update | Another repository offers a newer package of the same name | It is not this package's update | Team test | No update shown there; "Installed from ..." instead |
| Left behind | The package's repository is not connected | Listed apart with its address; removable | Service test | "From repositories that are not connected" |
| Propose | No repository named with several connected | Refused before git runs | Router and tool tests | "Say which repository", with the list |
| Propose | The repository named is not connected | 404 | Router test | "That repository is not connected." |
| Assistant | A send card's repository was disconnected before Apply | Stale | Proposals test | "Ask again." Nothing is sent. |
| Assistant | Another repository was connected after a card was made | Not stale: the card names its own | Proposals test | The card applies |
| Assistant | An install card's repository was disconnected, dropped the package, or the name was taken meanwhile | Stale, or the install rule's refusal | Proposals test, each case | The card says why. Nothing is installed. |
| Link | A pull request link for a repository disconnected since | Refused | Channel test | "That link is not part of a connected repository." |
| Link | A link inside any connected repository's pages | Opened | Channel test with two connected | The browser opens |
| Window | The Team page is open while another window action disconnects a repository | The page reloads its status after every action | Window check | That section goes |
| Window | You leave the page while a repository is connecting or being checked | The work finishes in the background | Window check | The result is there when you come back |
| Window | Ten repositories, each with many packages | Sections are listed one under another; each loads from the cached listing | Window check with ten small remotes | A long page that scrolls |
| Match folder | It changes while several are connected | Every repository is set up again for the new folder, as one is today | Service test | Packages are installed into the new folder |

## How it will be tested

- Unit tests with real `git` against repositories made in a temporary folder, as now. The helper already makes independent remotes.
- Every test the survey found that asserts one repository is rewritten for the list. The test "connecting another repository replaces the first" becomes "connecting another keeps the first".
- The window check connects two repositories, installs from each, meets the name clash, proposes to the second, and disconnects the first.
- The real Espanso check is unchanged, since `match/team/<name>/` is unchanged. It is run to show that.
- The packaged check and the quit check must pass unchanged.
- Tests are written first and watched to fail.

## Not in this piece

- Installing two packages of the same name from two repositories.
- Moving an installed package to another repository in one step. It is remove, then install.
- An order of preference between repositories.
- Hosts that are not GitHub.
- Anything the first team design left out.
