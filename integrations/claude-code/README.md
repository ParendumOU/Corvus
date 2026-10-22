# Corvus: Claude Code plugin

Lets Claude Code drive the **Corvus** browser over MCP: open and read pages, click, type, fill
forms, screenshot, extract content, and run AI web searches in your own logged-in session.

## Install

In Claude Code:

```
/plugin marketplace add ParendumOU/Corvus
/plugin install corvus@corvus
```

Then enable the connection in Corvus: **Settings → AI agents (MCP) → "Enable MCP server"**, and
approve the client the first time it connects. The plugin finds the running browser
automatically, no token to copy.

## How the connection works

While Corvus runs with its MCP server enabled, it writes a discovery file at `~/.corvus/mcp.json`
(owner-readable only) containing the local URL and bearer token. The plugin ships a bundled stdio
bridge (`mcp/corvus-mcp-stdio.mjs`) that reads it and relays to Corvus on `127.0.0.1`. You can
override discovery with `CORVUS_MCP_URL` and `CORVUS_MCP_TOKEN`, or point at a different home with
`CORVUS_HOME`. If Corvus isn't running yet, the bridge waits and retries for up to a minute.

## Access levels

Corvus controls what Claude may do (Settings → AI agents): **Read-only**, **Standard** (default),
or **Full** (adds running JavaScript, file uploads, downloads, save-as-PDF). Agent-driven tabs
show an "AI" badge; you can watch an on-screen cursor and activity timeline and pause agents at
any time.

## What's included

- The `corvus` MCP server (via the bundled bridge).
- A `corvus-browser` skill that teaches Claude when and how to use the tools, the token-cheap
  snapshot-first workflow, human handoff for CAPTCHAs/2FA (never solved automatically), and the
  untrusted-content rules.
- A `/corvus-status` command to check the connection.

## Updating the bundle

`mcp/corvus-mcp-stdio.mjs` is a self-contained build of the Corvus stdio bridge from
`packages/mcp-server` in the [Corvus source](https://github.com/ParendumOU/Corvus); do not edit it
by hand. Rebuild it with `pnpm --filter @corvus/mcp-server run bundle:bridge`, which also updates
`mcp/THIRD_PARTY_NOTICES.md` (licenses of the bundled packages).
