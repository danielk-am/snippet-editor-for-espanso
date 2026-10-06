# Local API: design

Status: approved by Daniel on 2026-10-06 and built on the `local-api` branch. Where the build differs from the text Daniel approved, the section "Changed while building" at the end says how and why.

This is the first of three connected pieces Daniel asked for on 2026-10-06, in the order he chose:

1. **Local API** (this document).
2. GitHub shared snippets, so a team can work on its organisation's snippets.
3. An MCP server, so AI tools can read and change local and GitHub snippets.

Pieces 2 and 3 get their own design documents. A short sketch of each is at the end so this one can be judged in context.

## Goal

Give the app one contract for everything it can do with snippets. The window uses that contract, and other tools on the same computer can use it too.

## Decisions already made

| Question | Daniel's answer |
| --- | --- |
| Build order | API, then GitHub, then MCP |
| Who can reach the API | Local HTTP on this computer, guarded by a token |
| How the window reaches it | The same routes and payloads, carried over the app's internal channel instead of a network socket |

Two things follow from the last answer:

- The token never enters the page, and the page needs no cross-origin permission.
- The HTTP listener can be **off by default**. It is switched on in Settings when you want other tools to use it.

## How it fits together

```
window ── internal channel ──┐
                             ├──▶ router ──▶ service ──▶ store ──▶ match files
other tools ── HTTP + token ─┘
```

| Piece | File | Job |
| --- | --- | --- |
| Service | `core/service.js` (moved from `electron/services.js`) | The operations themselves, over the store and settings. No Electron, no HTTP. |
| Router | `core/apiRouter.js` (new) | Takes `{ method, path, query, body }`, checks the input, calls the service, returns `{ status, body }`. Pure: no sockets. |
| HTTP listener | `core/apiServer.js` (new) | Node's built-in `http`. Checks the token and the guards below, reads the JSON body, then hands the request to the router. |
| Internal carrier | one IPC channel, `api:request` | Passes the window's request to the same router. |
| Window client | `renderer/lib/api.js` | Keeps its current function names, but each one now calls a route. |

No new dependency is needed.

Because both doors go through one router, a route cannot behave differently for the window and for outside tools.

## Routes

All under `/api/v1`. Bodies and replies are JSON. A file id is the id the app already uses, such as `local:base.yml` or `package:goodbyes:package.yml`, percent-encoded in the path.

| Method | Path | Does | Input | Success |
| --- | --- | --- | --- | --- |
| GET | `/state` | Match folder, files with their snippets, packages | none | 200 |
| GET | `/files/{id}` | One file, with its raw text and version | none | 200 |
| POST | `/files` | Create a file | `name`, `description?`, `prefix?` | 201 |
| PUT | `/files/{id}/details` | Change description and trigger prefix | `description`, `prefix`, `version` | 200 |
| PUT | `/files/{id}/raw` | Replace the raw YAML | `text`, `version` | 200 |
| DELETE | `/files/{id}` | Delete a file, keeping a backup | `?version=` | 200 |
| POST | `/files/{id}/snippets` | Add a snippet | `match`, `index?`, `version` | 201 |
| PUT | `/files/{id}/snippets/{index}` | Change a snippet | `match`, `version` | 200 |
| DELETE | `/files/{id}/snippets/{index}` | Remove a snippet | `?version=` | 200 |
| GET | `/search` | Search every file and package | `?q=`, `?limit=` | 200 |
| POST | `/yaml/preview` | Show a snippet as the YAML that would be written | `match` | 200 |
| POST | `/yaml/parse` | Turn YAML text into a value | `text` | 200 |
| POST | `/yaml/stringify` | Turn a value into YAML text | `value` | 200 |

Every write needs the `version` the caller last read, exactly as the window does today. A stale version is refused. That is what stops a script and the window from overwriting each other.

Errors always look the same:

```json
{ "error": { "code": "CONFLICT", "message": "base.yml changed on disk since it was opened. Reload it, then try again." } }
```

| Code | HTTP status |
| --- | --- |
| `INVALID`, `INVALID_NAME` | 400 |
| `UNAUTHORIZED` (missing or wrong token) | 401 |
| `FORBIDDEN` (failed a guard), `READ_ONLY` | 403 |
| `NOT_FOUND` | 404 |
| `METHOD_NOT_ALLOWED` | 405 |
| `CONFLICT`, `EXISTS` | 409 |
| `TOO_LARGE` | 413 |
| `UNSUPPORTED_TYPE` (body is not JSON) | 415 |
| `PARSE_ERROR` (the YAML would not parse), `UNREPRESENTABLE` (the reply holds a value JSON cannot carry) | 422 |
| `ERROR` (anything unforeseen) | 500, with a plain message and no stack trace |

## What stays out of the API

Choosing the match folder, showing a folder in Finder, and copying to the clipboard open native windows or touch the desktop. They stay on the window's own channel and cannot be called over HTTP. So do switching the listener on or off and replacing the token.

## The HTTP listener

- **Off by default.** Settings gets an "API for other tools" card with a switch, the address, a button that copies the token, a "Replace token" button, and a button that copies a ready-to-run `curl` example. The token itself is never displayed.
- **Address:** `127.0.0.1` only, never other network interfaces. Default port `27187`, changeable in Settings.
- **Token:** 32 random bytes, made on first use and kept in `api-token` in the app's data folder, readable only by you. Sent as `Authorization: Bearer <token>`. Every route needs it and there is no open health check, so a web page learns nothing from the listener beyond the fact that something is listening on that port.
- **Guards against web pages.** A browser tab on any site can send requests to `127.0.0.1`. Three things stop it:
  1. It cannot know the token.
  2. Any request that carries an `Origin` or `Sec-Fetch-Site` header is refused. Browsers add `Origin` to anything that can change data and `Sec-Fetch-Site` to every request; `curl`, scripts and the MCP server send neither.
  3. The `Host` header must be `127.0.0.1:<port>` or `localhost:<port>`, which blocks DNS rebinding.
  The listener sends no cross-origin headers at all.
- **Limits:** bodies up to 4 MB, 10 seconds to send headers, 30 seconds per request. A write that would leave a match file over 2 MB is refused with 413, because the app does not open files larger than that. The YAML helpers take up to 256 KB of text.

## Settings added

| Setting | Default | Meaning |
| --- | --- | --- |
| `apiEnabled` | `false` | Whether the HTTP listener runs |
| `apiPort` | `27187` | Its port |

## What could go wrong

| Path | Realistic failure | Handled how | Test | What the caller sees |
| --- | --- | --- | --- | --- |
| HTTP, any route | No token, or a wrong one | Refused before the router runs; compared in constant time | Server test | 401 `UNAUTHORIZED` |
| HTTP, any route | Request from a browser tab | Refused on the `Origin` header | Server test | 403 `FORBIDDEN` |
| HTTP, any route | DNS rebinding (odd `Host`) | Refused on the `Host` header | Server test | 403 `FORBIDDEN` |
| HTTP, body | Larger than 4 MB | Reading stops at the limit | Server test | 413 `TOO_LARGE` |
| HTTP, body | Not JSON, or broken JSON | Rejected before the router | Server test | 415 or 400 |
| HTTP, connection | Client sends headers very slowly | Node's header and request timeouts close it | Server test with a stalled socket | Connection closed |
| Router | Unknown path or wrong method | Explicit answers, never a fall-through | Router test | 404 or 405 |
| Router | Missing or wrong-typed input (`index` not a whole number, `match` not a mapping, `name` empty) | Checked per route before the service is called | Router test per route | 400 `INVALID` with the field named |
| Router | File id that does not parse, or points outside the folder | Existing store checks | Router test | 400 `INVALID_NAME` |
| Any write | Stale or missing `version` | Existing store check | Router test | 409 `CONFLICT` |
| Any write | Two callers write at once | Existing store queue: one lands, the other is refused | Router test with two simultaneous requests | One 200, one 409 |
| Any write | The edit cannot be proven exact | Existing refusal in `core/matchFile.js` | Router test | 400 `INVALID`, pointing to the raw editor |
| Any write | Package file, write-protected file, file that could not be opened | Existing store checks | Router test | 403 `READ_ONLY` |
| Listener start | Port already in use | Listener stays off; the window is unaffected because it does not use the socket | Server test that occupies the port first | Settings shows "Port 27187 is in use" |
| Listener start | Token file missing or unreadable | The file is read at every start; a new token is made and saved. If it cannot be saved, the listener stays off | Listener test | Old token stops working; "Copy token" gives the new one. If it cannot be saved, Settings says so |
| Token | Replaced while a script is running | Old token refused from that moment | Server test | 401 until the script uses the new token |
| Window | Request sent twice (double click on Save) | The second click is ignored while a save is in flight. A second request that does arrive carries the same, now stale, version | UI test | One save and one backup. A second request would get 409 |
| Window | App quits mid-request | The write is atomic, so the file is either the old or the new version | Existing store tests | Nothing half-written |
| Anything else | A bug throws inside a route | Caught at the router boundary and logged to the app's console | Router test with a failing service | 500 `ERROR`, plain message |

## How it will be tested

- **Router tests** (`test/apiRouter.test.js`): each route's success, and each row above that names the router, with expected values written by hand.
- **Listener tests** (`test/apiServer.test.js`): a real socket on a spare port. Token, `Origin`, `Host`, size and type limits, the stalled client, the port clash, a full write round trip, and a check that it is bound to `127.0.0.1` and nothing else.
- **Window test:** the existing end-to-end run must pass unchanged, since the window's behaviour should not change. One new step switches the listener on in Settings and reads `/state` over HTTP with the token.
- **Packaged-app test:** must pass unchanged.
- Tests are written first and watched to fail, as for the rest of the project.

## Not in this piece

- Running the API without the window.
- HTTPS, or access from other computers.
- Changing the match folder or other settings over HTTP.
- GitHub and MCP, which are the next two pieces.

## Changed while building

Each of these was decided during the build or after an independent review of it. None changes the three decisions at the top.

| Change | Why |
| --- | --- |
| The token is never displayed. Settings copies it for you. | The text above promised both that the token never enters the page and that Settings shows it. The first is the security promise, so it won. |
| Requests with a `Sec-Fetch-Site` header are refused too. | Browsers leave `Origin` off a plain cross-site GET, such as an image tag. The token still protects the data either way. |
| The claim that a web page "cannot even detect the app" is gone. | Any open port can be detected by timing. What holds is that a page cannot read or change anything. |
| A new error, `UNREPRESENTABLE` (422), over HTTP only. | YAML allows a number that is not finite and a structure that contains itself; JSON has no way to write either. The listener refuses such a reply as a whole. Sending it altered would hand a script data that is not in the file. The window is not affected. |
| A write that would leave a file over 2 MB is refused with 413. | The app opens files up to 2 MB. Before this, a larger save produced a file the app would then neither change nor delete. |
| The YAML helpers take up to 256 KB of text. | Checking a very large mapping holds up the whole app for seconds. |
| A file that cannot be opened is returned as a described, read-only record when read on its own. | It already was in the list of files. Writes to it answer 403, as the table above says. |
| A port held by a program listening on every address counts as in use. | On macOS the listener could otherwise open the same port on 127.0.0.1 and take that program's local callers. |
| A failure of the disk (full, permission denied, read-only) answers 500 with a sentence that says which. | The window now gets its errors from the router, and a bare "something went wrong" would have been a step back. |
| A double click on Save sends one request. | The second request used to be refused and reported as the file changing on disk. |
| The editor says "Saved" only after the window has re-read the folder. | An action taken straight after a save could start from the old version and be refused. This also made the end-to-end test fail now and then. |

Changed again while building the MCP server, after its review:

| Change | Why |
| --- | --- |
| One route needs no token: `GET /api/v1/proof?nonce=...`, which answers a number the caller chose with a keyed digest of it. | Another program can hold the app's port while the app is closed. A caller can now check who is listening before it sends the token. The answer gives nothing away about the token or the snippets. |
| A file holding a value JSON cannot carry is listed without its snippets and says why. Only other replies answer 422. | One such file used to make `/state` fail for every file. |

Known limits, not fixed here:

- A match file with tens of thousands of keys in one mapping is slow to open, in the window and over the API alike. The cost is in the YAML library's check for repeated keys. It was there before this work.

## Sketch of the next two pieces

These are not being approved here. They are listed so the API can be judged against what it has to carry.

**GitHub shared snippets.** As in the original: a team repository holds packages, each a folder with a `_manifest.yml`. The app keeps a clone in its data folder using the `git` already on the computer, with whatever SSH or HTTPS access you already have, so the app stores no credentials. You choose which packages to use; the app installs each as a managed, read-only copy under `match/packages/` and tells you when the repository has moved on. Changes go back as a pull request. It will add routes under `/api/v1/shared`. Its own design will settle how pull requests are opened and whether anyone may push directly.

**MCP server.** A small program an AI tool starts, offering tools that mirror these routes for local snippets and the GitHub ones. Its own design will settle whether AI may write by default or must be allowed to.
