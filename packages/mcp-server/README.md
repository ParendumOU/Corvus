# @corvus/mcp-server

The MCP server that lets AI agents (Claude Code, Claude Desktop, MCP Inspector, any MCP client) drive the Corvus browser. It speaks **Streamable HTTP** on `127.0.0.1` and ships a **stdio bridge** for clients that only speak stdio. It talks to the browser exclusively through the `BrowserController` contract from `@corvus/shared`.

## API

```ts
import { startMcpServer } from "@corvus/mcp-server";

const handle = await startMcpServer({
  controller,              // BrowserController (apps/desktop)
  search,                  // optional SearchEngine (@corvus/ai-engine) -> enables web_search
  token,                   // required bearer token, >= 16 chars
  port: 0,                 // 0/undefined = random free port
  allowEvaluate: false,    // registers `evaluate` only when true AND controller.evaluate exists
  onClientConnect: async (info) => askUser(info), // first connection per client name
  onToolCall: (e) => activityLog.push(e),
  // package-specific extras:
  rateLimit: { capacity: 30, refillPerSecond: 5 }, // per session; false disables
  maxBodyBytes: 1024 * 1024,
  maxSessions: 32,
  sessionIdleMs: 30 * 60 * 1000, // idle sessions (no request, no open stream) are closed
});
handle.url;   // http://127.0.0.1:<port>/mcp
await handle.close();
```

Other exports:

- `createMcpServer(opts)` - the `McpServer` with all tools registered, no transport (tests, custom transports).
- `startStdioBridge({ url, token, stdin?, stdout? })` - the bridge used by `corvus-mcp-stdio`.
- `resetClientApprovals()` - forget remembered client approvals (e.g. "revoke all agents").
- `@corvus/mcp-server/testing` - `MockBrowserController` (in-memory tabs, groups, navigation history, bookmarks, history, records every call in `.calls`) and `MockSearchEngine`.

## Tools

| Tool | Purpose |
|---|---|
| `tabs_list` | Tabs and groups |
| `tab_open` | Open URL in a new tab (always `agent: true`, so the UI shows the AI badge) |
| `tab_close`, `tab_activate` | Close / focus a tab |
| `navigate`, `back`, `forward`, `reload` | Navigation |
| `group_create`, `ungroup` | Tab groups |
| `page_snapshot` | Main text (`maxChars` default 4000, max 20000) + interactive elements with refs |
| `click`, `type`, `scroll` | Interact using refs from `page_snapshot` |
| `screenshot` | PNG image content |
| `bookmarks_list`, `bookmark_add` | Bookmarks |
| `history_search` | History |
| `web_search` | AI search (only when `search` is provided): answer + numbered results |
| `evaluate` | Run JS in the page (only when `allowEvaluate` is set) |

`tabId` is optional on page-level tools and defaults to the active tab. Outputs are compact (no pretty-printed JSON, empty/false fields dropped).

## Security model

- **Loopback only**: binds `127.0.0.1`; any other `host` option throws.
- **Bearer token** on every request (`Authorization: Bearer <token>`), compared in constant time.
- **DNS rebinding**: `Host` must be `127.0.0.1`/`localhost` on the bound port; `Origin`, when sent, must be a loopback origin. Otherwise `403`.
- **Body limit**: POST bodies over `maxBodyBytes` get `413`.
- **Client approval**: the first `initialize` from a new client name calls `onClientConnect`; approvals are remembered for the process lifetime, rejections are not (the user is asked again). Client names are self-declared, so this is a consent prompt, not authentication - the token is the credential.
- **Rate limit**: token bucket per session; excess calls return a tool error with a retry hint.
- **URL policy**: `tab_open`, `navigate` and `bookmark_add` accept only `http:`/`https:` (blocks `file:`, `javascript:`, `data:`, `chrome:`, `corvus:`, `devtools:`, ...).
- **Untrusted content**: everything page-derived (titles, text, search results, history, evaluate output) is wrapped in `<untrusted_page_content source="...">...</untrusted_page_content>` with a note that it is data, not instructions. Delimiter look-alikes inside the content are escaped so a page cannot close the block early.
- Controller errors become MCP tool errors (`isError: true`) with a short message.

## Registering with clients

The desktop app shows the port and token in **Settings > AI Agents**. For local experiments, use the dev server below.

### Claude Code (HTTP)

```sh
claude mcp add --transport http corvus http://127.0.0.1:<port>/mcp --header "Authorization: Bearer <token>"
```

### Claude Desktop (stdio bridge)

Claude Desktop launches stdio servers, so point it at the bridge, which proxies to the running browser. In `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "corvus": {
      "command": "node",
      "args": ["C:/path/to/corvus/packages/mcp-server/dist/bin/stdio-bridge.js"],
      "env": {
        "CORVUS_MCP_URL": "http://127.0.0.1:<port>/mcp",
        "CORVUS_MCP_TOKEN": "<token>"
      }
    }
  }
}
```

The bridge refuses non-loopback URLs so the token never leaves the machine.

### MCP Inspector

```sh
pnpm dlx @modelcontextprotocol/inspector
```

Choose transport "Streamable HTTP", URL `http://127.0.0.1:<port>/mcp`, and add the header `Authorization: Bearer <token>`.

## Dev server (mock browser)

`corvus-mcp-dev` starts the real server over `MockBrowserController` and `MockSearchEngine` and prints the URL, token and a ready-to-paste `claude mcp add` command.

```sh
pnpm --filter @corvus/mcp-server... build
CORVUS_MCP_PORT=39217 CORVUS_MCP_TOKEN=<optional> node packages/mcp-server/dist/bin/dev.js
```

Env: `CORVUS_MCP_PORT` (default random), `CORVUS_MCP_TOKEN` (default random), `CORVUS_MCP_ALLOW_EVALUATE=1` to expose `evaluate`. Inside the Docker dev container the server listens on the container's own loopback, so run clients in the same container (or run the built file with a host Node to use it from host clients).

## Development

All commands run in Docker from the repo root:

```sh
docker compose run --rm dev pnpm --filter @corvus/mcp-server typecheck
docker compose run --rm dev pnpm --filter @corvus/mcp-server test
docker compose run --rm dev pnpm --filter "@corvus/mcp-server..." build
```

`build` needs `@corvus/shared` built first (the `...` filter does that); `typecheck` and tests read the shared sources directly.
