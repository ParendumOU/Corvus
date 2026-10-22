# Roadmap

Corvus is an AI-native Electron browser that is also an MCP server, with AI search,
end-to-end-encrypted sync, and a full agent/automation toolset. This file tracks what
has shipped and where it goes next.

Last updated: 2026-10-21 · current release: **v0.1.1** · **15 features merged on `main`** since, unreleased

---

## Shipped on `main` since v0.1.1 (unreleased — next tag)

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
- [x] **Split view** — tile two live tabs, draggable divider, focus routing

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
- [x] Human handoff for CAPTCHA/2FA (never solved automatically)
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
- [ ] **Update-feed host** — wire auto-update's placeholder feed to a real host → *blocked on user*
- [ ] Settings search + settings reorg
- [ ] Bundle-size / startup pass — lazy-load `corvus://` pages, trim the ~431MB artifact
- [ ] Tag the next release once the above cert/host land (CHANGELOG + `vX`)

**AI depth (M3)**
- [ ] Per-site AI profiles — custom system prompt + allowed-tool set per domain
- [ ] Inline AI in form/text fields (rewrite, translate, draft) with approval
- [ ] Multi-tab agent tasks (agent coordinates across several tabs)

**Data portability (M4)**
- [ ] Full profile export / import (single encrypted bundle)
- [ ] Sync conflict resolution UI
- [ ] Sync command-bar history

**Automation (M5)**
- [ ] Scope-gated cookie-jar / form-fill / download MCP tools
- [ ] `run_flow` MCP tool (trigger a saved recorded flow from an agent)
- [ ] WebScope depth: active checks opt-in, match/replace rules UI, session export/import
- [ ] Per-tool audit log + rate limits surfaced in UI

**Platform & reach (M6)**
- [ ] Linux/macOS: ship AppImage/deb/dmg as release assets (depends on signing + mac runner)
- [ ] Mobile companion or remote-control — exploratory
- [ ] Evaluate Chromium fork vs Electron for full extension-API coverage
      (bookmarks/history/tabGroups/sidePanel chrome.* APIs unsupported under Electron)

---

## Open decisions (blocked on user)

1. **Code-signing cert** — Azure Trusted Signing vs an OV cloud-HSM cert. Needed for an
   un-warned Windows install. Self-signed test path already works.
2. **macOS runner** — need a mac (or hosted mac CI) to produce + notarize `.dmg`.
3. **Distribution target**: decided. Installers and the auto-update feed are GitHub Releases of
   ParendumOU/Corvus (see docs/RELEASE.md).

## Guiding principles

- **Local-first, E2E by default** — user data encrypted client-side; server is dumb storage.
- **Agent actions are gated** — risky steps (forms, logins, payments, CAPTCHA/2FA) always
  need human approval; nothing auto-solved.
- **Provider-agnostic** — Anthropic API, local Claude Code, and (M3) local models interchangeable.
- **pnpm only**, Dockerized builds, tests + smoke green before merge.
