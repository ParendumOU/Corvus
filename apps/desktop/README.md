# @corvus/desktop

The Corvus browser shell (Electron). Implements the `BrowserController` contract from `@corvus/shared` and bundles `@corvus/ai-engine`, `@corvus/mcp-server` and `@corvus/sync-core` into the main process.

## Commands

All commands run inside Docker from the repository root (pnpm only, never npm/npx):

```sh
docker compose run --rm dev pnpm install
docker compose run --rm dev pnpm -r build                       # packages first, then desktop
docker compose run --rm dev pnpm --filter @corvus/desktop typecheck
docker compose run --rm dev pnpm --filter @corvus/desktop test  # unit tests (vitest)
docker compose run --rm dev pnpm --filter @corvus/desktop test:smoke  # headless Electron E2E under Xvfb
docker compose --profile release run --rm builder               # Windows .exe -> release/
docker compose --profile release run --rm builder linux         # AppImage + deb
```

`test:smoke` starts Electron on a virtual display, drives the controller against a local page (open, snapshot, type, click, screenshot, groups, bookmarks, history), exercises site permission prompts (including agent-tab denial), downloads, find in page, zoom persistence and session restore, renders every internal page, starts the MCP server and writes screenshots to `out/smoke/`. It also loads a generated probe extension and checks install, service worker, toolbar action, popup, content scripts, `chrome.tabs` events for agent tabs, DNR blocking, enable/disable/remove, profile isolation and that extensions cannot reach `corvus://` pages.

Extension service-worker preloads only run with the Chromium sandbox on (electron/electron#54322). The smoke script runs Electron sandboxed as the unprivileged `node` user when the container has `CAP_SYS_ADMIN`; otherwise it falls back to `--no-sandbox` and reports those checks as `SKIP`:

```sh
docker compose run --rm --cap-add SYS_ADMIN dev pnpm --filter @corvus/desktop test:smoke
# live Chrome Web Store installs (uBlock Origin Lite, Dark Reader, Bitwarden; needs network):
docker compose run --rm --cap-add SYS_ADMIN -e CORVUS_SMOKE_CWS=1 dev pnpm --filter @corvus/desktop test:smoke
```

See [docs/EXTENSIONS.md](../../docs/EXTENSIONS.md) for the compatibility matrix.

### Marketing screenshots

`capture:marketing` records the website product shots from the real app: a fresh profile, dark theme, a 1600x1000 window at 2x, and a scripted no-network agent and Assist run against the demo pages in `capture/fixtures/` (served as `https://raven-outfitters.shop/...` and friends, capture mode only). Frames and a `manifest.json` land in `out/marketing/`. The first run downloads the UI fonts (Inter, JetBrains Mono, EB Garamond, Charis SIL) into `out/.capture-fonts/`.

```sh
docker compose run --rm dev sh -c "pnpm -r build && pnpm --filter @corvus/desktop capture:marketing"
# localized task text: out/marketing-es/, out/marketing-et/
docker compose run --rm -e CORVUS_CAPTURE_LANG=es dev pnpm --filter @corvus/desktop capture:marketing
docker compose run --rm -e CORVUS_CAPTURE_LANG=et dev pnpm --filter @corvus/desktop capture:marketing
```

`CORVUS_CAPTURE_TASK` overrides the task text, `CORVUS_CAPTURE_OUT` the output folder.

## Structure

```
src/main/             Electron main process
  index.ts            bootstrap: settings, profiles, windows, services, IPC
  window-manager.ts   windows + WebContentsView per tab, tab groups, closed-tab stack
  controller.ts       BrowserController implementation (used by the MCP server)
  page-scripts.ts     isolated-world scripts: readable text + interactive element refs
  profiles.ts         profile registry; each profile = own session partition + data dir
  stores.ts           bookmarks / history (JSON, per profile)
  extensions.ts       per-profile extension host: electron-chrome-extensions, Chrome Web Store
                      installs/updates, enable/disable, pinning, permission prompt, error log
  extension-windows.ts chrome.tabs/windows <-> Corvus tabs bridge, extension context menu
  search-service.ts   wraps @corvus/ai-engine, streams SearchEvents to corvus://search
  mcp-service.ts      wraps @corvus/mcp-server, client approval dialog, activity log
  sync-service.ts     SyncEngine per profile, auto-sync, device management; phrase in safeStorage
  sync-adapters.ts    one SyncEngine adapter per collection (Electron-free, tested end to end)
  permissions.ts      site permission requests/checks per profile; prompts are shown by the chrome UI
  site-settings.ts    per-profile remembered permissions and zoom levels (site-settings.json)
  downloads.ts        will-download per profile, downloads list, agent executable hold-back
  session-restore.ts  crash-safe session.json snapshots ("continue where you left off")
  protocol.ts         corvus:// internal pages
src/preload/          chrome.ts (browser UI), internal.ts (corvus:// pages), extension-sw.ts (extension
                      workers/pages: `browser` namespace mirror, default DNR rulesets). Web content gets none.
src/renderer/         React UI: tab strip + omnibox (permission prompt, site info, downloads, find bar),
                      newtab, search, settings, bookmarks, history, downloads, extensions
src/shared/           pure, unit-tested logic: omnibox classifier, tab strip, bookmark tree, suggestions,
                      permission decision table, zoom steps, downloads list, session serialization
test/                 vitest unit tests
build/                icons (regenerate with `pnpm --filter @corvus/desktop icons`)
```

## Sync

End-to-end encrypted through `@corvus/sync-core`'s `SyncEngine` (fingerprint diffing; push conflicts are applied remote-wins). Auto-sync runs on start, about 10 s after a local change (60 s max wait) and every 5 minutes (configurable). Open tabs, extensions and profile metadata are checked every 3 s and only cause a sync when they changed.

| Collection | What | Key |
|---|---|---|
| `bookmarks` | every bookmark/folder except the two fixed roots | bookmark id |
| `history` | title, last visit, visit count, favicon; merged per URL (newest visit wins, max count) | URL |
| `settings` | allowlist in `src/shared/sync-settings.ts`: theme, bookmarks bar, AI provider/model/retriever/language/answer length, ask-where-to-save, startup mode; SearXNG URL only with the opt-in | setting path |
| `profiles` | the profile's name and avatar color | single record `profile` |
| `open_tabs` | this device's web tabs (url, title, pinned, group) | device id |
| `extensions` | installed Chrome Web Store extension ids; shown elsewhere as suggestions, never auto-installed | device id |

Never synced: API keys, the MCP token and every `mcp.*` setting, the Claude CLI path, the downloads folder, the sync server URL, per-site permissions and zoom. `test/sync-settings.test.ts` fails if a new setting is not classified or a secret-looking key is allowlisted.

**Pair a phone** (`SyncService.pairingCode`): the QR code holds the sync server URL and the recovery phrase. A loopback server URL (`localhost`, `127.x`, `::1`, `0.0.0.0`) is replaced in the code, never in the profile's setting, by the computer's LAN IPv4 address (`phoneServerAddresses` in `@corvus/shared`: private ranges on real adapters, skipping virtual ones such as WSL, Hyper-V, Docker or VPNs; Wi-Fi/Ethernet first; Tailscale `100.64.0.0/10` offered as an alternative), and `main/pairing-address.ts` checks `<url>/healthz` from the computer (2.5 s, no credentials) so the page can warn when the server only listens on `127.0.0.1`.

**One chain = one profile.** A chain is joined from a local profile; that profile adopts the chain's name and avatar, and its bookmarks/history merge with the chain. Local profile ids never leave the device. Two local profiles on one device cannot join the same chain (refused); to sync several profiles, create one chain per profile. Settings are global to the install, so a device with two synced profiles publishes the same settings to both chains (last change wins). Turning sync off leaves the chain (this device's tabs/extension records are deleted and the device is removed); removing another device in Settings revokes it and deletes its records.

## Security model

- Chrome UI and internal pages: `contextIsolation`, `sandbox`, no `nodeIntegration`, typed IPC through preload only. Web content has no preload and no IPC.
- Agent-driven tabs show an **AI** badge; agents cannot open `corvus://`, `file:` or other non-http(s) URLs. New MCP clients need user approval.
- API keys and the sync recovery phrase are encrypted with Electron `safeStorage` (OS keychain / DPAPI). Without a keychain they are kept in memory only.
- Site permissions (camera, microphone, location, notifications, clipboard read, MIDI, pointer lock, idle detection, screen capture) are prompted by the chrome UI under the omnibox, never inside web content. Decisions can be remembered per profile and site (`corvus://settings/#site-permissions`). Non-secure origins (except localhost) and cross-origin frames get nothing; full screen is allowed without asking, except in agent tabs.
- Agent-driven tabs never get camera, microphone, location or screen capture, remembered "allow" decisions never apply to them, and tabs they open stay agent-driven. Programs they try to download are held back until the user clicks "Keep anyway".

### Extension trust model

Extensions are trusted by the user who installs them, as in Chrome, but they never see Corvus itself:

- They are installed per profile (own session partition and `Extensions/` folder); other profiles do not load them. Chrome Web Store installs (the store's button, or an ID/link on `corvus://extensions`) show Chrome's permission warnings first; `chrome.permissions.request` prompts again.
- The chrome UI runs in the default session, where no extension is loaded, and is not a tab, so `chrome.tabs` never lists it.
- `corvus://` pages: content scripts never match the scheme and `chrome.scripting` is refused by Chromium ("Cannot access contents of url"). Corvus also rejects extension attempts to open or navigate to `corvus://` (except the new tab page), `file:`, `chrome:` and `javascript:` URLs via `chrome.tabs.create/update` and `chrome.windows.create`; `fetch("corvus://…")` from an extension fails. Internal pages expose IPC only to their own top frame.
- The MCP bearer token lives in the settings file (outside every session) and is only rendered on `corvus://settings`, which extensions cannot script. The MCP server rejects requests whose `Origin` is not a loopback http(s) origin, so extension pages and workers cannot call it even with a token. Copying the `claude mcp add` command puts the token on the clipboard, where an extension with `clipboardRead` could read it.
- Inside web content, extensions get what their manifest grants: `<all_urls>` means read and change every website, exactly as in Chrome. Unpacked extensions skip the install prompt and never get `file://` access.

## Configuration

Settings live in `corvus://settings`. Environment overrides for development: `ANTHROPIC_API_KEY`, `CORVUS_AI_PROVIDER`, `CORVUS_AI_MODEL`, `CORVUS_RETRIEVER`, `CORVUS_SEARXNG_URL` (default `http://localhost:8898`), `BRAVE_SEARCH_API_KEY`, `CORVUS_SYNC_URL` (default `http://localhost:8797`), `CORVUS_USER_DATA`.
