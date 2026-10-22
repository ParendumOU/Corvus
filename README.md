# Corvus

Corvus is a desktop web browser built for working with AI. It is a full everyday browser, its
address bar answers searches with a short, cited AI summary, and it is also an **MCP server**:
Claude Code, Claude Desktop or any other MCP client can drive it in your own logged-in session,
with clear limits you control.

## Download

- Website: https://corvus.parendum.com
- All versions: [GitHub Releases](https://github.com/ParendumOU/Corvus/releases)

Windows (installer and portable) and Linux (AppImage and .deb). Installed copies update themselves
from GitHub Releases. Builds are not code signed yet, so Windows SmartScreen shows a warning on
first launch.

## Features

**Browser**
- Tabs, tab groups, vertical tabs, workspaces, split view and session restore
- Bookmarks with folders, history, profiles with separate sessions, downloads, site permissions
- Chrome extensions: load unpacked or install from the Chrome Web Store
- Built-in ad and tracker blocker (Ghostery engine), password manager, PDF viewer
- Reader mode, read aloud, highlights and notes on any page, "watch this page" change alerts
- End-to-end encrypted sync to a server you can host yourself (24-word recovery phrase)

**AI**
- AI search: results come from a retriever (self-hosted SearXNG, Brave or DuckDuckGo) and one
  small model call writes a short answer with citations, in your language
- Assist panel to summarize a page, ask about it or translate it
- Command bar (Ctrl/Cmd+K) with a built-in browser agent that asks before risky steps
- Scheduled agents, recorded flows you can replay, AI tab organizer, semantic search over your
  history, bookmarks and saved reading
- Providers: Anthropic API, your local Claude Code login, or local models (Ollama or any
  OpenAI-compatible server) with no API key

**For AI agents (MCP)**
- A local MCP server with the full browser toolset: open and read pages, click, type, fill forms,
  extract content, take screenshots and snapshots, search
- Three access levels: read-only, standard (default) and full (adds JavaScript, uploads,
  downloads and save as PDF)
- Tabs an agent is driving get an **AI** badge, an on-screen cursor and an activity timeline;
  you can pause agents at any time
- CAPTCHAs and two-factor prompts are handed to you, never solved automatically
- Off by default; local only unless you turn on remote access, which always needs a bearer token

## Connect an AI agent

In Corvus, open `corvus://settings`, go to **AI agents (MCP)** and turn on **Enable MCP server**.
The first time an agent connects, Corvus asks you to approve it. Then:

- **Claude Code**: this repo is a plugin marketplace.
  ```
  /plugin marketplace add ParendumOU/Corvus
  /plugin install corvus@corvus
  ```
- **Other MCP clients** (Claude Desktop, Cursor, VS Code, Windsurf, Zed and more): use the
  connector at [ParendumOU/Corvus-MCP](https://github.com/ParendumOU/Corvus-MCP), which has
  copy-paste setup for each client.

## Build from source

Only Docker is needed on the host. Corvus uses **pnpm only**; npm and npx are not used.

```sh
cp .env.example .env                                  # optional: API keys, ports
docker compose run --rm dev pnpm install
docker compose run --rm dev pnpm -r build
docker compose run --rm dev pnpm -r test
docker compose run --rm dev pnpm --filter @corvus/desktop test:smoke   # headless end-to-end test
```

Packages (written to `release/`):

```sh
docker compose --profile release run --rm builder          # Windows: setup + portable .exe
docker compose --profile release run --rm builder linux    # Linux: AppImage + .deb
```

macOS packages must be built on a Mac (`scripts/release.sh mac`). Code signing is described in
[docs/CODE-SIGNING.md](docs/CODE-SIGNING.md) and releasing in [docs/RELEASE.md](docs/RELEASE.md).

Optional services for AI search and sync:

```sh
docker compose up -d searxng sync-server   # SearXNG on :8898, sync server on :8797
```

Then open `corvus://settings` to pick an AI provider, enable the MCP server and set up sync.
The Claude Code CLI provider uses your own Claude Code login on that machine and is for personal
use only.

| Path | What |
|---|---|
| `apps/desktop` | Electron browser (tabs, omnibox, bookmarks, profiles, extensions, settings, agents) |
| `packages/shared` | Contracts shared by all packages |
| `packages/ai-engine` | Retrievers, AI providers, prompts, cache, language detection |
| `packages/mcp-server` | MCP server over the browser, plus the stdio bridge |
| `packages/sync-core` | End-to-end encryption and the sync client |
| `packages/webscope` | WebScope security workbench (capture, repeater, fuzzer, intercept) |
| `services/sync-server` | Self-hostable sync server (Fastify and SQLite, stores ciphertext only) |
| `integrations/claude-code` | Claude Code plugin (skill, command, bundled MCP bridge) |

More in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/ROADMAP.md](docs/ROADMAP.md).

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md). Please report security issues privately as described in
[SECURITY.md](SECURITY.md), not in public issues.

## License

Corvus is licensed under the [Mozilla Public License 2.0](LICENSE).
