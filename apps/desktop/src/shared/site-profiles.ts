/**
 * Per-site AI profiles: pure model + matching. A profile is keyed by a domain/origin pattern and
 * narrows how the AI behaves on that site — a system-prompt addendum, an access-level cap that can
 * only NARROW the agent's tools (never widen them), and an optional provider/model override.
 *
 * This module has no Electron or Node deps so it is unit-testable and shared by the main process
 * (store + agent/assist wiring) and the corvus://site-profiles manager page.
 *
 * Apply precedence (documented once, enforced here):
 *  1. Matching: among enabled profiles whose pattern matches the target URL, the MOST SPECIFIC wins
 *     (path-qualified > exact host > bare domain/suffix > "*." wildcard; longer host breaks ties;
 *     then creation order). `matchSiteProfile` returns that one, or null.
 *  2. Access: the effective level is min(global, profile.accessCap). A cap can only remove tools,
 *     never add them (`capAccessLevel`). No profile, or a null cap, leaves the global level intact.
 *  3. Prompt: the addendum is prepended or appended to the base system prompt (`applyPromptAddendum`).
 *  4. Provider: when set, the profile's provider/model replace the global ones for that run; the
 *     connection details (api key, local base URL, CLI path) always come from global settings.
 */
import type { AccessLevel, AIProviderKind } from "@corvus/shared";

export interface SiteProfile {
  id: string;
  /** Domain/origin pattern: "example.com", "*.example.com", "docs.example.com/api". */
  pattern: string;
  /** Short human label for the manager list. */
  label: string;
  enabled: boolean;
  /** Prepended or appended to the base system prompt for runs that match. Empty = no change. */
  promptAddendum: string;
  promptPosition: PromptPosition;
  /** Caps the agent's access level on this site; null = no cap (keep global access). */
  accessCap: AccessLevel | null;
  /** Optional provider override for runs on this site; null = use the global provider. */
  provider: AIProviderKind | null;
  /** Optional model override; null/empty = use the global model. */
  model: string | null;
  createdAt: number;
}

export type PromptPosition = "prepend" | "append";

/** User-editable fields (no id/createdAt). */
export interface SiteProfileInput {
  pattern: string;
  label: string;
  enabled: boolean;
  promptAddendum: string;
  promptPosition: PromptPosition;
  accessCap: AccessLevel | null;
  provider: AIProviderKind | null;
  model: string | null;
}

export const MAX_SITE_PROFILES = 100;
export const MAX_PATTERN_CHARS = 200;
export const MAX_LABEL_CHARS = 80;
export const MAX_ADDENDUM_CHARS = 2000;
export const MAX_MODEL_CHARS = 120;

const ACCESS_RANK: Record<AccessLevel, number> = { read: 0, standard: 1, full: 2 };
const PROVIDERS: readonly AIProviderKind[] = ["anthropic-api", "claude-code-cli", "local"];

export function isAccessLevel(v: unknown): v is AccessLevel {
  return v === "read" || v === "standard" || v === "full";
}

/** The effective access level after applying a cap. A cap can only lower (narrow) the level. */
export function capAccessLevel(global: AccessLevel, cap: AccessLevel | null): AccessLevel {
  if (!cap) return global;
  return ACCESS_RANK[cap] < ACCESS_RANK[global] ? cap : global;
}

/** Merge a profile's addendum into a base system prompt. No addendum -> base unchanged. */
export function applyPromptAddendum(base: string, profile: SiteProfile | null | undefined): string {
  const add = profile?.promptAddendum?.trim();
  if (!add) return base;
  return profile!.promptPosition === "prepend" ? `${add}\n\n${base}` : `${base}\n\n${add}`;
}

interface ParsedPattern {
  host: string;
  wildcard: boolean;
  /** Normalized path prefix starting with "/", or "" when the pattern has no path. */
  path: string;
}

/** Parses a user pattern into host + optional path. Returns null when it has no usable host. */
export function parsePattern(pattern: string): ParsedPattern | null {
  let raw = pattern.trim().toLowerCase();
  if (!raw) return null;
  raw = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  const slash = raw.indexOf("/");
  let host = slash >= 0 ? raw.slice(0, slash) : raw;
  let path = slash >= 0 ? raw.slice(slash) : "";
  host = host.replace(/:\d+$/, "");
  const wildcard = host.startsWith("*.");
  if (wildcard) host = host.slice(2);
  if (!host || host.includes("*") || host.includes("/")) return null;
  path = path.replace(/\/+$/, "");
  return { host, wildcard, path };
}

function hostOf(url: string): { host: string; path: string } | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return { host: u.hostname.toLowerCase(), path: u.pathname.toLowerCase() || "/" };
  } catch {
    return null;
  }
}

function hostMatches(p: ParsedPattern, host: string): boolean {
  if (p.wildcard) return host.endsWith(`.${p.host}`) && host.length > p.host.length + 1;
  return host === p.host || host.endsWith(`.${p.host}`);
}

function pathMatches(p: ParsedPattern, path: string): boolean {
  if (!p.path) return true;
  return path === p.path || path.startsWith(`${p.path}/`);
}

/** Specificity: path-qualified > exact host > bare/suffix > wildcard; longer host breaks ties. */
function specificity(p: ParsedPattern, host: string): number {
  let score = p.host.length;
  if (!p.wildcard && host === p.host) score += 1000;
  if (p.path) score += 5000 + p.path.length;
  if (p.wildcard) score -= 1;
  return score;
}

/** The most specific enabled profile matching the URL, or null. Ties resolve to earliest in list. */
export function matchSiteProfile(profiles: readonly SiteProfile[], url: string): SiteProfile | null {
  const target = hostOf(url);
  if (!target) return null;
  let best: SiteProfile | null = null;
  let bestScore = -Infinity;
  for (const profile of profiles) {
    if (!profile.enabled) continue;
    const parsed = parsePattern(profile.pattern);
    if (!parsed) continue;
    if (!hostMatches(parsed, target.host) || !pathMatches(parsed, target.path)) continue;
    const score = specificity(parsed, target.host);
    if (score > bestScore) {
      bestScore = score;
      best = profile;
    }
  }
  return best;
}

/** True when a pattern is well-formed enough to match anything. */
export function isValidPattern(pattern: string): boolean {
  return parsePattern(pattern) !== null;
}

function cleanProvider(v: unknown): AIProviderKind | null {
  return typeof v === "string" && (PROVIDERS as readonly string[]).includes(v) ? (v as AIProviderKind) : null;
}

function cleanModel(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim().slice(0, MAX_MODEL_CHARS);
  return t ? t : null;
}

/** Normalizes untrusted input into a stored shape, clamping every field. */
export function normalizeInput(input: SiteProfileInput): SiteProfileInput {
  return {
    pattern: input.pattern.trim().slice(0, MAX_PATTERN_CHARS),
    label: (input.label || "").trim().slice(0, MAX_LABEL_CHARS),
    enabled: input.enabled !== false,
    promptAddendum: (input.promptAddendum || "").slice(0, MAX_ADDENDUM_CHARS),
    promptPosition: input.promptPosition === "prepend" ? "prepend" : "append",
    accessCap: isAccessLevel(input.accessCap) ? input.accessCap : null,
    provider: cleanProvider(input.provider),
    model: cleanModel(input.model),
  };
}

export function reviveProfile(raw: unknown): SiteProfile | null {
  const r = raw as Partial<SiteProfile> | null;
  if (!r || typeof r.id !== "string" || typeof r.pattern !== "string" || !parsePattern(r.pattern)) return null;
  const input = normalizeInput({
    pattern: r.pattern,
    label: typeof r.label === "string" ? r.label : "",
    enabled: r.enabled !== false,
    promptAddendum: typeof r.promptAddendum === "string" ? r.promptAddendum : "",
    promptPosition: r.promptPosition === "prepend" ? "prepend" : "append",
    accessCap: isAccessLevel(r.accessCap) ? r.accessCap : null,
    provider: cleanProvider(r.provider),
    model: cleanModel(r.model),
  });
  return { id: r.id, ...input, createdAt: typeof r.createdAt === "number" ? r.createdAt : Date.now() };
}
