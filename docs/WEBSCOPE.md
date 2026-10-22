# Corvus WebScope

WebScope is a Burp-style web-traffic security and diagnostics workbench built into Corvus. It
captures **your own** browser traffic, and lets you replay, fuzz, transform and compare requests —
for authorized testing of systems you own or have explicit written permission to test.

It is **off by default**. Enable it under Settings → Security workbench, or from the app menu
(**WebScope (security workbench)**), then open `corvus://webscope`.

## Safety model

WebScope is built around a few hard guarantees, enforced in the engine itself (not just the UI), so
they also hold for the MCP tools:

- **Scope allowlist.** Nothing is acted on unless the scope is enabled, a URL matches an enabled
  `include` entry, and no `exclude` entry matches (exclude always wins). Host matching is anchored,
  case-insensitive, strips userinfo (`https://trusted@evil/` resolves to `evil`), trailing dots and
  IPv6 brackets, and only accepts `http`/`https`. The matcher is unit-tested against bypass attempts
  (`packages/webscope/test/scope.test.ts`).
- **Scope enforced everywhere.** `WebScopeEngine.repeaterSend` and `fuzz` refuse out-of-scope targets,
  and every generated fuzz request is re-checked, so a payload can never redirect an attack off-scope.
- **Authorization banner.** The `corvus://webscope` page shows a persistent banner: *Only test
  systems you are authorized to test.* The Fuzzer additionally requires an explicit "I am authorized
  to test this target" confirmation before an attack can start.
- **Mandatory rate limiting.** The fuzzer always paces requests (conservative default; clamped to a
  safe ceiling of 50 req/s in the engine, 10 req/s over MCP) and caps total requests.
- **Audit log.** Scope/rule changes, repeater sends and fuzz start/finish are recorded in an
  in-memory audit log, surfaced on the Scope tab.
- **Cookie discipline.** Profile cookies are reused for a replayed/fuzzed request only when the host
  is in scope and the user opted in.
- **No CAPTCHA solving, no bundled wordlists.** WebScope never solves human-verification challenges
  and ships no attack/credential wordlists; you supply your own payloads.

## Package: `@corvus/webscope`

Private, Electron-free engine so it is unit-testable and reusable. Key exports (`src/index.ts`):

- `WebScopeEngine` — owns scope, rules, HTTP history (ring buffer), audit log; drives capture,
  repeater, fuzzer, comparer and HAR. Scope is enforced here.
- `CaptureEngine` — records a CDP `Network` event stream into history. It consumes an injected
  `CdpClient` (an Electron `webContents.debugger` in the app, a fake in tests), with a body-size cap.
- `sendRequest` — Node HTTP client honoring DNS-style host overrides (keeps the original Host/SNI)
  and an injected Cookie header; does not follow redirects unless asked.
- `runFuzz` / `planRequests` / `RateLimiter` — intruder-style fuzzer: `§payload§` positions,
  sniper + cluster-bomb attacks, wordlist/numbers/charset payload sets, concurrency and rate limit.
- `applyRequestRules` / `applyResponseRules` — match/replace, block and host-override rules.
- `compareResponses` / `diffLines` — response comparer.
- `exportHar` / `importHar` — HAR 1.2 round-trip.
- `encode` / `hash` / `jwtDecode` — decoder/encoder (base64, url, html, hex, md5/sha1/sha256/sha512,
  JWT decode).

## Desktop integration

`apps/desktop/src/main/webscope-service.ts` keeps one `WebScopeEngine` per profile. When the setting
is on, it attaches each tab's `webContents.debugger` as a `CdpClient` to the active profile's engine.
The `corvus://webscope` page (left nav: History, Intercept, Repeater, Fuzzer, Rules, Scope, Decoder,
Comparer) talks to the engine over the typed internal IPC in `src/shared/webscope-ipc.ts`.

## MCP tools

Exposed only at the **full** access level, only when the app wires in the engine, and always
scope-gated. Out-of-scope targets are refused with a clear error; response bodies are wrapped as
untrusted content.

- `webscope_history` — list captured exchanges (filterable).
- `webscope_request_detail` — full request/response for one entry.
- `webscope_send` — issue one request (Repeater), in-scope only.
- `webscope_fuzz` — bounded intruder-style fuzz (≤ 500 requests, ≤ 10 req/s over MCP).
- `webscope_scope` — get/set the scope allowlist.
- `webscope_set_rules` — set match/replace, block and host-override rules.

## Tests

- Engine units: `packages/webscope/test/` (scope, capture parsing, fuzzer expansion + rate limiter,
  match/replace, encoders, HAR round-trip, HTTP client, scope enforcement incl. out-of-scope refusal).
- MCP tools: `packages/mcp-server/test/webscope-tools.test.ts` (full-level gating, scope refusal,
  untrusted wrapping, bounded fuzz) against a local test server.
- Desktop smoke: `apps/desktop/src/main/smoke-webscope.ts` captures a request over CDP, replays it,
  runs a 3-payload in-scope fuzz, and screenshots History/Repeater/Fuzzer in light and dark.

## Interactive intercept

With **Intercept on** (Intercept tab), in-scope requests that match the optional filters are
paused and listed in a held queue. You can edit a paused request’s method, URL, headers and body,
then **Forward** it, **Forward edited**, or **Drop** it. Enable **Hold responses** to pause and
edit responses before they reach the page. Everything out of scope, or not matching the filters,
is forwarded untouched; held items auto-forward after 30s so the browser never deadlocks. Match &
replace and block rules are applied on forward. Agents can drive this at Full access via the
`webscope_intercept_queue` and `webscope_intercept_action` tools, in-scope only.

## Target and passive findings

The **Target** tab shows a host-to-path tree of captured traffic, with the methods and request
count per node. The **Findings** tab lists passive, read-only observations from captured
responses: missing security headers (CSP, HSTS, X-Content-Type-Options, framing), cookies
without Secure/HttpOnly/SameSite, version disclosure, mixed content, and reflected query
parameters, each with a plain-language explanation and an advisory severity. These are
observations only — WebScope never sends a request or attempts an exploit to produce them.
Agents can read them at Full access via webscope_findings and webscope_sitemap.
