/**
 * Page reading for MCP clients (find, get_text, extract, get_html, wait_for): scripts run in the
 * agent's isolated world like page-scripts.ts, and return plain data. Password, one-time-code and
 * card values never leave the page through them (outerHTML carries attributes only, not live values).
 */
import type { ExtractKind, FindQuery } from "@corvus/shared";
import { findRef, ROLE_NAME_FNS } from "./page-scripts";

/** Visibility, the role a heading or image gets, and the page's main text, shared by the scripts below. */
const READ_FNS = `
  ${ROLE_NAME_FNS}
  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return false;
    const style = getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) > 0;
  };
  const fullRole = (el) => {
    const tag = el.tagName;
    if (!el.getAttribute("role") && /^H[1-6]$/.test(tag)) return "heading";
    if (!el.getAttribute("role") && tag === "IMG") return "img";
    if (!el.getAttribute("role") && tag === "LI") return "listitem";
    if (!el.getAttribute("role") && tag === "P") return "paragraph";
    return roleOf(el);
  };
  const squash = (s) => (s || "").replace(/[ \\t\\f\\v\\u00a0]+/g, " ").replace(/\\n\\s*\\n\\s*/g, "\\n\\n").trim();
  const mainText = () => {
    const doc = document;
    const main = doc.querySelector("main, [role=main], article");
    const chromeLike = "nav, header, footer, aside, script, style, noscript, template, [aria-hidden=true]";
    let raw = main
      ? main.innerText
      : Array.from(doc.body ? doc.body.children : []).filter((c) => !c.matches(chromeLike)).map((c) => c.innerText || "").join("\\n");
    if (!(raw || "").trim() && doc.body) raw = doc.body.innerText;
    return squash(raw);
  };
  const refOf = (el) => {
    window.__corvusRefSeq = window.__corvusRefSeq || 0;
    let ref = el.getAttribute("data-corvus-ref");
    if (!ref) {
      window.__corvusRefSeq += 1;
      ref = "e" + window.__corvusRefSeq;
      el.setAttribute("data-corvus-ref", ref);
    }
    return ref;
  };`;

/** Elements matching visible text, a CSS selector and/or a role, as snapshot elements with boxes. */
export function findScript(query: FindQuery): string {
  return `(() => {
  ${READ_FNS}
  const q = ${JSON.stringify({ text: query.text ?? null, selector: query.selector ?? null, role: query.role ?? null, exact: query.exact === true, limit: query.limit ?? 10 })};
  let candidates;
  if (q.selector) {
    try { candidates = Array.from(document.querySelectorAll(q.selector)); } catch (e) { return { error: "Invalid CSS selector: " + q.selector }; }
  } else {
    candidates = Array.from(document.querySelectorAll("body *"));
  }
  const needle = q.text ? clean(q.text).toLowerCase() : null;
  const textOf = (el) => clean(el.innerText || el.value || el.getAttribute("aria-label") || el.getAttribute("alt") || "").toLowerCase();
  const hits = [];
  for (const el of candidates) {
    if (hits.length >= 2000) break;
    if (["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"].includes(el.tagName) || !visible(el)) continue;
    if (q.role && fullRole(el) !== q.role) continue;
    if (needle) {
      const t = textOf(el);
      if (q.exact ? t !== needle : !t.includes(needle)) continue;
    }
    hits.push(el);
  }
  // A text search keeps the innermost match: its ancestors contain the same text.
  const picked = needle && !q.selector ? hits.filter((el, i) => !(hits[i + 1] && el.contains(hits[i + 1]))) : hits;
  return picked.slice(0, q.limit).map((el) => {
    const r = el.getBoundingClientRect();
    const out = { ref: refOf(el), role: fullRole(el), name: (nameOf(el) || clean(el.innerText || "")).slice(0, 100), bbox: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] };
    if (/^H[1-6]$/.test(el.tagName)) out.level = Number(el.tagName[1]);
    const type = (el.getAttribute("type") || "").toLowerCase();
    if ((el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") && type !== "password" && !el.hasAttribute("data-corvus-secret") && el.value) out.value = String(el.value).slice(0, 100);
    return out;
  });
})()`;
}

/** Plain text of an element (ref) or of the page's main content, capped at maxChars. */
export function textScript(ref: string | undefined, maxChars: number): string {
  return `(() => {
  ${READ_FNS}
  const MAX = ${Math.max(100, Math.floor(maxChars))};
  let text;
  ${ref ? `const el = ${findRef(ref)}; if (!el) return null; text = squash(el.innerText || el.textContent || "");` : "text = mainText();"}
  return { text: text.slice(0, MAX), truncated: text.length > MAX };
})()`;
}

/** Trimmed outerHTML of an element (ref or selector, else the body): no scripts, styles, comments or SVG bodies. */
export function htmlScript(ref: string | undefined, selector: string | undefined, maxChars: number): string {
  const pick = ref ? findRef(ref) : selector ? `document.querySelector(${JSON.stringify(selector)})` : "document.body";
  return `(() => {
  const MAX = ${Math.max(100, Math.floor(maxChars))};
  let el;
  try { el = ${pick}; } catch (e) { return { error: "Invalid CSS selector" }; }
  if (!el) return null;
  const copy = el.cloneNode(true);
  copy.querySelectorAll("script, style, noscript, template, link[rel=stylesheet]").forEach((n) => n.remove());
  copy.querySelectorAll("svg").forEach((n) => { n.innerHTML = ""; });
  const walker = document.createTreeWalker(copy, NodeFilter.SHOW_COMMENT);
  const comments = [];
  while (walker.nextNode()) comments.push(walker.currentNode);
  comments.forEach((c) => c.remove());
  [copy, ...copy.querySelectorAll("*")].forEach((n) => {
    for (const a of Array.from(n.attributes)) if (/^on/i.test(a.name)) n.removeAttribute(a.name);
  });
  const html = copy.outerHTML.replace(/\\s{2,}/g, " ");
  return { html: html.slice(0, MAX), truncated: html.length > MAX };
})()`;
}

/**
 * Structured data: the main content (or an element) as markdown, tables as rows, links, or the
 * page's metadata (description, canonical, OpenGraph, Twitter, JSON-LD types).
 */
export function extractScript(kind: ExtractKind, ref: string | undefined, maxChars: number, limit: number): string {
  return `(() => {
  ${READ_FNS}
  const KIND = ${JSON.stringify(kind)};
  const MAX = ${Math.max(200, Math.floor(maxChars))};
  const LIMIT = ${Math.max(1, Math.floor(limit))};
  const scope = ${ref ? findRef(ref) : `document.querySelector("main, [role=main], article") || document.body`};
  if (!scope) return null;
  const out = { url: location.href, title: document.title, truncated: false };
  if (KIND === "links") {
    const seen = new Set();
    const links = [];
    for (const a of scope.querySelectorAll("a[href]")) {
      if (!/^https?:/i.test(a.href) || seen.has(a.href) || !visible(a)) continue;
      seen.add(a.href);
      links.push({ text: clean(a.innerText || a.getAttribute("aria-label") || "").slice(0, 200), href: a.href });
      if (links.length >= LIMIT) { out.truncated = true; break; }
    }
    out.links = links;
    return out;
  }
  if (KIND === "tables") {
    const tables = [];
    for (const t of (scope.tagName === "TABLE" ? [scope] : Array.from(scope.querySelectorAll("table")))) {
      if (tables.length >= LIMIT) { out.truncated = true; break; }
      const rows = Array.from(t.rows).map((r) => Array.from(r.cells).map((c) => clean(c.innerText).slice(0, 300)));
      const headRow = t.tHead && t.tHead.rows[0] ? t.tHead.rows[0] : t.rows[0] && Array.from(t.rows[0].cells).every((c) => c.tagName === "TH") ? t.rows[0] : null;
      const headers = headRow ? Array.from(headRow.cells).map((c) => clean(c.innerText).slice(0, 200)) : [];
      const body = headRow ? rows.filter((_, i) => t.rows[i] !== headRow) : rows;
      const table = { ref: refOf(t), headers, rows: body.slice(0, LIMIT), totalRows: body.length };
      const caption = t.caption ? clean(t.caption.innerText) : "";
      if (caption) table.caption = caption.slice(0, 200);
      tables.push(table);
    }
    out.tables = tables;
    return out;
  }
  if (KIND === "metadata") {
    const meta = {};
    const put = (k, v) => { if (v && !(k in meta)) meta[k] = String(v).slice(0, 500); };
    put("title", document.title);
    put("lang", document.documentElement.lang);
    for (const m of document.querySelectorAll("meta[name], meta[property]")) {
      const k = (m.getAttribute("property") || m.getAttribute("name") || "").toLowerCase();
      if (/^(description|author|keywords|og:|twitter:|article:)/.test(k)) put(k, m.getAttribute("content"));
    }
    const canonical = document.querySelector("link[rel=canonical]");
    if (canonical) put("canonical", canonical.href);
    const types = [];
    for (const s of document.querySelectorAll("script[type='application/ld+json']")) {
      try {
        const data = JSON.parse(s.textContent || "");
        for (const item of [].concat(data["@graph"] || data)) if (item && item["@type"]) types.push([].concat(item["@type"]).join("/"));
      } catch (e) {}
    }
    if (types.length) put("jsonld", types.slice(0, 20).join(", "));
    out.metadata = meta;
    return out;
  }
  // Markdown of the scope's visible content.
  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "NAV", "FOOTER", "IFRAME", "BUTTON", "FORM"]);
  const hidden = (el) => el.getAttribute("aria-hidden") === "true" || getComputedStyle(el).display === "none";
  const inline = (n) => {
    let s = "";
    for (const c of n.childNodes) {
      if (c.nodeType === 3) { s += c.textContent.replace(/\\s+/g, " "); continue; }
      if (c.nodeType !== 1 || SKIP.has(c.tagName) || hidden(c)) continue;
      const t = c.tagName;
      if (t === "A") { const txt = inline(c).trim(); s += txt && /^https?:/i.test(c.href) ? "[" + txt + "](" + c.href + ")" : txt; }
      else if (t === "STRONG" || t === "B") { const txt = inline(c).trim(); if (txt) s += "**" + txt + "**"; }
      else if (t === "EM" || t === "I") { const txt = inline(c).trim(); if (txt) s += "_" + txt + "_"; }
      else if (t === "CODE") s += "\`" + c.textContent + "\`";
      else if (t === "BR") s += "\\n";
      else if (t === "IMG") { const alt = clean(c.getAttribute("alt") || ""); if (alt) s += "![" + alt + "]"; }
      else s += inline(c);
    }
    return s;
  };
  const BLOCKS = /^(P|H[1-6]|UL|OL|PRE|BLOCKQUOTE|TABLE|DIV|SECTION|ARTICLE|MAIN|HEADER|ASIDE|FIGURE|DL|HR|LI)$/;
  const lines = [];
  const block = (n) => {
    for (const c of n.children) {
      if (SKIP.has(c.tagName) || hidden(c)) continue;
      const t = c.tagName;
      if (/^H[1-6]$/.test(t)) { const txt = inline(c).trim(); if (txt) lines.push("#".repeat(Number(t[1])) + " " + txt); }
      else if (t === "P") { const txt = inline(c).trim(); if (txt) lines.push(txt); }
      else if (t === "UL" || t === "OL") {
        let i = 0;
        for (const li of c.children) if (li.tagName === "LI") { i++; const txt = inline(li).trim(); if (txt) lines.push((t === "OL" ? i + ". " : "- ") + txt); }
      }
      else if (t === "PRE") lines.push("\`\`\`\\n" + c.textContent.replace(/\\n+$/, "") + "\\n\`\`\`");
      else if (t === "BLOCKQUOTE") { const txt = inline(c).trim(); if (txt) lines.push("> " + txt.replace(/\\n/g, "\\n> ")); }
      else if (t === "TABLE") {
        const rows = Array.from(c.rows).slice(0, 50).map((r) => "| " + Array.from(r.cells).map((x) => clean(x.innerText).replace(/\\|/g, "/")).join(" | ") + " |");
        if (rows.length) { rows.splice(1, 0, "|" + " --- |".repeat(c.rows[0].cells.length)); lines.push(rows.join("\\n")); }
      }
      else if (t === "HR") lines.push("---");
      else if (Array.from(c.children).some((k) => BLOCKS.test(k.tagName))) block(c);
      // The element itself as inline content, so a lone link keeps its [text](href).
      else { const txt = inline({ childNodes: [c] }).trim(); if (txt) lines.push(txt); }
      if (lines.join("\\n\\n").length > MAX) return;
    }
  };
  if (Array.from(scope.children).some((k) => BLOCKS.test(k.tagName))) block(scope);
  else { const txt = inline(scope).trim(); if (txt) lines.push(txt); }
  const markdown = lines.join("\\n\\n");
  out.markdown = markdown.slice(0, MAX);
  out.truncated = markdown.length > MAX;
  return out;
})()`;
}

/** The DOM parts of a wait_for condition, each true when it holds now. */
export function waitProbeScript(cond: { text?: string; textGone?: string; ref?: string; selector?: string; state?: string }): string {
  const pick = cond.ref ? findRef(cond.ref) : cond.selector ? `document.querySelector(${JSON.stringify(cond.selector)})` : "null";
  return `(() => {
  ${READ_FNS}
  const out = {};
  const page = (document.body ? document.body.innerText : "").toLowerCase();
  ${cond.text ? `out.text = page.includes(${JSON.stringify(cond.text.toLowerCase())});` : ""}
  ${cond.textGone ? `out.textGone = !page.includes(${JSON.stringify(cond.textGone.toLowerCase())});` : ""}
  ${
    cond.ref || cond.selector
      ? `let el = null;
  try { el = ${pick}; } catch (e) { return { error: "Invalid CSS selector" }; }
  const state = ${JSON.stringify(cond.state ?? "visible")};
  out.element = state === "attached" ? Boolean(el) : state === "detached" ? !el : state === "hidden" ? !el || !visible(el) : Boolean(el) && visible(el);`
      : ""
  }
  return out;
})()`;
}
