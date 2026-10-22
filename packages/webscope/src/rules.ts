import { normalizeHost, parseTarget } from "./scope.js";
import type {
  BlockRule,
  CapturedResponse,
  HostOverride,
  HttpHeader,
  MatchReplaceRule,
  OutboundRequest,
  RuleSet,
} from "./types.js";

export function emptyRuleSet(): RuleSet {
  return { matchReplace: [], block: [], hostOverride: [] };
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.*+?^${}()|[\]\\]/g, (ch) => (ch === "*" ? "\u0000" : `\\${ch}`));
  return new RegExp(`^${escaped.replace(/\u0000/g, ".*")}$`, "i");
}

function substitute(input: string, rule: MatchReplaceRule): string {
  if (!rule.match) return input;
  if (rule.regex) {
    try {
      return input.replace(new RegExp(rule.match, "g"), rule.replace);
    } catch {
      return input;
    }
  }
  return input.split(rule.match).join(rule.replace);
}

function applyHeaderRules(headers: HttpHeader[], rules: MatchReplaceRule[]): HttpHeader[] {
  if (rules.length === 0) return headers;
  return headers.map((h) => {
    let name = h.name;
    let value = h.value;
    for (const rule of rules) {
      const line = `${name}: ${value}`;
      const next = substitute(line, rule);
      if (next !== line) {
        const idx = next.indexOf(":");
        name = idx >= 0 ? next.slice(0, idx).trim() : next;
        value = idx >= 0 ? next.slice(idx + 1).trim() : "";
      }
    }
    return { name, value };
  });
}

/** Whether an in-scope request URL is blocked by an enabled block rule. */
export function isBlocked(url: string, rules: RuleSet): BlockRule | null {
  for (const rule of rules.block) {
    if (rule.enabled && globToRegExp(rule.pattern).test(url)) return rule;
  }
  return null;
}

/** Resolve a request host to an override address (DNS-style). The Host header is preserved. */
export function resolveOverride(url: string, rules: RuleSet): HostOverride | null {
  const target = parseTarget(url);
  if (!target) return null;
  for (const o of rules.hostOverride) {
    if (o.enabled && normalizeHost(o.host) === target.host) return o;
  }
  return null;
}

export interface AppliedRequest {
  request: OutboundRequest;
  blockedBy?: string;
  override?: HostOverride;
}

/** Apply match/replace (request side), block and host-override rules to an outbound request. */
export function applyRequestRules(request: OutboundRequest, rules: RuleSet): AppliedRequest {
  const enabled = rules.matchReplace.filter((r) => r.enabled);
  const blocked = isBlocked(request.url, rules);
  if (blocked) return { request, blockedBy: blocked.name || blocked.pattern };

  let url = request.url;
  for (const rule of enabled.filter((r) => r.target === "request-url")) url = substitute(url, rule);

  let body = request.body;
  if (body !== undefined && !request.bodyBase64) {
    for (const rule of enabled.filter((r) => r.target === "request-body")) body = substitute(body as string, rule);
  }

  const headers = applyHeaderRules(
    request.headers,
    enabled.filter((r) => r.target === "request-header"),
  );

  const override = resolveOverride(url, rules) ?? undefined;
  return {
    request: { ...request, url, headers, ...(body !== undefined ? { body } : {}) },
    ...(override ? { override } : {}),
  };
}

/** Apply response-side match/replace rules to a captured response (body/headers only). */
export function applyResponseRules(response: CapturedResponse, rules: RuleSet): CapturedResponse {
  const enabled = rules.matchReplace.filter((r) => r.enabled);
  const headers = applyHeaderRules(
    response.headers,
    enabled.filter((r) => r.target === "response-header"),
  );
  let body = response.body;
  if (body !== undefined && !response.bodyBase64) {
    for (const rule of enabled.filter((r) => r.target === "response-body")) body = substitute(body as string, rule);
  }
  return { ...response, headers, ...(body !== undefined ? { body } : {}) };
}
