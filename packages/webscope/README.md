# @corvus/webscope

Web-traffic security/diagnostics engine for Corvus: scope allowlist, HTTP history, repeater,
intruder-style fuzzer, match/replace & block & host-override rules, decoder/encoder, response
comparer and HAR import/export — for authorized testing of your own or explicitly permitted targets.

The package is Electron-free (the capture engine takes an injected CDP client), so it is fully
unit-tested without a browser. Scope is enforced by the engine itself, independent of any UI or MCP
gate: out-of-scope repeater sends and fuzz targets are refused, and every generated fuzz request is
re-checked.

## API

Import from the barrel (`@corvus/webscope`):

- `WebScopeEngine` — owns scope, rules, HTTP history, audit log; drives capture, repeater, fuzzer,
  comparer and HAR.
- `CaptureEngine`, `HistoryBuffer`, `AuditLog`
- `sendRequest` — Node HTTP client with host overrides and cookie injection.
- `runFuzz`, `planRequests`, `parseTemplate`, `expandPayloadSet`, `RateLimiter`, `clampRate`
- `applyRequestRules`, `applyResponseRules`, `isBlocked`, `resolveOverride`, `emptyRuleSet`
- `compareResponses`, `diffLines`
- `exportHar`, `importHar`
- `encode`, `hash`, `jwtDecode`, `htmlEncode`, `htmlDecode`
- `emptyScope`, `isInScope`, `scopeRejectionReason`, `parseTarget`, `scopeEntry`

See `docs/WEBSCOPE.md` for the design and the safety model (scope enforcement, authorization banner,
rate limits, audit log; no CAPTCHA solving, no bundled attack wordlists).

## Safety

For authorized testing only. WebScope ships no attack or credential wordlists — you supply your own —
and never solves human-verification challenges. The package is `private` and used only inside Corvus.

## Scripts

- `pnpm --filter @corvus/webscope build` — compile to `dist/`.
- `pnpm --filter @corvus/webscope typecheck`
- `pnpm --filter @corvus/webscope test` — Vitest.
