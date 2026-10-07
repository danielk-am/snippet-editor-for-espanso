# Several team repositories: design

Status: approved by Daniel on 2026-10-07.

This extends `2026-10-06-team-snippets-design.md`. Everything there still holds unless this page says otherwise.

## Goal

Today the app connects to one team repository, and connecting another replaces the first. With this piece it connects to up to ten at once. Each keeps its own packages, its own update checks and its own proposals.

## Decisions already made

Daniel, 2026-10-07.

| Question | Answer |
| --- | --- |
| Should this be designed? | Yes, now. Built after the faster-assistant work, which has since landed on `main`. |
| Two repositories offer a package with the same name. What happens? | The second is refused while the first is installed. |

## How the name-clash decision was reached

Daniel was first asked what should happen when two repositories offer a package of the same name. The question said that Espanso has one packages folder and that a longer folder name might confuse Espanso's own package commands. That was wrong. Team packages are not in Espanso's `match/packages/`. They are in the app's own `match/team/<name>/`, which Espanso's package commands never look at.

So a folder per repository would have worked with Espanso. Its real cost is different: every team file's id would change, and every package already installed would have to move. "Refuse the second" keeps both as they are. The choice to refuse the second was confirmed with these corrected reasons before the design was approved.

| Way | For | Against |
| --- | --- | --- |
| **Refuse the second (chosen)** | `match/team/<name>/` and ids such as `team:goodbyes:package.yml` stay exactly as they are. Nothing installed today moves. The API, the MCP tools and the assistant keep naming a team file the same way. | Two teams that both publish `greetings` cannot both be installed. You remove one to install the other. |
| A folder per repository | No clash, ever. | Ids gain a repository part. Installed packages move to new folders. Saved conversations and anything outside the app that kept an id point at nothing. Espanso reading three folders deep is likely but unchecked. |

## Decided with this design

These were decided with the design and approved with it.

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

## Changed while building

| Change | Why |
| --- | --- |
| An install or an update that names no repository, for a name two repositories offer, means the one that already holds the name. The failure row "No repository named, and two offer the name" applies only while the name is free. | It is the only repository the request could succeed for: the name rule refuses every other. A damaged marker is held by none, so it is still asked which. |
| With any repository connected, `POST /team/refresh` always answers 200. A repository that could not be fetched says why in its own `problem`. The 502 `GIT_FAILED` moved to `POST /team/repositories/{id}/refresh`. With none connected it is 409, as before. | With several, one failure is not the failure of the request. A 502 only when exactly one is connected would make the status code depend on how many are connected. The pages check one repository at a time, so a failed check is still told. |
| `GET /team` also carries `problem`: the note about saved addresses that were skipped at start. | The design promised "a line naming the one that was skipped" and gave it no place in the reply. |
| A saved address the app refuses is named by its place in the list, never by its text: "Saved team repository 2 has an address the app does not accept, so it was skipped. Connect it again in Settings." A repeat names the address it repeats. | Carrying a password is one reason an address is refused, and this note travels to the API, the MCP tools and the assistant. The address a repeat names is one the app accepts. |
| A damaged marker shows as installed, with an update available, in every repository that offers its name. It is in the top-level `installedOnly` only when no connected repository offers the name. | The design says "as today" and "Update available". The plan's stricter sentence would have shown it as not installed. Listing it in both places would list it twice. |
| The MCP list's `installed_only` entries are `{ name, repository, installed_from }`. `repository` is an id, or null when that repository is not connected. `installed_from` is the address. | `repository` is an id everywhere else in that reply, and a repository that is not connected has none. |
| The MCP list names every connected repository in `repositories`, also when `repository` narrows the packages to one. The install tool's reply says which repository it installed from. | The list is where ids are read. |
| With several connected, the Propose dialog chooses no repository for you. The package list and Send are off until one is chosen. | A file sent to the wrong team cannot be taken back. Where more than one could be meant, it is asked. |
| "The team repository has no package named X." became "owner/repo has no package named X.", with one connected too. With several connected and none named, a name nobody offers answers 404 "No connected repository has a package named X." | With several, "the team repository" says nothing. One wording is easier to keep right than two. |
| `isTeamLink` did change: it refuses a link whose path holds an encoded slash, backslash or dot (`%2f`, `%5c`, `%2e`). | The design said it was unchanged. A review showed that `..%2f..%2fother` passed for a page of a connected repository and could open another's. The app makes no link with any of the three. |
| A card is for its repository under either form of its address. Disconnected and connected again by its SSH address, a card made for the HTTPS one still applies. | A repository is its host, owner and name, which is decision 1 of this design. The card's first check compared the address text. |
| Disconnect has to name a repository. With no id, or with anything that is not text, nothing is disconnected and the reply says so: "No repository was named, so nothing was disconnected." An id that is not connected still answers the list as it is. | For a while during the build, no id meant "the only one". An id that goes missing on its way must not take a repository with it, and a Disconnect that did nothing must not look done. |
| Every test gets its git through one guard, in `test/helpers/teamRemote.js`. It stops any address with no test repository behind it before git is called. A test fails if a test file or helper makes a git of its own, starts the service, a team or the backend without a `git` option, or runs the `git` program itself. The quit check and the packaged check start the whole app as a program, with no repository in its settings. The guard test names them, with that reason. | Twice during the build, git was handed a real address on github.com: once by a test on its first failing run, once by a reviewer's probe. Both failed and nothing was copied. The tests run the app with GitHub addresses, as it really runs, so the guard has to be certain. |
| Connecting the same address again runs no clone, fetch or ls-remote. It answers the status, which runs git's local reads of the copy. | The design says it "does nothing". Before, connecting again fetched. "Check for updates" copies a repository again if its copy has gone. |
| A connect that fails removes whatever was made for it. The setting is written only after the copy succeeds. | A failed connect used to leave an empty folder under `team/`. |
| A repository that is being disconnected fetches no more. A check that arrives then answers 409 `NOT_CONNECTED`, "That repository is being disconnected." | A check that waited behind the disconnect would find no copy and make one again, and nothing would list it. |
| The settings drop a repeat only when the text is the same. Two addresses of one repository both stay in the file, and the service skips the second and says so. | The settings cannot tell that two addresses are one repository. The service could not report an entry the settings had already dropped. |
| A repository's key leaves the port out. | An SSH port and an HTTPS port of one repository differ. |
| `repository` in a request must be text, and one that is named is always looked up. An id that is not connected is 404, also with none connected at all. | `null` or a number is the caller's mistake and is told so, with 400. A repository that is named and not there gets one answer, whatever else is connected. |
| The `AMBIGUOUS` message gives each repository's id and says what to send: "Two repositories offer goodbyes: acme/first (980ba86f6835) and acme/second (cda6f9e4bdce). Say which: set `repository` to one of the ids in brackets." | The design's wording named the repositories and not what to send. The same words reach an API caller and a model. |
| One function names a repository for a person, in `shared/repositoryLabel.js`. The limit of ten is in `shared/teamLimits.js`. | The window cannot load `core/`. A second copy of the name or of the number could drift. |
| The install card shows `Repository: owner/repo`. The send card shows the address in full. | The send card is where a file leaves the computer, and the full address says which host. |
| No install card is made for a name another repository holds. The refusal says so in the app's words. | A card that could only fail would have the assistant say "it is waiting for you". |
| In Settings, "Browse team packages" is one button in the card's heading. The Team page has no button that checks every repository at once. | In each repository's row it would be the same button several times. The design asks for a check per section. |
| Both pages read the status again whenever the app's picture of the folder changes, not only after their own actions. | That is what makes a section arrive or go while the page is open. |
| With none connected, the list of what is still installed is headed "From repositories that are not connected". It was "Still installed". | It is the same list whether or not anything else is connected. |
| The window check runs the app as it really runs, with GitHub addresses, and points git alone at folders. It also connects ten repositories, puts one out of reach, and leaves a page while a connect and a disconnect are under way. | The headings, the links and the pull request page are then the real ones. The Window rows above asked for the rest. |

Also mended, though not part of this piece: tests that asserted on the clock and failed on a busy machine. The runner's two limits are now measured from how long a node takes to start, the quit tests wait for turns of the event loop, the lookups are shown to run side by side without a clock, and the markdown reader's speed is measured as processor time. The window check's reload step waits for the app to say the answer has ended before it sends the next message.

## After review

Each layer was reviewed when it was finished, by a reviewer that had not written it. This is what each review found and what was done. Each fix came with a test that fails without it, in the unit tests or in the window check. The review of the whole branch comes after this page was written, and is not in it.

**Settings, addresses, packages and the service.** Nothing serious.

| Found | Done |
| --- | --- |
| The status passed on whatever text a marker file gave as its repository. A marker of 3 MB made a reply of 6 MB. | A marker's repository is read as an address where the marker is read. `installedFrom`, the top-level `installedOnly` and the refusal get an address the app accepts, or nothing. |
| No test showed that a sign-in written into a marker is never shown. | A test checks the status, `GET /team` and `GET /state` in four states. |
| No test showed that the repositories are fetched side by side at start. | A test holds the first back and expects the second to be fetched meanwhile. |

**Routes, channels, MCP tools and cards.** One finding that mattered, the first.

| Found | Done |
| --- | --- |
| `test/team.test.js` had no guard against an address reaching the real git. Had one refusal in the service regressed, two tests would have handed git real github.com addresses. | The one shared guard, described above. |
| A card's check that its repository is still connected compared the address text. | It compares the repository: host, owner and name. |
| "The team repository has no package named X" did not say which repository. | It names it. |
| `isTeamLink` let a link with an encoded slash or dot pass for a page of the repository. | Refused, as described above. |
| One test gave the start-up fetches five seconds and could look between two writes. | It waits for the fetch to have ended, for up to thirty seconds, and still fails if the fetches run one after another. |

**The window.** Six things were mended. Three more are left, and are under "Left as they are".

| Found | Done |
| --- | --- |
| A Disconnect whose id was `''`, `0`, `{}` or the like disconnected nothing and answered the list as if all were well. | Anything that is not text with something in it is refused with "No repository was named, so nothing was disconnected." |
| A name held by a repository that is not connected, and offered by two that are: a request that named none was asked which, and was then refused whichever it named. | The refusal comes at once, whichever repository is named or none, and says the holder is not connected: "A package named X is already installed from owner/repo, which is not connected. Remove it first, then install this one." The route, the MCP tool and the install card all say it. The same is done when the holder is connected and no longer offers the name. |
| With several connected, the Propose dialog put Repository first and opened with the keyboard in Summary. | It opens on Repository. With one connected it opens in Summary, as before. |
| After Disconnect was confirmed, the keyboard was left on the page behind: the button that was pressed goes with its entry. | It goes to the address field. If the disconnect failed, it goes back to that entry's Disconnect button. |
| A check for updates that failed in Settings showed a red line and did not read the status again. The repository's own "could not be reached" line came only at the next change, and then the same words were on screen twice. | The status is read again after a failure, as on the Team page, and the reason is said once, on the repository's own line. |
| Two repositories on different hosts with the same owner and name both read `acme/team`: in the Propose choice, the section headings, "Disconnect acme/team?" and "Installed from acme/team". | A repository on a host other than github.com is named with the host in front: `ghe.corp.example/acme/team`. On github.com it stays `owner/repo`. |

## Left as they are

- After a connect or a disconnect the settings file holds only the connected repositories. An entry written by hand that was refused or repeated is gone from the file then, and the note about it clears.
- An eleventh entry written by hand is dropped without a word. The place a skipped entry is given counts entries after the settings have dropped repeats and entries that are not text, which can differ from its place in the file.
- A status asked for while a repository is being removed can show a passing "not a git repository" problem for it.
- `team.refresh` is used only by tests now.
- A slow fetch of one repository can hold up connecting or disconnecting another for up to its time limit. Connecting and disconnecting run one at a time, as this design says.
- `repository: ""` is 404 over the API, and "must not be empty" in the tool's schema.
- The Settings card shows nothing while its first status loads, and hides itself if that fails.
- The Team page's load error has no retry, and a load failure after a first success is not shown.
- An error from one repository, such as "This repository is empty", does not name that repository when it reaches the API or the assistant.
- When a connected repository's copy has gone from disk, an install or a proposal answers "No team repository is connected." The step that helps is "Check for updates", which copies it again.
- An address may be up to 300 characters, and the form the app keeps can be longer: the short form gains 23. The settings drop entries over 300, so such a repository would connect and be gone at the next start. Real GitHub names are far shorter.
- Going back to the released app, which reads `teamRepository` only. Started on a settings file this version wrote with two repositories, it shows none connected and says nothing. The installed packages stay, and it lists them as still installed. An unrelated save there rewrites the file with `teamRepository: null` and no list. Opening this version again then shows none connected, every package under "From repositories that are not connected", and both copies still in `team/`. Connecting again restores everything. The released app cannot be changed now, and this version writes the list only. The README says so under "Team snippets".
- An AI tool left open across the update keeps its old MCP server process, which reads `team.packages` from the team reply. This version's reply has no such field, so `snippets_list_team_packages` fails with "Internal error", and `snippets_install_team_package` installs the package and then reports the same error. It mends when the AI tool restarts its MCP server. The README says so where it tells a person how to connect an AI tool.

Not checked:

- The usability check with a real model (`test/mcp-eval`). Its second repository and its questions 8 and 9 were written for this piece, and it has not been run since.
- Leaving a page while a repository is being checked for updates. The window check leaves the page while one is connecting and while one is disconnecting, which take the same path through the page.
- The line about a saved list that was edited by hand, as the two pages draw it. It needs a settings file changed before the app starts. Unit tests cover the note itself.
- Where the keyboard goes after a disconnect that failed. The window check covers the one that succeeds.

## Not in this piece

- Installing two packages of the same name from two repositories.
- Moving an installed package to another repository in one step. It is remove, then install.
- An order of preference between repositories.
- Hosts that are not GitHub.
- Anything the first team design left out.
