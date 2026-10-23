import type { AccessLevel } from "@corvus/shared";

const RANK: Record<AccessLevel, number> = { read: 0, standard: 1, full: 2 };

/** Tools that only observe. Everything not listed here or in FULL_TOOLS needs "standard". */
const READ_TOOLS = new Set([
  "tabs_list",
  "tab_wait_load",
  "page_snapshot",
  "screenshot",
  "find",
  "wait_for",
  "get_text",
  "extract",
  "get_html",
  "console_messages",
  "network_requests",
  "bookmarks_list",
  "history_search",
  "web_search",
  "snapshot",
  "newtab_layout",
]);

/** Tools that can run code in pages or touch the local file system. */
const FULL_TOOLS = new Set([
  "evaluate",
  "upload_file",
  "downloads_list",
  "pdf",
  // WebScope security workbench: active traffic tooling, always gated to full + scope.
  "webscope_history",
  "webscope_request_detail",
  "webscope_send",
  "webscope_fuzz",
  "webscope_scope",
  "webscope_set_rules",
  "webscope_findings",
  "webscope_sitemap",
  "webscope_intercept_queue",
  "webscope_intercept_action",
  // Scope-gated automation tools (provider/capability + full level).
  "run_flow",
  "cookies",
  "fill_fields",
  "download",
  // Saved logins and 2FA codes by reference (user opt-in + per-use approval in the browser).
  "fill_login",
  "fill_totp",
]);

/**
 * Tools that run script in a page or return raw page content (DOM, text, field values, a printed
 * copy). The server refuses them, at every access level, on a tab where the browser just filled a
 * saved password or 2FA code (`controller.secretFillLock`), until that tab navigates. The masked
 * snapshot, screenshots and input tools stay available.
 */
export const RAW_PAGE_TOOLS: ReadonlySet<string> = new Set(["evaluate", "get_html", "get_text", "extract", "find", "pdf"]);

export function requiredLevel(tool: string): AccessLevel {
  if (READ_TOOLS.has(tool)) return "read";
  if (FULL_TOOLS.has(tool)) return "full";
  return "standard";
}

export function toolAllowed(tool: string, level: AccessLevel): boolean {
  return RANK[level] >= RANK[requiredLevel(tool)];
}

export function resolveAccessLevel(opts: { accessLevel?: AccessLevel | undefined; allowEvaluate?: boolean | undefined }): AccessLevel {
  if (opts.accessLevel && opts.accessLevel in RANK) return opts.accessLevel;
  return opts.allowEvaluate ? "full" : "standard";
}
