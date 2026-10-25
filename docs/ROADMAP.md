# Roadmap

Corvus is an AI-native Electron browser that is also an MCP server, with AI search,
end-to-end-encrypted sync, and a full agent/automation toolset. This file tracks what
has shipped and where it goes next.

Last updated: 2026-10-25 · current release: **v0.20.0** (Windows + Linux, unsigned) · Corvus for mobile **0.3.0** (Android preview)

---

## Shipped in v0.2.0

Built across five parallel subagent waves; each merged only on green unit tests + headless smoke.

- [x] **Auto-update** (electron-updater from GitHub Releases of ParendumOU/Corvus, or a
      self-hosted generic feed set in Settings)
- [x] **Local-model provider** — Ollama + OpenAI-compatible, no API key, offline AI search/assist/reader
- [x] **Password manager** — E2E vault (reuses sync crypto), autofill, `corvus://passwords`, synced
- [x] **Remote MCP over Streamable HTTP** — bind 127.0.0.1/0.0.0.0, mandatory bearer auth, off by default
- [x] **Scheduled agents** — cron/interval AI runs on the watches scheduler, unattended-approval gate
- [x] **PDF viewer + AI** — in-app pdf.js, reading AI suite with page citations
- [x] **Snapshot MCP tool** — read-only page artifact (screenshot + DOM outline + network)
- [x] **Semantic search** — BM25 + optional local embeddings over history/bookmarks/reading, `corvus://find`
- [x] **Crash recovery** — per-tab recovery UI, unclean-exit restore, opt-in local crash log
- [x] **Device sync + management** — E2E sync of reading/watches/workspaces, `corvus://devices`, revoke
- [x] **Persistent agent memory** — runs persist + true mid-loop resume, `corvus://agent-runs`
- [x] **Recorded flows** — record a browser flow → replay as an approval-gated macro, `corvus://flows`
- [x] **Onboarding** — first-run wizard (provider, sync phrase, bookmark import, prefs)
- [x] **Annotations** — in-page highlights + notes (CSS Custom Highlight API), text-quote anchors, E2E-synced
- [x] **Settings search**: filter settings and jump to the matching control
- [x] **Per-site AI profiles**: per-domain prompt addendum and narrowing access cap
- [x] **MCP automation tools**: `run_flow`, cookies, `fill_fields`, `download` (Full level, gated)
- [x] **Split view** — tile two live tabs, draggable divider, focus routing
- [x] **2FA codes (TOTP)**: RFC 6238 codes on saved logins (otpauth link, QR image decoded locally or
      base32 secret), live code on `corvus://passwords`, one-time-code autofill on click, and
      `fill_totp` / `fill_login` for agents only on opted-in logins after an approval prompt
- [x] **KeePass (read-only)**: KDBX 3.1/4 files or folders, key files, keep unlocked via the OS
      keychain, idle auto-lock, re-read on change; autofill, 2FA and agent sign-in from KeePass;
      export the built-in vault to a new `.kdbx`; opt-in auto sign-in that asks first

---

## Shipped (v0.1.0 → v0.1.1)

**Browser core**
- [x] Windows, tabs, tab groups, vertical tabs + workspaces (Arc-style sidebar)
- [x] Omnibox (URL vs search), navigation, per-site zoom, find-in-page
- [x] Bookmarks with folders, history, profiles (isolated session partitions)
- [x] Session restore, downloads manager, site-permission prompts, web context menus
- [x] Chrome extensions: load unpacked + install from Chrome Web Store
      (bookmarks/history/tabGroups/sessions/side-panel extension APIs)
- [x] Built-in ad/tracker blocker (Ghostery engine) + address-bar shield, per-site + global
- [x] Page monitoring — "Watch this page" with AI change alerts (`corvus://watches`)

**AI**
- [x] AI search: SearXNG/Brave/DDG retrievers + one small-model call → cited structured answer,
      per-result ratings/summaries, News/Images/Videos tabs
- [x] Corvus Assist panel: summarize / ask-about-page / translate
- [x] Command bar (Ctrl/Cmd+K): action palette + in-browser AI agent (tool-use loop, live
      overlay, step log, pause/resume, approval gate before risky actions)
- [x] Reader mode + AI reading suite (Key points / TL;DR / Simplify / ELI5 / Translate with
      citations), read-aloud, save-as-note library (`corvus://reading`) + Markdown export
- [x] AI tab organizer
- [x] Providers: Anthropic API + local Claude Code CLI (provider-agnostic), step/token caps

**For agents (MCP)**
- [x] Local MCP server, full browser toolset (visual + semantic control, forms, extract,
      dialogs, screenshots), three access levels (read-only / standard / full)
- [x] Every connector tool runs in Corvus itself (v0.16.0): coordinates and keys, reading and
      waiting, form controls, frames, page dialogs, uploads/PDF, handing a step to the person; clicks,
      keys and page questions that spend money ask the person first
- [x] CAPTCHA solving by the agent (checkbox, tile grids with the visual tools) with human handoff
      after two failed attempts or when the check needs a phone number or e-mail code; 2FA stays with
      the user, except codes the user
      opted in per login: `fill_totp` / `fill_login` fill them by reference after an approval prompt
- [x] Claude Code plugin with zero-config discovery (`~/.corvus/mcp.json` + bundled bridge)
- [x] WebScope workbench (scope-gated, Burp-style), also exposed to agents:
      capture, repeater, fuzzer/Intruder (pitchfork + payload rules + grep-extract + CSV),
      interactive intercept (hold/edit/forward/drop over CDP Fetch), passive findings
      (9 detectors), target sitemap

**Sync**
- [x] E2E-encrypted sync (24-word recovery phrase) to a self-hostable server:
      bookmarks, history, settings, profiles, open tabs, extension suggestions

**Build / CI**
- [x] Fully Dockerized dev + release; Windows NSIS installer + portable, Linux AppImage + deb
- [x] GitLab CI: tests + headless smoke on every push; package on tags/manual
- [x] Self-signed code-signing wired (CSC_LINK/CSC_KEY_PASSWORD)

---

## Remaining

Most of M2–M6 is merged (see the shipped block above). What's left:

**Ship-ready (M2)** — the gate to a real release
- [ ] **Trusted code-signing cert** — kills Windows SmartScreen → *blocked on user (see Open Decisions)*
- [ ] **macOS builds** on a mac runner (notarization) → *blocked on user*
- [x] **Update-feed host**: GitHub Releases of ParendumOU/Corvus
- [x] Bundle-size / startup pass: self-test code, the MCP server and the Anthropic SDK load on demand
      (window ready ~22% sooner); the PDF library ships once (installers ~20% smaller)
- [x] Cut v0.2.0 (unsigned Windows + Linux); signed builds follow once the cert and Apple ID land

**AI depth (M3)**
- [x] Inline AI in form/text fields (rewrite, translate, draft) with approval (v0.9.0)
- [x] Multi-tab agent tasks (agent coordinates across several tabs) (v0.9.0)

**Data portability (M4)**
- [x] Full profile export / import (single encrypted bundle) (v0.10.0)
- [x] Sync conflict resolution UI: changes another device replaced are kept and can be brought back
- [x] Sync command-bar history: "Recent" in the Command Bar, synced per device switch

**Downloads & switching**
- [x] Download manager: link grabber, package queue, parallel connections, checksums, and joining and extracting split archives with their password (v0.13.0); "Download with AI" and the `download_queue` MCP tools
- [x] File hosts in the background (JDownloader-style): MEGA (decrypted), MediaFire, Google Drive, Dropbox, OneDrive, WeTransfer, Gofile, Pixeldrain, Yandex Disk, SourceForge, 1fichier, KrakenFiles and XFileSharing hosts resolved without tabs, folders expanded, waits honoured, CAPTCHAs left to the person through "Open page"; "Add link to download queue" in the page menu
- [x] Default browser: register for web links and files, ask once per launch while it is not (v0.14.0)
- [x] Import from Chrome, Edge, Brave, Opera, Vivaldi and Firefox: bookmarks, history, open tabs with their groups, passwords from a CSV, search shortcuts and the extensions list (Settings > Import, welcome). Cookies are not imported: people sign in again with their imported passwords

**Automation (M5)**
- [ ] WebScope depth: active checks opt-in, match/replace rules UI, session export/import
- [x] Per-tool audit log + rate limits surfaced in UI (Settings → AI agents)

**Platform & reach (M6)**
- [~] Release assets: Windows installer/portable, Linux AppImage and deb ship with every release; macOS dmg waits on the Developer ID certificate and notarization
- [~] Mobile companion: Corvus for mobile 0.3.0, an Android preview (pair with a computer, tabs from your computers, pages sent both ways, ask Corvus through a paired computer, bookmarks, reading list, history, watched pages, notifications, English and Spanish); iOS once an Apple developer account is set up (docs/MOBILE.md)
- [x] Evaluate Chromium fork vs Electron for full extension-API coverage: stay on Electron and add
      the missing APIs in Corvus: a fork costs builds, a security cadence and a port out of scale
- [~] Extension APIs Corvus adds itself: `bookmarks`, `history`, `tabGroups` + `tabs.group`, `sessions`,
      `sidePanel`, `commands` shortcuts, `downloads` done; DNR at scale only if needed

**Privacy & connections (M7)** — next
- [x] Proxies per profile and per container (HTTP, HTTPS, SOCKS4/5, PAC), with sign-in, per-site rules,
      no fallback to direct and WebRTC kept on the proxy
- [x] Private windows: in-memory session per profile, no history, saved session, synced tabs or page
      index; downloads never saved to the list; out of reach of extensions and AI agents
- [ ] Tor: private windows over Tor with a bundled Tor client (new identity, .onion sites), like Brave
- [ ] VPN: WireGuard profiles in user space (no system driver or admin rights), per profile or container,
      with a kill switch when the tunnel drops
- [ ] DNS over HTTPS choice, WebRTC leak protection, and a connection check (IP, DNS, WebRTC leaks)

---

## Open decisions (blocked on user)

1. **Code-signing cert** — Azure Trusted Signing vs an OV cloud-HSM cert. Needed for an
   un-warned Windows install. Self-signed test path already works.
2. **macOS runner** — need a mac (or hosted mac CI) to produce + notarize `.dmg`.
3. **Distribution target**: decided. Installers and the auto-update feed are GitHub Releases of
   ParendumOU/Corvus (see docs/RELEASE.md).

## Guiding principles

- **Local-first, E2E by default** — user data encrypted client-side; server is dumb storage.
- **Agent actions are gated**: risky steps (forms, logins) need human approval while "Ask before
  risky actions" is on. Spending money (a "Buy now", "Place order" or "Pagar" click, Enter in a
  checkout or payment form) always asks, even with it off, in scheduled runs and saved workflows,
  and for MCP clients at every access level (a native Allow once / Deny dialog). CAPTCHAs are solved
  by the agent when they do not pass on their own, and go to the human after two failures or when
  they ask for a phone number or e-mail code; card and password fields still go to the human. 2FA codes go to the
  human too, unless the user opted that login in (global setting plus per-login switch, both off
  by default); then Corvus fills the code itself after an approval prompt and the agent never
  sees it.
- **Provider-agnostic** — Anthropic API, local Claude Code, and (M3) local models interchangeable.
- **pnpm only**, Dockerized builds, tests + smoke green before merge.
