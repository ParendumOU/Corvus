import { parseTarget } from "./scope.js";
import type {
  BlockRule,
  CapturedRequest,
  CapturedResponse,
  ContentType,
  HistoryEntry,
  HistorySource,
  HostOverride,
  HttpHeader,
  InterceptMatch,
  MatchReplaceRule,
  MatchReplaceTarget,
  RuleSet,
  Scope,
  ScopeEntry,
} from "./types.js";

export const SESSION_FORMAT = "corvus-webscope-session";
export const SESSION_VERSION = 1;

/**
 * A saved WebScope session: the scope, the rules, the intercept filters and, when the person chose
 * to include it, the captured traffic. Written and read as JSON.
 */
export interface WebScopeSession {
  format: typeof SESSION_FORMAT;
  version: typeof SESSION_VERSION;
  exportedAt: string;
  scope: Scope;
  rules: RuleSet;
  interceptMatch?: InterceptMatch;
  history?: HistoryEntry[];
}

/** What a session file holds once checked: safe to hand to the engine. */
export interface ParsedSession {
  /** Always disarmed, so a file can never put targets in scope without the person arming it. */
  scope: Scope;
  rules: RuleSet;
  interceptMatch?: InterceptMatch;
  history: HistoryEntry[];
}

export class SessionFormatError extends Error {}

const CONTENT_TYPES: readonly ContentType[] = ["document", "stylesheet", "script", "image", "font", "xhr", "fetch", "websocket", "media", "manifest", "other"];
const SOURCES: readonly HistorySource[] = ["capture", "repeater", "fuzzer"];
const MR_TARGETS: readonly MatchReplaceTarget[] = ["request-header", "request-body", "request-url", "response-header", "response-body"];
const MAX_SCOPE_ENTRIES = 500;
const MAX_RULES = 500;
const MAX_TEXT = 8192;

export function buildSession(parts: { scope: Scope; rules: RuleSet; interceptMatch?: InterceptMatch; history?: HistoryEntry[] }, now = Date.now()): WebScopeSession {
  return {
    format: SESSION_FORMAT,
    version: SESSION_VERSION,
    exportedAt: new Date(now).toISOString(),
    scope: parts.scope,
    rules: parts.rules,
    ...(parts.interceptMatch ? { interceptMatch: parts.interceptMatch } : {}),
    ...(parts.history ? { history: parts.history } : {}),
  };
}

// ---- field readers: anything malformed is dropped rather than trusted

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown, max = MAX_TEXT): string | undefined => (typeof v === "string" && v.length <= max ? v : undefined);
const list = (v: unknown, max: number): unknown[] => (Array.isArray(v) ? v.slice(0, max) : []);
const finite = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

function readScopeEntry(v: unknown): ScopeEntry | null {
  if (!isObj(v)) return null;
  const host = text(v.host, 1024)?.trim();
  if (!host) return null;
  const pathPrefix = text(v.pathPrefix, 2048);
  const port = finite(v.port);
  return {
    host,
    enabled: v.enabled !== false,
    ...(pathPrefix ? { pathPrefix } : {}),
    ...(port !== undefined && Number.isInteger(port) && port > 0 && port < 65536 ? { port } : {}),
  };
}

function readScope(v: unknown): Scope {
  const s = isObj(v) ? v : {};
  const entries = (key: "include" | "exclude"): ScopeEntry[] => list(s[key], MAX_SCOPE_ENTRIES).map(readScopeEntry).filter((e): e is ScopeEntry => e !== null);
  return { enabled: false, include: entries("include"), exclude: entries("exclude") };
}

function readRules(v: unknown, nextId: () => string): RuleSet {
  const r = isObj(v) ? v : {};
  const matchReplace = list(r.matchReplace, MAX_RULES).flatMap((x): MatchReplaceRule[] => {
    if (!isObj(x)) return [];
    const target = MR_TARGETS.find((t) => t === x.target);
    const match = text(x.match);
    if (!target || match === undefined) return [];
    return [{ id: nextId(), name: text(x.name, 200) ?? "", enabled: x.enabled !== false, target, match, replace: text(x.replace) ?? "", regex: x.regex === true }];
  });
  const block = list(r.block, MAX_RULES).flatMap((x): BlockRule[] => {
    const pattern = isObj(x) ? text(x.pattern, 2048) : undefined;
    return isObj(x) && pattern ? [{ id: nextId(), name: text(x.name, 200) ?? "", enabled: x.enabled !== false, pattern }] : [];
  });
  const hostOverride = list(r.hostOverride, MAX_RULES).flatMap((x): HostOverride[] => {
    const host = isObj(x) ? text(x.host, 1024)?.trim() : undefined;
    const address = isObj(x) ? text(x.address, 1024)?.trim() : undefined;
    return isObj(x) && host && address ? [{ id: nextId(), enabled: x.enabled !== false, host, address }] : [];
  });
  return { matchReplace, block, hostOverride };
}

function readInterceptMatch(v: unknown): InterceptMatch | undefined {
  if (!isObj(v)) return undefined;
  const host = text(v.host, 1024);
  const method = text(v.method, 32);
  const path = text(v.path, 2048);
  const types = list(v.types, CONTENT_TYPES.length).filter((t): t is ContentType => CONTENT_TYPES.includes(t as ContentType));
  const match: InterceptMatch = { ...(host ? { host } : {}), ...(method ? { method } : {}), ...(path ? { path } : {}), ...(types.length ? { types } : {}) };
  return Object.keys(match).length ? match : undefined;
}

function readHeaders(v: unknown): HttpHeader[] {
  return list(v, 1000).flatMap((h) => {
    const name = isObj(h) ? text(h.name, 1024) : undefined;
    const value = isObj(h) ? text(h.value, 64 * 1024) : undefined;
    return name !== undefined && value !== undefined ? [{ name, value }] : [];
  });
}

/** Bodies are kept as written; the history buffer bounds how many entries stay in memory. */
function readBody(v: Record<string, unknown>): { body?: string; bodyBase64?: boolean } {
  return typeof v.body === "string" ? { body: v.body, ...(v.bodyBase64 === true ? { bodyBase64: true } : {}) } : {};
}

function readResponse(v: unknown): CapturedResponse | undefined {
  if (!isObj(v)) return undefined;
  const status = finite(v.status);
  if (status === undefined) return undefined;
  const statusText = text(v.statusText, 200);
  const mimeType = text(v.mimeType, 200);
  const size = finite(v.size);
  return {
    status,
    headers: readHeaders(v.headers),
    ...(statusText ? { statusText } : {}),
    ...readBody(v),
    ...(mimeType ? { mimeType } : {}),
    ...(size !== undefined && size >= 0 ? { size } : {}),
  };
}

function readEntry(v: unknown, opts: SessionImportOptions): HistoryEntry | null {
  if (!isObj(v) || !isObj(v.request)) return null;
  const url = text(v.request.url, 64 * 1024);
  const target = url ? parseTarget(url) : null;
  if (!url || !target) return null;
  const request: CapturedRequest = { method: (text(v.request.method, 32) || "GET").toUpperCase(), url, headers: readHeaders(v.request.headers), ...readBody(v.request) };
  const response = readResponse(v.response);
  const startedAt = finite(v.startedAt);
  const durationMs = finite(v.durationMs);
  const error = text(v.error, 2000);
  return {
    id: opts.nextId(),
    profileId: opts.profileId,
    startedAt: startedAt ?? opts.now,
    ...(durationMs !== undefined ? { durationMs } : {}),
    // Recomputed from the URL and the session's scope: the file's own claims are not trusted.
    host: target.host,
    path: target.path,
    type: CONTENT_TYPES.find((t) => t === v.type) ?? "other",
    inScope: opts.inScope(url),
    source: SOURCES.find((s) => s === v.source) ?? "capture",
    request,
    ...(response ? { response } : {}),
    ...(error ? { error } : {}),
    ...(v.aiHidden === true ? { aiHidden: true } : {}),
  };
}

export interface SessionImportOptions {
  profileId: string;
  nextId: () => string;
  /** In-scope test for imported traffic (the engine passes the session's scope, armed). */
  inScope: (url: string) => boolean;
  now: number;
}

/** Check a session document and keep only well-formed parts. Throws when it is not a WebScope session. */
export function parseSession(json: unknown, opts: Omit<SessionImportOptions, "inScope"> & { inScope: (scope: Scope, url: string) => boolean }): ParsedSession {
  if (!isObj(json) || json.format !== SESSION_FORMAT) throw new SessionFormatError("Not a WebScope session file");
  if (json.version !== SESSION_VERSION) throw new SessionFormatError(`Unsupported WebScope session version: ${String(json.version)}`);
  const scope = readScope(json.scope);
  const armed: Scope = { ...scope, enabled: true };
  const entryOpts: SessionImportOptions = { ...opts, inScope: (url) => opts.inScope(armed, url) };
  const history = (Array.isArray(json.history) ? json.history : [])
    .map((e) => readEntry(e, entryOpts))
    .filter((e): e is HistoryEntry => e !== null);
  const interceptMatch = readInterceptMatch(json.interceptMatch);
  return { scope, rules: readRules(json.rules, opts.nextId), ...(interceptMatch ? { interceptMatch } : {}), history };
}
