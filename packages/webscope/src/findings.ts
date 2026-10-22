import type { CapturedResponse, Finding, FindingSeverity, HistoryEntry, HttpHeader, SitemapNode } from "./types.js";

export type { Finding, FindingSeverity, SitemapNode } from "./types.js";

function header(headers: HttpHeader[], name: string): string | undefined {
  const lower = name.toLowerCase();
  const found = headers.find((h) => h.name.toLowerCase() === lower);
  return found?.value;
}

function allHeaders(headers: HttpHeader[], name: string): string[] {
  const lower = name.toLowerCase();
  return headers.filter((h) => h.name.toLowerCase() === lower).map((h) => h.value);
}

function isHtml(res: CapturedResponse): boolean {
  const type = (res.mimeType ?? header(res.headers, "content-type") ?? "").toLowerCase();
  return type.includes("text/html");
}

/**
 * Passive, read-only observations over captured traffic. These never send a request or attempt an
 * exploit: they only flag things already visible in the responses (missing hardening headers,
 * insecure cookies, mixed content, version disclosure, and reflected parameters) with a short
 * explanation. Severities are advisory.
 */
export function scanFindings(entries: HistoryEntry[]): Finding[] {
  const out: Finding[] = [];
  const seen = new Set<string>();
  const httpsHosts = new Set<string>();
  for (const e of entries) if (e.request.url.startsWith("https://")) httpsHosts.add(e.host);

  let counter = 0;
  const add = (f: Omit<Finding, "id">): void => {
    const key = `${f.kind}|${f.title}|${f.host}|${f.path}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ ...f, id: `f-${(counter++).toString(36)}` });
  };

  for (const e of entries) {
    const res = e.response;
    if (!res) continue;
    const https = e.request.url.startsWith("https://");
    const base = { host: e.host, path: e.path, entryId: e.id };

    // Security headers on HTML documents served over 2xx/3xx.
    if (isHtml(res) && res.status < 400) {
      if (!header(res.headers, "content-security-policy")) {
        add({ ...base, kind: "missing-security-header", severity: "low", title: "Missing Content-Security-Policy", detail: "The HTML response sets no Content-Security-Policy header, so the browser applies no page-level restriction on where scripts, styles and other resources may load from." });
      }
      if (!header(res.headers, "x-content-type-options")) {
        add({ ...base, kind: "missing-security-header", severity: "info", title: "Missing X-Content-Type-Options", detail: "Without `X-Content-Type-Options: nosniff`, some browsers may MIME-sniff the response and treat it as a different content type than declared." });
      }
      if (!header(res.headers, "x-frame-options") && !/frame-ancestors/i.test(header(res.headers, "content-security-policy") ?? "")) {
        add({ ...base, kind: "missing-security-header", severity: "info", title: "No framing protection", detail: "The response sets neither X-Frame-Options nor a CSP frame-ancestors directive, so it can be embedded in a frame by other sites." });
      }
      if (https && !header(res.headers, "strict-transport-security")) {
        add({ ...base, kind: "missing-security-header", severity: "low", title: "Missing HSTS", detail: "This HTTPS response sets no Strict-Transport-Security header, so browsers will not force future requests to use HTTPS." });
      }
    }

    // Insecure cookies.
    for (const cookie of allHeaders(res.headers, "set-cookie")) {
      const name = cookie.split("=")[0]?.trim() ?? "cookie";
      const attrs = cookie.toLowerCase();
      const missing: string[] = [];
      if (https && !attrs.includes("secure")) missing.push("Secure");
      if (!attrs.includes("httponly")) missing.push("HttpOnly");
      if (!attrs.includes("samesite")) missing.push("SameSite");
      if (missing.length > 0) {
        add({ ...base, kind: "insecure-cookie", severity: missing.includes("HttpOnly") ? "low" : "info", title: `Cookie "${name}" missing ${missing.join(", ")}`, detail: `The Set-Cookie for "${name}" omits ${missing.join(", ")}. Secure limits it to HTTPS, HttpOnly hides it from JavaScript, and SameSite limits cross-site sending.` });
      }
    }

    // Version / technology disclosure.
    for (const h of ["server", "x-powered-by", "x-aspnet-version"]) {
      const value = header(res.headers, h);
      if (value && /\d/.test(value)) {
        add({ ...base, kind: "version-disclosure", severity: "info", title: `Version disclosure in ${h}`, detail: `The ${h} header reveals "${value}", which tells a visitor what software and version the server runs.` });
      }
    }

    // Mixed content: an http:// sub-resource on a host that is otherwise served over https.
    if (!https && e.type !== "document" && httpsHosts.has(e.host)) {
      add({ ...base, kind: "mixed-content", severity: "medium", title: "Mixed content (HTTP resource)", detail: "This resource loaded over plain HTTP on a host also served over HTTPS; HTTP resources on an HTTPS page can be read or altered in transit." });
    }

    // Reflected query parameter: a query value echoed verbatim in a text response body.
    if (res.body && !res.bodyBase64 && (res.mimeType ?? "").includes("text")) {
      try {
        const url = new URL(e.request.url);
        for (const [key, value] of url.searchParams) {
          if (value.length >= 4 && res.body.includes(value)) {
            add({ ...base, kind: "reflected-parameter", severity: "low", title: `Reflected parameter "${key}"`, detail: `The value of query parameter "${key}" is echoed verbatim in the response body. Reflected input is worth reviewing for output-encoding, but this is an observation, not a confirmed vulnerability.` });
            break;
          }
        }
      } catch {
        // not a parseable URL; skip
      }
    }
  }

  const rank: Record<FindingSeverity, number> = { medium: 0, low: 1, info: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

/** Build a host -> path tree from history (Burp-style Target/sitemap). */
export function buildSitemap(entries: HistoryEntry[]): SitemapNode[] {
  const roots = new Map<string, SitemapNode>();
  const touch = (node: SitemapNode, method: string): void => {
    node.count++;
    if (!node.methods.includes(method)) node.methods.push(method);
  };
  for (const e of entries) {
    let root = roots.get(e.host);
    if (!root) {
      root = { segment: e.host, path: e.host, methods: [], count: 0, children: [] };
      roots.set(e.host, root);
    }
    touch(root, e.request.method);
    const segments = e.path.split("?")[0]!.split("/").filter(Boolean);
    let node = root;
    let acc = "";
    for (const seg of segments) {
      acc += `/${seg}`;
      let child = node.children.find((c) => c.segment === seg);
      if (!child) {
        child = { segment: seg, path: acc, methods: [], count: 0, children: [] };
        node.children.push(child);
      }
      touch(child, e.request.method);
      node = child;
    }
  }
  const sortTree = (nodes: SitemapNode[]): SitemapNode[] => {
    nodes.sort((a, b) => a.segment.localeCompare(b.segment));
    for (const n of nodes) sortTree(n.children);
    return nodes;
  };
  return sortTree([...roots.values()]);
}
