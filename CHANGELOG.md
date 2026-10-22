# Changelog

## v0.3.0

### Before you update
- **Update every device.** Saved logins can now carry a 2FA secret. If you edit a synced login on a
  device still running Corvus 0.2.0, that device saves the login without its 2FA secret and sync
  removes the secret everywhere. Update all your devices before you add 2FA secrets, and avoid
  editing logins on 0.2.0 in the meantime.
- **Self-hosted sync server**: update it as well to sync workflows and site memory. A 0.2.0 server
  does not know them yet: Corvus then keeps them on each device and everything else keeps syncing.
  Devices still on 0.2.0 simply ignore them, and pick them up when they update.

### Browser
- **Workflows and site memory sync**: saved workflows (recorded or saved from agent runs) and what
  Corvus learned about sites now sync end to end across your devices, each as its own category in
  Settings > Sync (on by default, per device; turning one off keeps that device's data). Edits
  follow the last change, run counts and learned hints add up across devices without counting
  anything twice, and deleting a workflow, "Forget this hint", "Forget this site" and "Forget
  everything" apply on every device, even one that comes back online with old data. Site memory
  never carries typed values, passwords, codes or credential fields; whether a device learns stays
  its own switch.
- **2FA codes**: add a time-based (TOTP) 2FA secret to a saved login by pasting an `otpauth://`
  link, importing a QR code image (decoded on your device) or typing the base32 secret. The
  secret is stored in the end-to-end encrypted vault and synced. `corvus://passwords` shows the
  live code with a countdown and a copy button, and warns that keeping the 2FA secret next to the
  password turns two factors into one. On a one-time-code field the key button offers the code.
- **KeePass, read-only**: add `.kdbx` files (KDBX 3.1 and 4) or a folder of them, with an
  optional key file. Unlock once, or keep a database unlocked with the master password wrapped by
  your system keychain. Databases auto-lock after the idle time in Settings > Passwords and when
  the screen locks, and are re-read when the file changes. Corvus never writes to them. Their
  logins and 2FA codes show up in autofill and on `corvus://passwords`.
- **Export to KeePass**: write your saved logins and their 2FA secrets to a new `.kdbx` file
  protected by a master password you choose. Existing files are never overwritten.
- **Auto sign-in** (opt-in per login): when the login page loads, Corvus asks once, then fills and
  submits the form. Never in tabs an agent is driving.

### For AI agents
- **`fill_login` and `fill_totp`**: the Command Bar agent and Full-access MCP clients can sign in
  and fill 2FA codes, but only when Settings > Passwords > "Let AI agents use logins you opt in" is
  on and the login itself is opted in (both off by default), and only after you approve each use.
  Corvus fills the value by reference: the password and the code never reach the model, tool
  results, transcripts, run history or logs. Without the opt-ins, 2FA is handed to you as before.
  CAPTCHAs are always handed to you.
- Agent page snapshots never include the value of password fields, one-time-code fields or fields
  Corvus filled with a secret, and fields filled for an agent are masked on screen.
- **Script lock after a fill**: once Corvus fills a saved password or 2FA code into a tab (agent
  sign-in, autofill or auto sign-in), agents cannot run scripts there or read raw page content
  (`evaluate`, `get_html`, `get_text`, `extract`, `find`, `pdf`, `run_workflow`) until the tab
  loads a new page. This applies to every agent at every access level; clicking, typing and the
  masked page snapshot keep working.
- **WebScope hides credential traffic from AI**: requests sent from a tab right after Corvus filled
  a saved password or 2FA code, and requests that carry such a value, are marked "Hidden from AI".
  You still see them in full in WebScope, with a badge. AI agents and MCP clients get them with the
  request body and the URL query values removed, in history and search, request detail, findings,
  the sitemap and the intercept queue.

### Project
- **Third-party notices**: the build writes `THIRD_PARTY_NOTICES.md` with the name, version,
  licence and licence text of every third-party package in the app, ships it next to the app and
  links it from Settings > Updates > Third-party software. The build fails on a licence outside
  MIT, ISC, BSD-2-Clause, BSD-3-Clause, Apache-2.0, MPL-2.0, 0BSD, Unlicense, Python-2.0 or
  BlueOak-1.0.0, and on any change to the accepted copyleft package below.
- **Licence of the binaries**: the Corvus source stays MPL-2.0. The installers and the packaged app
  include electron-chrome-extensions, which Corvus uses under GPL-3.0, so as a combined work they
  are distributed under GPL-3.0. The complete corresponding source is
  https://github.com/ParendumOU/Corvus. The notices file and the README say so.

## v0.2.0

The first open-source release of Corvus (MPL-2.0). Installers and automatic updates now come from
GitHub Releases of ParendumOU/Corvus.

### Browser
- **Split view**: tile two live tabs side by side, with a draggable divider and focus routing.
- **PDF viewer with AI**: an in-app pdf.js viewer with the reading AI suite and page citations.
- **Password manager**: an end-to-end-encrypted vault (same crypto as sync) with autofill,
  `corvus://passwords`, synced across your devices.
- **Annotations**: in-page highlights and notes (CSS Custom Highlight API), anchored by text quote
  and synced end to end.
- **Semantic search**: BM25 plus optional local embeddings over history, bookmarks and reading
  notes, at `corvus://find`.
- **Crash recovery**: a per-tab recovery page, restore after an unclean exit, and an opt-in local
  crash log.
- **Device sync and management**: reading notes, watches and workspaces now sync end to end; list
  and revoke devices at `corvus://devices`.
- **Settings search**: filter the settings and jump straight to the matching control.
- **Onboarding**: a first-run wizard for the AI provider, sync phrase, bookmark import and
  preferences.
- **Auto-update**: from GitHub Releases by default, or from a self-hosted feed set in
  Settings > Updates. A downgrade is only offered when a pre-release build switches back to Stable.

### AI
- **Local models**: Ollama and any OpenAI-compatible server, no API key needed. AI search, Assist
  and the reader work offline.
- **Persistent agent runs**: runs are saved and can resume mid-loop, with a history at
  `corvus://agent-runs`. Step previews now say which page the agent opened or read.
- **Scheduled agents**: cron or interval AI runs on the watches scheduler, with an
  unattended-approval gate.
- **Per-site AI profiles**: a per-domain prompt addendum and a narrower access cap for the agent
  on that site.
- **Recorded flows**: record a browser flow and replay it as an approval-gated macro at
  `corvus://flows`.

### For AI agents (MCP)
- **Remote MCP over Streamable HTTP**: bind to 127.0.0.1 or 0.0.0.0 with mandatory bearer auth;
  off by default.
- **Snapshot tool**: a read-only page artifact (screenshot, DOM outline and network).
- **Automation tools** at the Full access level, each approval-gated: `run_flow` (replay a saved
  recorded flow), cookies, `fill_fields` and `download`.
- **Corvus-MCP**: the connector now has its own MIT repo,
  [ParendumOU/Corvus-MCP](https://github.com/ParendumOU/Corvus-MCP), with setup for Claude Code,
  Claude Desktop, Cursor, VS Code, Zed, Cline, Codex CLI, Gemini CLI and any stdio client. The
  bundled bridge now ships the license notices of its dependencies.

### Project
- Source published under MPL-2.0, with `SECURITY.md` and `CONTRIBUTING.md`.
- Windows and Linux only. The installers are not code-signed yet, so Windows SmartScreen shows a
  warning on first run. macOS builds will follow.

## v0.1.1

- **Command bar (Ctrl/Cmd+K)**: a fast action palette (open tabs, history, bookmarks, settings,
  web search, internal pages) and an in-browser AI agent — type a task and Claude carries it out
  in a tab using the browser tools, with the live activity overlay, a step log, pause, and an
  approval prompt before risky actions (forms, logins, payments). Provider-agnostic agent loop
  (Anthropic API or local Claude Code), with step and token caps.
- **Reader mode + AI reading suite**: distraction-free reader (fonts, width, light/sepia/dark),
  Key points / TL;DR / Simplify / ELI5 / Translate with section citations, read-aloud, and a
  save-as-note library (corvus://reading) with Markdown export.
- **Vertical tabs, workspaces and page monitoring**: an Arc-style tab sidebar, named workspaces,
  and "Watch this page" with AI-summarised change alerts (corvus://watches).

## v0.1.0 — first preview

The first end-to-end build of Corvus, an AI-native browser that is also an MCP server.

### Browser
- Tabs and tab groups, profiles (isolated sessions), bookmarks with folders, history.
- Site permission prompts, downloads manager, find-in-page, per-site zoom, session restore.
- Chrome extensions (install from the Chrome Web Store) plus bookmarks/history/tabGroups/
  sessions/side-panel extension APIs.
- Built-in ad and tracker blocker with an address-bar shield (per-site and global toggles).
- End-to-end-encrypted sync (24-word recovery phrase) for bookmarks, history, settings,
  profiles, open tabs and extension suggestions, to a self-hostable server.

### AI
- AI search: a retriever (SearXNG/Brave/DuckDuckGo) plus one small-model call that returns a
  structured, cited answer with per-result AI ratings and summaries; News/Images/Videos tabs.
- Corvus Assist side panel: summarize page, ask about page, translate.
- AI tab organizer and a live agent-activity overlay.

### For AI agents (MCP)
- Local MCP server with a full browser toolset (visual + semantic control, forms, extract,
  dialogs, screenshots), three access levels (read-only / standard / full), and human handoff
  for CAPTCHAs/2FA (never solved automatically).
- Claude Code plugin with zero-config discovery.
- WebScope: a scope-gated, Burp-style web-traffic workbench, also exposed to agents.

### Build
- Fully Dockerized dev and release builds; Windows .exe (NSIS installer + portable) and Linux
  (AppImage + deb). GitLab CI runs tests and the headless smoke test on every push.
