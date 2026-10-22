import type {
  EncoderOp,
  FuzzerConfig,
  HashAlg,
  HistoryFilter,
  InterceptConfig,
  InterceptEdit,
  OutboundRequest,
  RuleSet,
  Scope,
} from "@corvus/webscope";
import { encode, hash, jwtDecode } from "@corvus/webscope";
import type { WebContents } from "electron";
import type { InternalPage } from "../shared/internal-urls";
import type { WebScopeRpc } from "../shared/webscope-ipc";
import type { AppContext } from "./context";
import type { ProfileRuntime } from "./profiles";
import type { BrowserWindowCtl } from "./window";

class IpcError extends Error {}

type Handlers<T, C> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (context: C, ...args: A) => R | Promise<Awaited<R>> : never;
};

interface InternalCallContext {
  sender: WebContents;
  page: InternalPage;
  profile: ProfileRuntime;
  window: BrowserWindowCtl | undefined;
}

function obj(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null) throw new IpcError(`Invalid ${name}`);
  return value as Record<string, unknown>;
}
const str = (value: unknown, name: string, max = 8192): string => {
  if (typeof value !== "string" || value.length > max) throw new IpcError(`Invalid ${name}`);
  return value;
};

const WS = "webscope" as const;

export const WEBSCOPE_INTERNAL_PERMISSIONS: Record<keyof WebScopeRpc, readonly InternalPage[]> = {
  "webscope.state": [WS],
  "webscope.setEnabled": [WS],
  "webscope.history": [WS],
  "webscope.detail": [WS],
  "webscope.clearHistory": [WS],
  "webscope.getScope": [WS],
  "webscope.setScope": [WS],
  "webscope.getRules": [WS],
  "webscope.setRules": [WS],
  "webscope.send": [WS],
  "webscope.fuzz": [WS],
  "webscope.compare": [WS],
  "webscope.exportHar": [WS],
  "webscope.importHar": [WS],
  "webscope.audit": [WS],
  "webscope.encode": [WS],
  "webscope.hash": [WS],
  "webscope.jwt": [WS],
  "webscope.interceptState": [WS],
  "webscope.setInterceptConfig": [WS],
  "webscope.interceptForward": [WS],
  "webscope.interceptDrop": [WS],
  "webscope.findings": [WS],
  "webscope.sitemap": [WS],
};

export function webscopeInternalHandlers(ctx: AppContext): Handlers<WebScopeRpc, InternalCallContext> {
  const engine = (c: InternalCallContext) => ctx.webscope.engineFor(c.profile);
  return {
    "webscope.state": (c) => ctx.webscope.state(c.profile),
    "webscope.setEnabled": (_c, enabled) => ctx.webscope.setEnabled(enabled === true),
    "webscope.history": (c, filter, limit) => engine(c).queryHistory(obj(filter, "filter") as HistoryFilter, Math.min(1000, Math.max(1, Number(limit) || 200))),
    "webscope.detail": (c, id) => engine(c).getEntry(str(id, "id", 256)) ?? null,
    "webscope.clearHistory": (c) => engine(c).clearHistory(),
    "webscope.getScope": (c) => engine(c).getScope(),
    "webscope.setScope": (c, scope) => {
      engine(c).setScope(obj(scope, "scope") as unknown as Scope);
      return engine(c).getScope();
    },
    "webscope.getRules": (c) => engine(c).getRules(),
    "webscope.setRules": (c, rules) => {
      engine(c).setRules(obj(rules, "rules") as unknown as RuleSet);
      return engine(c).getRules();
    },
    "webscope.send": (c, request) => engine(c).repeaterSend(obj(request, "request") as unknown as OutboundRequest),
    "webscope.fuzz": (c, config) => engine(c).fuzz(obj(config, "config") as unknown as FuzzerConfig),
    "webscope.compare": (c, a, b) => engine(c).compare(str(a, "idA", 256), str(b, "idB", 256)),
    "webscope.exportHar": (c, ids) => engine(c).exportHar(Array.isArray(ids) ? ids.map((i) => str(i, "id", 256)) : undefined),
    "webscope.importHar": (c, json) => engine(c).importHar(json),
    "webscope.audit": (c, limit) => engine(c).auditLog(Math.min(1000, Math.max(1, Number(limit) || 200))),
    "webscope.encode": (_c, op, input) => encode(op as EncoderOp, str(input, "input", 2_000_000)),
    "webscope.hash": (_c, alg, input) => hash(alg as HashAlg, str(input, "input", 2_000_000)),
    "webscope.jwt": (_c, token) => jwtDecode(str(token, "token", 100_000)),
    "webscope.interceptState": () => ctx.webscope.interceptState(),
    "webscope.setInterceptConfig": (_c, config) => ctx.webscope.setInterceptConfig(obj(config, "config") as unknown as InterceptConfig),
    "webscope.interceptForward": (_c, id, edit) => ctx.webscope.interceptForward(str(id, "id", 256), edit ? (obj(edit, "edit") as unknown as InterceptEdit) : null),
    "webscope.interceptDrop": (_c, id) => ctx.webscope.interceptDrop(str(id, "id", 256)),
    "webscope.findings": (c) => engine(c).findings(),
    "webscope.sitemap": (c) => engine(c).sitemap(),
  };
}
