# Corvus MCP

Connect Claude Code, Claude Desktop, Cursor, VS Code and other MCP clients to [Corvus](https://corvus.parendum.com), the AI browser. Your agent can then open and read pages, click, type, fill forms, take screenshots and search, inside your own logged-in browser session.

This repository holds the connector: a small, self-contained MCP stdio server (`mcp/corvus-mcp-stdio.mjs`) that relays to the MCP server built into Corvus, plus a Claude Code plugin. The browser itself is at [ParendumOU/Corvus](https://github.com/ParendumOU/Corvus).

## Before you start

1. Install Corvus from https://corvus.parendum.com.
2. The connector uses Corvus if it is running, and otherwise starts it (a normal, visible window) with its MCP server on. You can also turn the server on yourself in **Settings > AI agents (MCP) > Enable MCP server**, and off again there.
3. The first time a client connects, Corvus asks you to approve it. Approved clients are listed under **Approved clients**, where you can revoke them.
4. For the `npx` and `pnpm dlx` setups below you need [Node.js](https://nodejs.org) 20 or newer and git on your PATH. The Claude Code plugin only needs Node.js.

You do not need to copy a token for local use. While its MCP server runs, Corvus writes the local address and token to `~/.corvus/mcp.json` (readable only by you), and the connector reads it. If Corvus restarts or drops the session, the connector finds it again and opens a new session by itself.

## The command

Every stdio client below runs the same command:

```sh
npx -y github:ParendumOU/Corvus-MCP
```

or, with pnpm:

```sh
pnpm dlx github:ParendumOU/Corvus-MCP
```

Nothing to install first; the package has no dependencies.

## Claude Code

As a plugin (includes a skill that teaches Claude the tools and a `/corvus-status` command):

```
/plugin marketplace add ParendumOU/Corvus-MCP
/plugin install corvus@corvus-mcp
```

Keep it up to date on its own: Claude Code updates marketplaces it does not ship with only when you turn that on. In `/plugin`, open **Marketplaces**, choose **corvus-mcp** and **Enable auto-update**; or add `"autoUpdate": true` to its entry in `~/.claude/settings.json`:

```json
"extraKnownMarketplaces": {
  "corvus-mcp": { "source": { "source": "github", "repo": "ParendumOU/Corvus-MCP" }, "autoUpdate": true }
}
```

Or as a plain MCP server:

```sh
claude mcp add corvus -- npx -y github:ParendumOU/Corvus-MCP
```

## Claude Desktop

Open **Settings > Developer > Edit Config**, or edit the file directly:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "corvus": {
      "command": "npx",
      "args": ["-y", "github:ParendumOU/Corvus-MCP"]
    }
  }
}
```

Restart Claude Desktop. On Windows, if the server does not start, use `"command": "cmd"` with `"args": ["/c", "npx", "-y", "github:ParendumOU/Corvus-MCP"]`.

## Cursor

Global `~/.cursor/mcp.json`, or `.cursor/mcp.json` in a project:

```json
{
  "mcpServers": {
    "corvus": {
      "command": "npx",
      "args": ["-y", "github:ParendumOU/Corvus-MCP"]
    }
  }
}
```

## Devin Desktop (formerly Windsurf)

Edit `mcp_config.json`:

- macOS and Linux: `~/.config/devin/mcp_config.json`
- Windows: `%APPDATA%\devin\mcp_config.json`
- Older Windsurf releases: `~/.codeium/windsurf/mcp_config.json`

```json
{
  "mcpServers": {
    "corvus": {
      "command": "npx",
      "args": ["-y", "github:ParendumOU/Corvus-MCP"]
    }
  }
}
```

## VS Code (GitHub Copilot agent mode)

`.vscode/mcp.json` in a workspace, or run **MCP: Open User Configuration** for every workspace. Note that VS Code uses `servers`, not `mcpServers`:

```json
{
  "servers": {
    "corvus": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "github:ParendumOU/Corvus-MCP"]
    }
  }
}
```

## Zed

Run `zed: open settings file` and add:

```json
{
  "context_servers": {
    "corvus": {
      "command": "npx",
      "args": ["-y", "github:ParendumOU/Corvus-MCP"]
    }
  }
}
```

## Cline

In the Cline panel click the **MCP Servers** icon, open **Configure** and click **Configure MCP Servers** (Cline CLI: `~/.cline/data/settings/cline_mcp_settings.json`). Add:

```json
{
  "mcpServers": {
    "corvus": {
      "command": "npx",
      "args": ["-y", "github:ParendumOU/Corvus-MCP"],
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

## Codex CLI

```sh
codex mcp add corvus -- npx -y github:ParendumOU/Corvus-MCP
```

or in `~/.codex/config.toml`:

```toml
[mcp_servers.corvus]
command = "npx"
args = ["-y", "github:ParendumOU/Corvus-MCP"]
```

## Gemini CLI

`~/.gemini/settings.json`, or `.gemini/settings.json` in a project:

```json
{
  "mcpServers": {
    "corvus": {
      "command": "npx",
      "args": ["-y", "github:ParendumOU/Corvus-MCP"]
    }
  }
}
```

## Any other MCP client

Any client that can start a stdio MCP server works with:

- command: `npx`
- arguments: `-y github:ParendumOU/Corvus-MCP`

Optional environment variables:

| Variable | Use |
|---|---|
| `CORVUS_MCP_URL` and `CORVUS_MCP_TOKEN` | Skip discovery and use this address and token. The address must be a loopback `http://127.0.0.1:<port>/mcp` URL. |
| `CORVUS_HOME` | Read `mcp.json` from this folder instead of `~/.corvus`. |
| `CORVUS_BIN` | Corvus executable to start when it is not running. By default the connector uses the one Corvus last ran from (`~/.corvus/app.json`), then the default install folder. |
| `CORVUS_MCP_NO_LAUNCH=1` | Never start Corvus; wait for it instead. |

Inside Claude Code the connector also reports the session's `CLAUDE_CONFIG_DIR` to Corvus, so Corvus can run its own Claude Code CLI calls as the same account when you choose **Settings > AI search > Claude Code account > Follow the Claude Code session connected over MCP**.

## Remote access (Streamable HTTP)

Clients can also talk to Corvus directly over Streamable HTTP, without this connector, including from another device on your network. This is **off by default**.

1. In Corvus, open **Settings > AI agents: remote access** and turn on **Allow remote clients**. Corvus then listens on all network interfaces instead of only 127.0.0.1.
2. Copy the address shown under **Connect a remote client**, for example `http://192.168.1.20:39217/mcp`, and the token from **Settings > AI agents (MCP) > Access token**.
3. Every request must send the header `Authorization: Bearer <token>`. There is no way to turn the token off.

The connection is plain HTTP, so only enable this on networks you trust, and use **Regenerate** on the token if it may have leaked. The same address with `127.0.0.1` works locally without remote access.

Examples (replace the address and token):

Claude Code:

```sh
claude mcp add --transport http corvus http://192.168.1.20:39217/mcp --header "Authorization: Bearer <token>"
```

Cursor (`mcp.json`) uses `url` and `headers`; Zed takes the same entry under `context_servers`:

```json
{
  "mcpServers": {
    "corvus": {
      "url": "http://192.168.1.20:39217/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

VS Code, with the token asked for once and stored securely:

```json
{
  "servers": {
    "corvus": {
      "type": "http",
      "url": "http://192.168.1.20:39217/mcp",
      "headers": { "Authorization": "Bearer ${input:corvus-token}" }
    }
  },
  "inputs": [
    { "type": "promptString", "id": "corvus-token", "description": "Corvus MCP token", "password": true }
  ]
}
```

Cline: `"type": "streamableHttp"`, `"url"` and `"headers"`. Gemini CLI: `"httpUrl"` and `"headers"`. Codex CLI: `url = "..."` and `bearer_token_env_var = "CORVUS_MCP_TOKEN"` with the token in that environment variable.

## Access levels and safety

Corvus decides what agents may do, in **Settings > AI agents (MCP)**:

- **Read-only**: list tabs, read and extract page content, take screenshots, search the web, history and bookmarks. No opening, clicking or typing.
- **Standard** (default): adds opening and navigating tabs, clicking, typing and forms.
- **Full**: adds running JavaScript in pages, file uploads and downloads, save as PDF, cookies, recorded flows, the WebScope security tools and filling saved logins and 2FA codes the user opted in.

Tabs an agent is driving show an **AI** badge, an on-screen cursor and an activity timeline, and you can pause agents at any time. CAPTCHAs are solved by the agent when Corvus does not pass them on its own (it clicks the checkbox and works through tile grids with the screenshot and coordinate tools); after two failed attempts, or when the check asks for a phone number or e-mail code, it hands the check back to you. Two-factor prompts are handed to you too, unless you let agents use the 2FA code of a specific saved login: then Corvus fills the code itself after you approve each use, and the agent never sees it. Anything that spends money (a "Buy now", "Place order" or "Pay" click, a submit on a checkout or payment page, a workflow step that pays) shows an **Allow once / Deny** dialog first, at every access level; Deny tells the agent you declined. Text that agents read from web pages is marked as untrusted.

## Troubleshooting

- **"Corvus is not running and was not found"**: start Corvus once (it then records where it is installed), or set `CORVUS_BIN`.
- **"Corvus did not start its MCP server in time"**: Corvus took too long to start, or is waiting for you to approve the client.
- **401 Unauthorized**: the token changed (for example after **Regenerate**). Local setups pick up the new token by themselves; update it in remote setups.
- **403 "Client ... was not approved"**: approve the client in Corvus when it asks, or check **Approved clients**.
- In Claude Code, run `/corvus-status` (plugin) or `/mcp` to see the connection.

## License

MIT, see [LICENSE](LICENSE). The bundled third-party packages and their licenses are listed in [mcp/THIRD_PARTY_NOTICES.md](mcp/THIRD_PARTY_NOTICES.md).
