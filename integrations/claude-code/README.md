# Corvus: Claude Code plugin

Lets Claude Code drive the **Corvus** browser over MCP: open and read pages, click, type, fill forms, screenshot, extract content, and run AI web searches in your own logged-in session.

## Install

In Claude Code:

```
/plugin marketplace add ParendumOU/Corvus
/plugin install corvus@corvus
```

To get new versions without updating by hand, turn on auto-update for the marketplace: in `/plugin`, open **Marketplaces**, choose it and **Enable auto-update** (or set `"autoUpdate": true` on its entry under `extraKnownMarketplaces` in `~/.claude/settings.json`).

That's it: when Claude first needs the browser, the plugin uses Corvus if it is already running, or starts it (a normal, visible window) and turns on its MCP server. Approve the client the first time it connects. No token to copy. You can also turn the server on yourself in **Settings → AI agents (MCP) → "Enable MCP server"**, and off again there.

## How the connection works

While Corvus runs with its MCP server enabled, it writes a discovery file at `~/.corvus/mcp.json` (owner-readable only) containing the local URL and bearer token. The plugin ships a bundled stdio bridge (`mcp/corvus-mcp-stdio.mjs`) that reads it and relays to Corvus on `127.0.0.1`. You can override discovery with `CORVUS_MCP_URL` and `CORVUS_MCP_TOKEN`, or point at a different home with `CORVUS_HOME`. If no server is running, the bridge starts Corvus with `--enable-mcp` (or hands that switch to the Corvus already open), using the executable Corvus records in `~/.corvus/app.json` each time it starts, `CORVUS_BIN`, or the default install folder, and waits up to a minute. Set `CORVUS_MCP_NO_LAUNCH=1` to only wait. When Corvus restarts or drops the session, the bridge finds it again and opens a new session by itself.

Running inside Claude Code, the bridge also tells Corvus which Claude Code config folder (`CLAUDE_CONFIG_DIR`) the session uses. If you keep several Claude accounts in separate config folders, Corvus's own Claude Code CLI provider can then run as the same account: **Settings → AI search → Claude Code account → Follow the Claude Code session connected over MCP**.

## Access levels

Corvus controls what Claude may do (Settings → AI agents): **Read-only**, **Standard** (default), or **Full** (adds running JavaScript, file uploads, downloads, save-as-PDF). Agent-driven tabs show an "AI" badge; you can watch an on-screen cursor and activity timeline and pause agents at any time.

## What's included

- The `corvus` MCP server (via the bundled bridge).
- A `corvus-browser` skill that teaches Claude when and how to use the tools, the token-cheap snapshot-first workflow, CAPTCHA solving with the visual tools (checkbox, tile grids) and human handoff when it fails or for 2FA (except codes the user opted in, which Corvus fills by reference after approval), the dialog Corvus shows before anything that spends money, and the untrusted-content rules.
- A `/corvus-status` command to check the connection.

## Updating the bundle

`mcp/corvus-mcp-stdio.mjs` is a self-contained build of the Corvus stdio bridge from `packages/mcp-server` in the [Corvus source](https://github.com/ParendumOU/Corvus); do not edit it by hand. Rebuild it with `pnpm --filter @corvus/mcp-server run bundle:bridge`, which also updates `mcp/THIRD_PARTY_NOTICES.md` (licenses of the bundled packages).
