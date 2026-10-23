---
description: Check the Corvus browser connection and list open tabs
---

Check whether the Corvus browser MCP connection is working, then report it concisely.

1. Call the `corvus` MCP `tabs_list` tool.
2. If it succeeds, report that Corvus is connected and summarize the open tabs (mark which are
   agent-controlled).
3. If it fails or the tools are unavailable, tell the user to open Corvus (the plugin normally
   starts it and turns its MCP server on by itself), approve the client if Corvus asks, and
   reconnect with `/mcp`. Do not ask the user for a token — the connection is discovered
   automatically.
