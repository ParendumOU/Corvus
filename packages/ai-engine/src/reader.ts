/**
 * Reader-mode extraction. Turns a page's raw HTML into a clean, sanitized article: Firefox-style
 * "readerable" detection, Readability extraction on linkedom, an allow-list HTML sanitizer (no
 * scripts, no event handlers, no remote-code vectors), section anchors for citations, and a
 * Markdown serializer for the reading library. The input HTML is untrusted web content.
 */
import { Readability, isProbablyReaderable } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { readingMinutes } from "./assist.js";
import { collapseWhitespace, truncate } from "./text.js";

// linkedom's node project has no DOM lib; these are the minimal surfaces the code below touches.
interface DomNode {
  nodeType: number;
  nodeValue: string | null;
  textContent: string | null;
  parentElement: DomEl | null;
  childNodes: Iterable<DomNode>;
  remove(): void;
  replaceWith(...nodes: DomNode[]): void;
}
interface DomEl extends DomNode {
  tagName: string;
  innerHTML: string;
  children: Iterable<DomEl>;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  getAttributeNames(): string[];
  closest(selector: string): DomEl | null;
  contains(other: DomNode | null): boolean;
  querySelectorAll(selector: string): Iterable<DomEl>;
}

export interface ReaderSection {
  heading: string;
  text: string;
}

export interface ReaderArticle {
  url: string;
  title: string;
  byline: string;
  siteName: string;
  lang: string;
  dir: "ltr" | "rtl" | "";
  /** Sanitized article HTML (headings carry data-corvus-section="n"). */
  content: string;
  textContent: string;
  excerpt: string;
  wordCount: number;
  readingMinutes: number;
  /** Numbered sections (index 0 is the lead); headings in `content` share the index. */
  sections: ReaderSection[];
}

/** Firefox's isProbablyReaderable over linkedom: is this page worth a reader view? */
export function isReaderable(html: string): boolean {
  try {
    const { document } = parseHTML(html);
    return isProbablyReaderable(document as never);
  } catch {
    return false;
  }
}

const REMOVE_TAGS = new Set([
  "script", "style", "noscript", "template", "iframe", "frame", "object", "embed", "applet", "form",
  "input", "button", "select", "textarea", "svg", "math", "link", "meta", "base", "audio", "video",
  "canvas",
]);

const ALLOWED_TAGS = new Set([
  "p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "code", "kbd", "samp",
  "em", "strong", "b", "i", "u", "s", "sub", "sup", "mark", "small", "a", "ul", "ol", "li", "dl",
  "dt", "dd", "img", "figure", "figcaption", "picture", "table", "thead", "tbody", "tfoot", "tr",
  "th", "td", "caption", "colgroup", "col", "span", "div", "section", "article", "abbr", "cite",
  "time", "address", "del", "ins", "wbr",
]);

const ALLOWED_ATTRS: Record<string, Set<string>> = {
  a: new Set(["href", "title"]),
  img: new Set(["src", "alt", "title", "width", "height"]),
  td: new Set(["colspan", "rowspan"]),
  th: new Set(["colspan", "rowspan", "scope"]),
  col: new Set(["span"]),
  colgroup: new Set(["span"]),
  time: new Set(["datetime"]),
};

const BLOCK_SELECTOR = "h1,h2,h3,h4,h5,h6,p,li,pre,blockquote,td,dd,dt,figcaption";

function safeUrl(value: string | null, base: string): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^(javascript|data|vbscript|file):/i.test(trimmed)) {
    // data: images are safe to keep; block everything else in that family.
    return /^data:image\//i.test(trimmed) ? trimmed : null;
  }
  try {
    return new URL(trimmed, base).toString();
  } catch {
    return null;
  }
}

/** Depth-first allow-list sanitizer. Disallowed structural tags are unwrapped, unsafe tags dropped. */
function sanitizeElement(el: DomEl, base: string): void {
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === 3) continue; // text
    if (child.nodeType !== 1) {
      child.remove();
      continue;
    }
    const element = child as DomEl;
    const tag = element.tagName.toLowerCase();
    if (REMOVE_TAGS.has(tag)) {
      element.remove();
      continue;
    }
    if (!ALLOWED_TAGS.has(tag)) {
      sanitizeElement(element, base);
      element.replaceWith(...Array.from(element.childNodes));
      continue;
    }
    const allowed = ALLOWED_ATTRS[tag];
    for (const name of element.getAttributeNames()) {
      if (!allowed || !allowed.has(name) || name.startsWith("on")) {
        element.removeAttribute(name);
        continue;
      }
      if (name === "href" || name === "src") {
        const resolved = safeUrl(element.getAttribute(name), base);
        if (resolved) element.setAttribute(name, resolved);
        else element.removeAttribute(name);
      }
    }
    if (tag === "a") element.setAttribute("rel", "noreferrer noopener nofollow");
    sanitizeElement(element, base);
  }
}

const clean = (s: string | null | undefined): string => collapseWhitespace(s ?? "");

/** Numbers headings (data-corvus-section) and groups block text into sections. */
function computeSections(body: DomEl, title: string): ReaderSection[] {
  const sections: ReaderSection[] = [{ heading: title || "Introduction", text: "" }];
  for (const el of Array.from(body.querySelectorAll(BLOCK_SELECTOR))) {
    const isHeading = /^H[1-6]$/.test(el.tagName);
    if (!isHeading) {
      const parentBlock = el.parentElement?.closest("p,li,pre,blockquote,td,dd");
      if (parentBlock && body.contains(parentBlock)) continue;
    }
    const text = clean(el.textContent);
    if (isHeading) {
      el.setAttribute("data-corvus-section", String(sections.length));
      sections.push({ heading: text.slice(0, 140) || "Section", text: "" });
    } else if (text) {
      const current = sections[sections.length - 1]!;
      current.text += (current.text ? "\n" : "") + text;
    }
  }
  return sections.filter((s) => s.text || s.heading);
}

const MIN_ARTICLE_CHARS = 250;

/**
 * Extracts a clean article, or null when the page has too little article-like content. The result
 * HTML is sanitized and safe to render with innerHTML in a trusted reader view.
 */
export function extractArticle(html: string, url: string, base: string = url): ReaderArticle | null {
  let parsed: ReturnType<Readability["parse"]>;
  try {
    const { document } = parseHTML(html);
    parsed = new Readability(document as never, { charThreshold: 200, keepClasses: false }).parse();
  } catch {
    return null;
  }
  const content = parsed?.content ?? "";
  if (!parsed || !content || (parsed.length ?? 0) < MIN_ARTICLE_CHARS) return null;

  const { document: doc } = parseHTML(`<!doctype html><html><head></head><body>${content}</body></html>`);
  const body = doc.body as unknown as DomEl;
  sanitizeElement(body, base);

  const title = clean(parsed.title) || "Untitled";
  const sections = computeSections(body, title);
  const textContent = clean(parsed.textContent);
  const wordCount = textContent ? textContent.split(/\s+/).length : 0;
  const dir = parsed.dir === "rtl" ? "rtl" : parsed.dir === "ltr" ? "ltr" : "";

  return {
    url,
    title,
    byline: clean(parsed.byline),
    siteName: clean(parsed.siteName),
    lang: clean(parsed.lang),
    dir,
    content: body.innerHTML,
    textContent,
    excerpt: truncate(clean(parsed.excerpt) || textContent, 280),
    wordCount,
    readingMinutes: readingMinutes(textContent),
    sections,
  };
}

// --------------------------------------------------------------- Markdown export

function escapeMd(text: string): string {
  return text.replace(/([\\`*_{}\[\]()#+\-!>])/g, "\\$1");
}

function inlineMarkdown(node: DomNode): string {
  let out = "";
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === 3) {
      out += escapeMd(collapseWhitespace(child.nodeValue ?? ""));
      continue;
    }
    if (child.nodeType !== 1) continue;
    const el = child as DomEl;
    const tag = el.tagName.toLowerCase();
    const inner = inlineMarkdown(el);
    switch (tag) {
      case "a": {
        const href = el.getAttribute("href");
        out += href ? `[${inner}](${href})` : inner;
        break;
      }
      case "strong":
      case "b":
        out += `**${inner}**`;
        break;
      case "em":
      case "i":
        out += `*${inner}*`;
        break;
      case "code":
        out += `\`${collapseWhitespace(el.textContent ?? "")}\``;
        break;
      case "br":
        out += "\n";
        break;
      case "img": {
        const src = el.getAttribute("src");
        out += src ? `![${el.getAttribute("alt") ?? ""}](${src})` : "";
        break;
      }
      default:
        out += inner;
    }
  }
  return out;
}

function blockMarkdown(el: DomEl, out: string[], depth: number): void {
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === 3) {
      const text = collapseWhitespace(node.nodeValue ?? "");
      if (text) out.push(escapeMd(text));
      continue;
    }
    if (node.nodeType !== 1) continue;
    const child = node as DomEl;
    const tag = child.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag)) {
      out.push(`${"#".repeat(Number(tag[1]))} ${collapseWhitespace(inlineMarkdown(child))}`);
    } else if (tag === "p") {
      const line = inlineMarkdown(child).trim();
      if (line) out.push(line);
    } else if (tag === "blockquote") {
      const nested: string[] = [];
      blockMarkdown(child, nested, depth);
      out.push(nested.map((l) => `> ${l}`).join("\n"));
    } else if (tag === "ul" || tag === "ol") {
      const items = Array.from(child.children).filter((c) => c.tagName.toLowerCase() === "li");
      items.forEach((li, i) => {
        const marker = tag === "ol" ? `${i + 1}.` : "-";
        out.push(`${"  ".repeat(depth)}${marker} ${collapseWhitespace(inlineMarkdown(li))}`);
        for (const sub of Array.from(li.children)) {
          const subtag = sub.tagName.toLowerCase();
          if (subtag === "ul" || subtag === "ol") blockMarkdown(sub, out, depth + 1);
        }
      });
    } else if (tag === "pre") {
      out.push(`\`\`\`\n${child.textContent ?? ""}\n\`\`\``);
    } else if (tag === "hr") {
      out.push("---");
    } else if (tag === "img") {
      const src = child.getAttribute("src");
      if (src) out.push(`![${child.getAttribute("alt") ?? ""}](${src})`);
    } else {
      blockMarkdown(child, out, depth);
    }
  }
}

/** Serializes an article (metadata header + body) to Markdown for the reading library. */
export function articleToMarkdown(article: Pick<ReaderArticle, "title" | "url" | "byline" | "siteName" | "content">): string {
  const head = [`# ${article.title}`];
  const meta: string[] = [];
  if (article.byline) meta.push(article.byline);
  if (article.siteName) meta.push(article.siteName);
  if (meta.length > 0) head.push(`*${meta.join(" · ")}*`);
  head.push(`<${article.url}>`);

  const blocks: string[] = [];
  try {
    const { document } = parseHTML(`<!doctype html><html><head></head><body>${article.content}</body></html>`);
    blockMarkdown(document.body as unknown as DomEl, blocks, 0);
  } catch {
    // Keep the header even if the body cannot be parsed.
  }
  return `${[head.join("\n\n"), blocks.filter(Boolean).join("\n\n")].filter(Boolean).join("\n\n").trim()}\n`;
}
