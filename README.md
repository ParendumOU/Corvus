# Corvus

Corvus is a desktop web browser built for working with AI. It is a full everyday browser, its address bar answers searches with a short, cited AI summary, and it is also an **MCP server**: Claude Code, Claude Desktop or any other MCP client can drive it in your own logged-in session, with clear limits you control.

## Download

- Website: https://corvus.parendum.com
- All versions: [GitHub Releases](https://github.com/ParendumOU/Corvus/releases)

Windows (installer and portable) and Linux (AppImage and .deb). Installed copies update themselves from GitHub Releases. Builds are not code signed yet, so Windows SmartScreen shows a warning on first launch.

## Features

**Browser**
- Tabs, tab groups, vertical tabs, workspaces, split view and session restore
- Bookmarks with folders, history, profiles with separate sessions, downloads, site permissions
- Chrome extensions: load unpacked or install from the Chrome Web Store
- Built-in ad and tracker blocker (Ghostery engine) that also rejects cookie banners for you (DuckDuckGo Autoconsent) and sends Global Privacy Control, password manager with 2FA codes and read-only KeePass (.kdbx) support, PDF viewer
- Reader mode, read aloud, highlights and notes on any page, "watch this page" change alerts
- End-to-end encrypted sync with your phone and other computers, with nothing to set up: the sync server is built into Corvus (or run your own)

**AI**
- AI search: results come from a retriever (self-hosted SearXNG, Brave or DuckDuckGo) and one small model call writes a short answer with citations, in your language
- Assist panel to summarize a page, ask about it or translate it
- Command bar (Ctrl/Cmd+K) with a built-in browser agent that asks before risky steps, and always before spending money
- Scheduled agents, recorded flows you can replay, AI tab organizer, semantic search over your history, bookmarks and saved reading
- Providers: Anthropic API, your local Claude Code login, or local models (Ollama or any OpenAI-compatible server) with no API key

**For AI agents (MCP)**
- A local MCP server with the full browser toolset: open and read pages, click, type, fill forms, extract content, take screenshots and snapshots, search
- Three access levels: read-only, standard (default) and full (adds JavaScript, uploads, downloads and save as PDF)
- Tabs an agent is driving get an **AI** badge, an on-screen cursor and an activity timeline; you can pause agents at any time
- CAPTCHAs are solved by the agent when Corvus does not pass them on its own: it clicks the checkbox and works through tile grids with the screenshot and coordinate tools, and hands the check to you after two failed attempts or when it asks for a phone number or e-mail code. Two-factor prompts are handed to you too, unless you let agents use the 2FA code of a specific saved login: then Corvus fills the code itself after you approve, and the agent never sees it
- Off by default; local only unless you turn on remote access, which always needs a bearer token

## Sync your devices

Corvus syncs bookmarks, history, open tabs, the reading list, saved logins and more between your computers and the Corvus app on your phone. Everything is end-to-end encrypted with a key only your devices have (a 24-word recovery phrase): whatever stores it can only see ciphertext. There is no Corvus cloud: your data stays on your own devices, or on a server you run.

**This computer (recommended, nothing to set up)**

1. In Corvus, open Settings, then Sync (or the welcome screen's Sync step), keep **This computer** and click **Generate phrase**. Write the 24 words down somewhere safe, then **Turn on sync**.
2. On Windows, Windows asks whether Corvus may use your network: allow **Private networks**, so your phone can reach this computer.
3. Click **Pair a device…**. On your phone, in the Corvus app, choose **Pair with a computer** and scan the QR code. Done.
4. Another computer: click **Copy code** under the QR code and paste it in Corvus on that computer (Settings, Sync, Join an existing chain).

The sync server runs inside Corvus on this computer. Your devices sync with it when they are on the same Wi-Fi (or the same Tailscale network) and Corvus is open here. Away from home, or while this computer is off, the phone keeps your changes and sends them the next time it can reach it. If the phone cannot connect, the pairing panel has a **Phone cannot connect?** button that checks the usual causes (Windows set to a Public network, a firewall rule that blocks Corvus, a guest Wi-Fi) and says how to fix each.

**Your own server (sync from anywhere)**

Run the Corvus sync server on a computer that is always on and reachable from your devices: a VPS, a NAS, a home server. It is one small Docker container that stores only ciphertext. A ready `docker-compose.yml`:

```yaml
services:
  corvus-sync:
    build: { context: ./Corvus, dockerfile: services/sync-server/Dockerfile }
    ports: ["8787:8787"]
    volumes: ["corvus-sync:/data"]
    restart: unless-stopped
volumes:
  corvus-sync:
```

Put it behind HTTPS (Caddy, Traefik or nginx) when it is reachable from the internet. Then in Corvus, Settings, Sync, choose **Your own server**, enter its address (for example `https://sync.example.org`) and click **Check**. Already syncing on This computer? **Move to your own server** uploads your data there (still encrypted) and your other devices follow it on their own the next time they sync; **Move to this computer** does the opposite. Details: [services/sync-server/README.md](services/sync-server/README.md).

## Connect an AI agent

In Corvus, open `corvus://settings`, go to **AI agents (MCP)** and turn on **Enable MCP server**. The first time an agent connects, Corvus asks you to approve it. Then:

- **Claude Code**: this repo is a plugin marketplace.
  ```
  /plugin marketplace add ParendumOU/Corvus
  /plugin install corvus@corvus
  ```
- **Other MCP clients** (Claude Desktop, Cursor, VS Code, Windsurf, Zed and more): use the connector at [ParendumOU/Corvus-MCP](https://github.com/ParendumOU/Corvus-MCP), which has copy-paste setup for each client.

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

macOS packages must be built on a Mac (`scripts/release.sh mac`). Code signing is described in [docs/CODE-SIGNING.md](docs/CODE-SIGNING.md) and releasing in [docs/RELEASE.md](docs/RELEASE.md).

Optional services for AI search and sync:

```sh
docker compose up -d searxng sync-server   # SearXNG on :8898, a self-hosted sync server on :8797 (optional: Corvus has one built in)
```

Then open `corvus://settings` to pick an AI provider, enable the MCP server and set up sync. The Claude Code CLI provider uses your own Claude Code login on that machine and is for personal use only.

| Path | What |
|---|---|
| `apps/desktop` | Electron browser (tabs, omnibox, bookmarks, profiles, extensions, settings, agents) |
| `packages/shared` | Contracts shared by all packages |
| `packages/ai-engine` | Retrievers, AI providers, prompts, cache, language detection |
| `packages/mcp-server` | MCP server over the browser, plus the stdio bridge |
| `packages/sync-core` | End-to-end encryption and the sync client |
| `packages/webscope` | WebScope security workbench (capture, repeater, fuzzer, intercept) |
| `services/sync-server` | Sync server (Fastify and Node's built-in SQLite, stores ciphertext only): self-hosted in Docker, and the same code runs inside the desktop app |
| `integrations/claude-code` | Claude Code plugin (skill, command, bundled MCP bridge) |

More in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/ROADMAP.md](docs/ROADMAP.md).

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md). Please report security issues privately as described in [SECURITY.md](SECURITY.md), not in public issues.

## License

The Corvus source code is licensed under the [Mozilla Public License 2.0](LICENSE).

The installers and the packaged app are a combined work that includes [electron-chrome-extensions](https://github.com/samuelmaddock/electron-browser-shell), which Corvus uses under GPL-3.0, so the binaries are distributed under GPL-3.0. They also include 7-Zip compiled to WebAssembly ([7z-wasm](https://github.com/use-strict/7z-wasm), GNU LGPL), whose RAR decoder comes with the unRAR restriction: it may not be used to develop a RAR-compatible archiver, and the HEIC image decoder libheif compiled to WebAssembly ([libheif-js](https://github.com/catdad-experiments/libheif-js), GNU LGPL 3.0, with the libde265 HEVC decoder, GNU LGPL 3.0). The complete corresponding source is this repository: https://github.com/ParendumOU/Corvus. Every build ships the licences of its third-party packages in THIRD_PARTY_NOTICES.md (Settings > Updates > Third-party software).
