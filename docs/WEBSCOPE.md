# Corvus WebScope

WebScope is a Burp-style web-traffic security and diagnostics workbench built into Corvus. It captures **your own** browser traffic, and lets you replay, fuzz, transform and compare requests — for authorized testing of systems you own or have explicit written permission to test.

It is **off by default**. Enable it under Settings → Security workbench, or from the app menu (**WebScope (security workbench)**), then open `corvus://webscope`.

## Safety model

WebScope is built around a few hard guarantees, enforced in the engine itself (not just the UI), so they also hold for the MCP tools:

- **Scope allowlist.** Nothing is acted on unless the scope is enabled, a URL matches an enabled `include` entry, and no `exclude` entry matches (exclude always wins). Host matching is anchored, case-insensitive, strips userinfo (`https://trusted@evil/` resolves to `evil`), trailing dots and IPv6 brackets, and only accepts `http`/`https`. The matcher is unit-tested against bypass attempts (`packages/webscope/test/scope.test.ts`).
- **Scope enforced everywhere.** `WebScopeEngine.repeaterSend` and `fuzz` refuse out-of-scope targets, and every generated fuzz request is re-checked, so a payload can never redirect an attack off-scope.
- **Authorization notice.** The `corvus://webscope` command bar always shows an *Authorized testing only* notice; clicking it expands the full text (only test systems you own or have explicit written permission to test). The Fuzzer additionally requires an explicit "I am authorized to test this target" confirmation, plus a confirm dialog, before an attack can start.
- **Mandatory rate limiting.** The fuzzer always paces requests (conservative default; clamped to a safe ceiling of 50 req/s in the engine, 10 req/s over MCP) and caps total requests.
- **Audit log.** Scope/rule changes, repeater sends and fuzz start/finish are recorded in an in-memory audit log, surfaced on the Scope tab.
- **Cookie discipline.** Profile cookies are reused for a replayed/fuzzed request only when the host is in scope and the user opted in.
- **No CAPTCHA solving, no bundled wordlists.** WebScope never solves human-verification challenges and ships no attack/credential wordlists; you supply your own payloads.

## Package: `@corvus/webscope`

Private, Electron-free engine so it is unit-testable and reusable. Key exports (`src/index.ts`):

- `WebScopeEngine` — owns scope, rules, HTTP history (ring buffer), audit log; drives capture, repeater, fuzzer, comparer and HAR. Scope is enforced here.
- `CaptureEngine` — records a CDP `Network` event stream into history. It consumes an injected `CdpClient` (an Electron `webContents.debugger` in the app, a fake in tests), with a body-size cap.
- `sendRequest` — Node HTTP client honoring DNS-style host overrides (keeps the original Host/SNI) and an injected Cookie header; does not follow redirects unless asked.
- `runFuzz` / `planRequests` / `RateLimiter` — intruder-style fuzzer: `§payload§` positions, sniper + cluster-bomb attacks, wordlist/numbers/charset payload sets, concurrency and rate limit.
- `applyRequestRules` / `applyResponseRules` — match/replace, block and host-override rules.
- `compareResponses` / `diffLines` — response comparer.
- `exportHar` / `importHar` — HAR 1.2 round-trip.
- `buildSession` / `parseSession` — WebScope session files (see Sessions below); the engine wraps them as `exportSession` / `importSession`.
- `encode` / `hash` / `jwtDecode` — decoder/encoder (base64, url, html, hex, md5/sha1/sha256/sha512, JWT decode).

## Desktop integration

`apps/desktop/src/main/webscope-service.ts` keeps one `WebScopeEngine` per profile. When the setting is on, it attaches each tab's `webContents.debugger` as a `CdpClient` to the active profile's engine. The `corvus://webscope` page talks to the engine over the typed internal IPC in `src/shared/webscope-ipc.ts`. UI code: `src/renderer/pages/webscope.tsx` (views), `webscope-lib.tsx` (shared components) and `webscope-format.ts` (pure helpers, unit-tested).

## Using the workbench

The page has three thin rows of chrome above one working surface:

- **Command bar:** the *Authorized testing only* notice, **Session** (save or open a session, see below), captured and attached-tab counts, and the **Capture** switch.
- **Tool tabs**, grouped by job: History, Intercept, Repeater, Fuzzer | Target, Findings | Scope, Rules, Decoder, Comparer. Left/Right arrows move between tabs when one has focus.
- **Scope strip**, visible on every tool: whether the scope is armed and the in-scope hosts, with an **Edit scope** button.

Per tool:

- **History:** filter by host, method, status class, resource type, in-scope and free-text search (URL, headers, bodies). Click a column header to sort. Long lists are windowed so thousands of rows stay fast. Selecting a row opens the request and response side by side; both panes and the table/detail divider can be dragged (or moved with the arrow keys when focused). Each message has **Pretty** (indented JSON and HTML), **Raw**, **Headers** and **Hex** tabs. From the request pane, **Send to Repeater** or **Send to Fuzzer**. Mark two rows to **Compare** them. HAR export and import, and **Clear** (asks first).
- **Repeater:** one tab per request; sending from History opens a new tab. **Ctrl+Enter** sends.
- **Fuzzer:** setup is grouped (Target, Attack, Payload sets, Payload processing, Throttle, Grep and extract). It shows how many `§` positions are marked and how many requests the attack will send before you start. Results sort by index, status, size or time, can be narrowed to grep hits and exported as CSV.
- **Intercept:** turn interception on, optionally narrow it with host, method and path filters, then edit and **Forward edited**, **Forward** or **Drop**. **F** forwards (edited) and **D** drops the selected item.
- **Target:** collapsible host-to-path tree with method and request counts. **Findings:** grouped by severity (Medium, Low, Info); the same observation on several responses is one card listing where it was seen.
- **Scope** and **Rules:** labelled tables; the audit log sits under the scope lists.
- **Decoder:** encode, decode, hash and JWT operations in labelled groups. **Comparer:** header and body diff of two responses.

## MCP tools

Exposed only at the **full** access level, only when the app wires in the engine, and always scope-gated. Out-of-scope targets are refused with a clear error; response bodies are wrapped as untrusted content.

- `webscope_history` — list captured exchanges (filterable).
- `webscope_request_detail` — full request/response for one entry.
- `webscope_send` — issue one request (Repeater), in-scope only.
- `webscope_fuzz` — bounded intruder-style fuzz (≤ 500 requests, ≤ 10 req/s over MCP).
- `webscope_scope` — get/set the scope allowlist.
- `webscope_set_rules` — set match/replace, block and host-override rules.

## Tests

- Engine units: `packages/webscope/test/` (scope, capture parsing, fuzzer expansion + rate limiter, match/replace, encoders, HAR round-trip, session save/open, HTTP client, scope enforcement incl. out-of-scope refusal).
- MCP tools: `packages/mcp-server/test/webscope-tools.test.ts` (full-level gating, scope refusal, untrusted wrapping, bounded fuzz) against a local test server.
- Desktop UI helpers: `apps/desktop/test/webscope-format.test.ts` (formatting, pretty-print, hex dump, and the Fuzzer request preview checked against the engine's `planRequests`).
- Desktop smoke: `apps/desktop/src/main/smoke-webscope.ts` captures a request over CDP, replays it, runs a 3-payload in-scope fuzz, saves a session with that traffic and opens it in a fresh engine, holds and forwards an intercepted request, and screenshots every tool (History, Intercept, Repeater, Fuzzer, Target, Findings, Scope, Rules, Decoder, Comparer) and the session panel in light and dark.

## Interactive intercept

With **Intercept on** (Intercept tab), in-scope requests that match the optional filters are paused and listed in a held queue. You can edit a paused request’s method, URL, headers and body, then **Forward** it, **Forward edited**, or **Drop** it (keyboard: **F** / **D**). The host, method and path filters sit in the Intercept toolbar. Enable **Hold responses** to pause and edit responses before they reach the page. Everything out of scope, or not matching the filters, is forwarded untouched; held items auto-forward after 30s so the browser never deadlocks. Match & replace and block rules are applied on forward. Agents can drive this at Full access via the `webscope_intercept_queue` and `webscope_intercept_action` tools, in-scope only.

## Target and passive findings

The **Target** tab shows a host-to-path tree of captured traffic, with the methods and request count per node. The **Findings** tab lists passive, read-only observations from captured responses: missing security headers (CSP, HSTS, X-Content-Type-Options, framing), cookies without Secure/HttpOnly/SameSite, version disclosure, mixed content, and reflected query parameters, each with a plain-language explanation and an advisory severity. These are observations only — WebScope never sends a request or attempts an exploit to produce them. Agents can read them at Full access via webscope_findings and webscope_sitemap.

## Sessions

Scope, rules and captured traffic live in memory and are gone when Corvus closes. **Session** in the command bar saves them to a JSON file (`corvus-webscope-session-<date>.json`) and opens one again:

- **Save session** writes the scope, the rules and the intercept filters. **Include captured traffic** adds every request in History, in full: it can hold cookies, tokens and passwords you typed, so it is off by default and the panel says so when you tick it.
- **Open session** replaces the scope, rules and intercept filters, adds the saved traffic to History and takes you to the Scope tab. The scope always arrives **disarmed**: a session file can never put targets in scope on its own; you review it and arm it yourself. Intercept stays on or off as it was.
- Everything in the file is checked before use: unknown fields, malformed entries and rules are dropped, IDs are new, and each request's host, path and in-scope flag are worked out again from its URL (in scope means the session's scope would include it once armed). Requests that were hidden from AI stay hidden from AI.
- Saving and opening are recorded in the audit log. Sessions are a page feature only: there is no MCP tool for them.
