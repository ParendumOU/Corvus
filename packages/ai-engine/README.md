# @corvus/ai-engine

The Corvus search box backend. A query goes to a conventional search backend first (no LLM),
the results are emitted immediately, and then one small-model call writes a short, cited answer
in the user's language from compact numbered snippets.

```ts
import { createSearchEngine } from "@corvus/ai-engine";

const engine = createSearchEngine({
  provider: "anthropic-api",
  apiKey: process.env.ANTHROPIC_API_KEY,
  retriever: "searxng",
  searxngUrl: "http://localhost:8898",
  cacheDir: "/path/to/profile/search-cache",
  uiLocale: "es-ES",
});

for await (const ev of engine.search("como funciona una bomba de calor", { depth: "quick" })) {
  // results -> answer-delta* -> answer-done -> usage   (or error)
}
```

The contract (`SearchEngine`, `SearchEvent`, `AiEngineConfig`) lives in `@corvus/shared`.

## Pipeline

1. **Language**: `opts.lang` > detected from the query > `config.uiLocale` > `"en"`.
   Detection uses unambiguous scripts (CJK, Greek, Hebrew, ...), `franc-min` trigrams and a small
   function-word/diacritic vote. Short Latin queries ("rust async", "iphone 16") are treated as
   unknown rather than guessed, so they fall back to the UI locale. When the detected language
   matches the UI locale's base language, the UI region is kept (`pt` + `pt-BR` -> `pt-BR`).
2. **Retrieval** (no LLM): the configured retriever, then every other usable one as fallback
   (an error or an empty list moves to the next). SearXNG needs `searxngUrl`, Brave needs
   `braveApiKey`, DuckDuckGo (HTML endpoint) always works. Timeout 6 s per retriever; the
   language is passed to each backend (`language`, `search_lang`, `kl`). URLs are stripped of
   tracking parameters (`utm_*`, `gclid`, `fbclid`, ...) and deduplicated by a normalized form
   (scheme, `www.`, trailing slash, fragment and query order are ignored).
3. **`results` event**: emitted before any LLM work so the UI renders a classic result list.
4. **Deep mode** (`depth: "deep"`): the top 3 pages are fetched concurrently (4 s timeout,
   1.5 MB cap, `text/html` only), extracted with Readability on `linkedom`, and trimmed to
   ~1500 chars each. SSRF guard: URLs whose host is, or resolves via DNS to, a loopback, private,
   link-local, CGNAT or multicast address (including IPv4-mapped IPv6) are skipped, and redirects
   are followed by hand (max 5) with the same check on every hop. Residual risk: DNS can change
   between the check and the connection (rebinding); pinning the resolved IP needs a custom
   undici dispatcher.
5. **Answer**: one call with a static system prompt and a compact user message:

   ```
   lang: es
   query: como funciona una bomba de calor
   <sources>
   [1] Title (domain)
   snippet (<= 300 chars)
   Page: excerpt (deep mode only, <= 1500 chars)
   ...
   </sources>
   ```

   The system prompt asks for a concise answer in `lang`, grounded only in the sources, citing
   `[n]`, saying so when sources are insufficient, and treating source text as untrusted data.
   `max_tokens` is `config.maxOutputTokens ?? 400`. Citations are parsed from the final text
   into `answer-done.citations` as **0-based indices into `results`** (`[1]` -> `0`).
6. **Cache**: in-memory LRU (200 entries) plus, when `cacheDir` is set, one JSON file per entry.
   Key = normalized query + lang + depth + configured retriever + maxResults, TTL 6 h. Hits
   replay `results` (`cached: true`), the full answer as one delta, `answer-done`, and a
   zero-token `usage`. Failed or empty answers are not cached.

### Events and errors

| Situation | Events |
|---|---|
| normal | `results`, `answer-delta`..., `answer-done`, `usage` |
| no provider (no API key) | `results` only |
| every retriever failed | `error` (`recoverable: false`) |
| LLM failed after results | `results`, maybe some deltas, `error` (`recoverable: true`) |
| `opts.signal` aborted | the iterator ends quietly |

## Token budget

Measured with `claude-haiku-5-5` on live SearXNG results (8 results):

| Mode | Prompt input tokens | Notes |
|---|---|---|
| quick | ~1,050 | system ~170 + query and 8 snippets |
| deep | ~2,100 | + 3 page excerpts |

Output is capped at 400 tokens by default. The system prompt carries `cache_control:
{ type: "ephemeral" }`, but it is far below the minimum cacheable prompt length, so in practice
it is not cached on the API path; the marker is there so a longer prompt would be cached
without code changes. `estimateTokens()` (~3 chars/token) is used for tests only.

## Providers

### `anthropic-api` (default)

Official `@anthropic-ai/sdk`, `messages.stream()`, extended thinking disabled. Text deltas
become `answer-delta`; `usage` reports the real token counts from the stream
(input = uncached + cache-write + cache-read tokens). Without `apiKey` the engine runs in
results-only mode.

### `claude-code-cli` (personal use only)

Spawns the locally installed Claude Code and **uses the user's own Claude Code login**. This is
meant for personal use on your own machine: Anthropic consumer subscriptions may not be resold
or embedded into apps distributed to others, so distributed builds must use `anthropic-api`
with an API key.

The command is:

```
claude -p --output-format stream-json --verbose --include-partial-messages \
  --model <model> --effort low --tools "" --strict-mcp-config --setting-sources "" \
  --no-session-persistence --system-prompt <static system prompt>
```

with the user message on stdin and a temp directory as cwd. No tools, no MCP servers, no
user/project settings (so personal hooks and plugins do not run), no saved session.
Claude Code adds roughly 700 input tokens of its own on top of the prompt (cached after the
first call) and keeps adaptive thinking on, which cannot be disabled from the CLI; thinking
tokens count against `CLAUDE_CODE_MAX_OUTPUT_TOKENS`, so the engine sets it to
`maxOutputTokens + 1024` to avoid Claude Code's automatic "continue" request. Thinking is never
shown. On Windows, `claudeCliPath` must point at `claude.exe` (the native installer's default
`claude` on PATH works); package-manager `.cmd` shims cannot be spawned without a shell.

## CLI

```
docker compose run --rm dev pnpm --filter @corvus/ai-engine build
docker compose run --rm dev pnpm --filter @corvus/ai-engine exec corvus-search "how does rust ownership work"
docker compose run --rm dev pnpm --filter @corvus/ai-engine exec corvus-search --deep --lang es "rust ownership"
docker compose run --rm dev pnpm --filter @corvus/ai-engine exec corvus-search --no-answer --json "query"
```

Reads `CORVUS_AI_PROVIDER`, `ANTHROPIC_API_KEY`, `CORVUS_AI_MODEL`, `CORVUS_RETRIEVER`,
`CORVUS_SEARXNG_URL`, `BRAVE_SEARCH_API_KEY`, `CORVUS_CACHE_DIR` and `CORVUS_CLAUDE_CLI`
(the first six are in the root `.env.example`). `--help` lists the flags.

## Development

```
docker compose run --rm dev pnpm --filter @corvus/ai-engine typecheck
docker compose run --rm dev pnpm --filter @corvus/ai-engine test
docker compose run --rm dev pnpm --filter @corvus/ai-engine build

# live SearXNG integration test
docker compose up -d searxng
docker compose run --rm -e CORVUS_IT=1 dev pnpm --filter @corvus/ai-engine test
```

Unit tests use fixtures only (no network): retriever parsing (SearXNG JSON, Brave JSON,
DuckDuckGo HTML including the bot-challenge page), URL normalization, language detection,
prompt building and budget, citations, cache, event order with a mocked provider, the
Anthropic stream mapping, and Claude Code stream-json parsing (plus a fake `claude` binary).

Exports for testing and reuse: `detectLanguage`, `resolveLanguage`, `buildPrompt`,
`parseCitations`, `estimateTokens`, `createSearxngRetriever`, `createBraveRetriever`,
`createDuckDuckGoRetriever`, `parse*` functions, `retrieveWithFallback`, `SearchCache`,
`StreamJsonParser`, `createAnthropicProvider`, `createClaudeCliProvider`.
`createSearchEngine(config, deps)` takes an optional second argument to inject retrievers, a
provider (`null` = results only), `fetch`, a cache, or the deep-mode fetcher.
