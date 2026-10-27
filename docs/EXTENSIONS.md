# Chrome extensions in Corvus

Corvus (Electron 44, Chromium 146) runs Chrome extensions through three layers:

1. **Electron's native extension system**: loading, content scripts, MV3 service workers and the `chrome.*` APIs Chromium implements for Electron.
2. **electron-chrome-extensions 4.9.0**: `chrome.tabs`/`windows` events, actions and popups, context menus, notifications, cookies, permissions, `webNavigation`, injected through a preload into extension pages and service workers.
3. **electron-chrome-web-store 0.13.0**: "Add to Corvus" on chromewebstore.google.com, CRX download/verification and updates.

Corvus adds per-profile management (enable/disable, pin, remove, error log), a Chrome-style permission prompt, the toolbar and puzzle menu, `corvus://extensions`, hardening of the tab/window APIs and two compatibility fixes (see below). The [trust model](../apps/desktop/README.md#extension-trust-model) is documented with the desktop app.

## Tested extensions

Live run: `docker compose run --rm --cap-add SYS_ADMIN -e CORVUS_SMOKE_CWS=1 dev pnpm --filter @corvus/desktop test:smoke` (installs through the same code path as "Install" on `corvus://extensions`; screenshots in `apps/desktop/out/smoke/cws-*.png`).

| Extension | Version | Install + prompt | MV3 worker | Toolbar action | Popup | Content / network |
|---|---|---|---|---|---|---|
| uBlock Origin Lite | 2026.1018.2229 | pass (2 warnings) | pass | pass | pass (filtering-mode UI) | **fail**: rulesets report enabled, ads still load |
| Dark Reader | 4.9.133 | pass (1 warning) | pass | pass | pass (full UI) | pass: page restyled (`rgb(24, 26, 27)` background) |
| Bitwarden | 2026.10.0 | pass (5 warnings) | pass | pass | pass (login screen, 480×600) | not asserted (autofill needs a vault) |
| Corvus Probe (generated, offline) | 1.0.0 | pass (unpacked) | pass | pass | pass | pass: content script, messaging, static DNR rule, tab events |

Also verified for every run: enable/disable (worker restarts, content scripts stop), unpin/pin and the puzzle menu, options page in a tab, remove, update check against Google's update service, per-profile isolation (a second profile sees no extensions).

Errors captured on `corvus://extensions` during the live run: Dark Reader logs an unknown CSP directive `navigate-to` (harmless); Bitwarden logs "Receiving end does not exist" while no popup is open (harmless). Before the fixes below, uBlock Origin Lite's worker crashed on start.

## Compatibility fixes in Corvus

- **`browser` namespace**: Chromium exposes `browser` as an object separate from `chrome`. electron-chrome-extensions only extends `chrome`, so extensions that use `browser.permissions`, `browser.windows`, … (uBlock Origin Lite) crashed. A Corvus preload mirrors the added APIs.
- **Static DNR rulesets**: Electron never enables the rulesets a manifest marks `"enabled": true`. The Corvus worker preload enables them once per installed version.
- **Worker start**: workers are started for extensions loaded from a previous run, after a grace period so a fresh registration is not interrupted.
- **`tabs.query({currentWindow})`** maps to the last focused window; `index`, `pinned` and `groupId` reflect the Corvus tab strip.

## chrome.* API support

Probed in a live MV3 worker (`typeof chrome.<ns>`), plus the library sources.

| API | Status | Notes |
|---|---|---|
| `runtime`, `i18n`, `storage` (`local`, `session`; `sync`/`managed` map to `local`) | native | messaging between content scripts, pages and the worker works |
| `scripting`, `tabs` (query, update, create, remove, reload, sendMessage, executeScript) | native + library | events `onCreated/onUpdated/onRemoved/onActivated` include agent tabs |
| `windows` | library | `create` opens a normal Corvus window (`type: "popup"` is not honoured) |
| `action` / `browserAction` | library | badges, titles, popups; `setIcon` with `imageData` unsupported in MV3 |
| `declarativeNetRequest` | native | dynamic/session rules and small static rulesets block; large rulesets (uBO Lite) do not (open issue) |
| `alarms`, `idle`, `offscreen`, `management` (read), `webRequest` | native | `webRequest` is shadowed when the app sets `session.webRequest` handlers |
| `contextMenus`, `notifications`, `cookies`, `permissions`, `webNavigation` | library | |
| `commands` | library + Corvus | the manifest's suggested shortcuts work in tabs and the browser bar (Ctrl is Command on macOS); a shortcut Corvus already uses stays Corvus's and `getAll` reports it empty; `_execute_action` opens the toolbar button; global shortcuts are not offered |
| `bookmarks`, `history`, `tabGroups` + `tabs.group`/`ungroup`, `sessions`, `sidePanel` | Corvus | over the profile's own bookmarks, history, tab groups, recently closed tabs and other devices' tabs from sync, and a side panel docked on the right under a bar with the extension's name and ✕ (one per window; `openPanelOnActionClick` makes the toolbar button toggle it) (all methods; events for changes made anywhere: the person, sync, an extension); extensions may bookmark or add http(s), ftp and file addresses only; `history.getVisits` returns the last visit Corvus keeps |
| `downloads` | Corvus | over the profile's download list: `download` (GET only; `filename` stays inside the downloads folder), `search`, `pause`/`resume`/`cancel`, `erase`, `show`, `showDefaultFolder`, `getFileIcon`, and `onCreated`/`onChanged`/`onErased` for every download; programs an extension asks for wait for the person like an agent's, `acceptDanger` is refused, `open` (needs `downloads.open`) never opens a program; `removeFile` and `onDeterminingFilename` are not supported |
| `topSites` | Corvus | the most visited sites from the profile's history |
| `privacy` | stubs | calls resolve without effect |
| `userScripts`, `fontSettings`, `proxy`, `identity`, `search`, `tts`, `system.*`, `declarativeContent` | missing | `typeof` is `undefined`; the extension card lists the ones a manifest asks for |

## Known gaps vs Chrome

- Service-worker preloads (all library APIs inside MV3 workers) need the Chromium sandbox: under `--no-sandbox` (Linux root, CI containers) workers only see native APIs (electron/electron#54322). Packaged Windows/macOS builds run sandboxed.
- uBlock Origin Lite installs, runs and shows its popup but does not block ad requests: its six default rulesets report as enabled and 949 dynamic/session rules exist, yet requests to `googlesyndication.com`/`doubleclick.net` load, also from a real site. A 1-rule static ruleset blocks fine, so large static rulesets are likely not indexed (or exceed a rule budget Electron does not allocate). Candidate for a Corvus-side DNR engine on `session.webRequest` or the Chromium fork.
- No `chrome.userScripts`: uBO Lite's custom filters and userscript managers lose that feature.
- `activeTab` grants are not tracked; extensions rely on their host permissions.
- `options_ui` always opens in a tab (no embedded dialog); `windows.create({type: "popup"})` opens a normal window.
- MV2 extensions still load (Electron supports them) but the store no longer serves most.
- Extension action context menu items (`contexts: ["action"]`) are not shown; Corvus shows its own Pin / Options / Remove / Manage menu.

These gaps (DNR at scale, side panel, user scripts, tab groups, sandbox-independent worker APIs) are the main arguments for the Chromium fork in [ARCHITECTURE.md](ARCHITECTURE.md).
