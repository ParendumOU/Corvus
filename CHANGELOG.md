# Changelog

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
- **Recorded flows**: record a browser flow and replay it as an approval-gated macro at
  `corvus://flows`.

### For AI agents (MCP)
- **Remote MCP over Streamable HTTP**: bind to 127.0.0.1 or 0.0.0.0 with mandatory bearer auth;
  off by default.
- **Snapshot tool**: a read-only page artifact (screenshot, DOM outline and network).
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
