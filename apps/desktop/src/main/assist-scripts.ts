/**
 * Isolated-world scripts for Corvus Assist and the agent overlay. Assist scripts run in their own
 * world, so page scripts can see neither the extracted text nor the saved originals of a
 * translation. Plain strings so the bundler cannot rewrite them.
 */

/** Isolated world for Assist (separate from the MCP agent world). */
export const ASSIST_WORLD_ID = 1719;

/** Upper bound for text shipped over IPC; the prompt builder trims further. */
export const READ_MAX_CHARS = 60_000;

export interface RawSection {
  heading: string;
  text: string;
}

export interface RawPage {
  url: string;
  title: string;
  lang: string;
  sections: RawSection[];
  words: number;
}

const COMMON = `
  const clean = (s) => (s || "").replace(/\\s+/g, " ").trim();
  const SKIP = "script,style,noscript,template,svg,canvas,nav,header,footer,aside,form,button,select,textarea,[aria-hidden=true],[hidden]";
  const shown = (el) => {
    if (!el.getClientRects().length) return false;
    const st = getComputedStyle(el);
    return st.visibility !== "hidden" && st.display !== "none";
  };
  const root = document.querySelector("main, [role=main], article") || document.body;
`;

/** Headings split the readable content into numbered sections; heading nodes are kept for jumps. */
export function readPageScript(): string {
  return `(() => {
  ${COMMON}
  if (!root) return { url: location.href, title: document.title, lang: document.documentElement.lang || "", sections: [], words: 0 };
  const MAX = ${READ_MAX_CHARS};
  const BLOCKS = "h1,h2,h3,h4,p,li,pre,blockquote,td,dd,dt,figcaption";
  const sections = [{ heading: clean(document.title) || "Introduction", text: "", node: null }];
  let total = 0;
  let words = 0;
  for (const el of root.querySelectorAll(BLOCKS)) {
    if (total > MAX) break;
    if (el.closest(SKIP)) continue;
    const parentBlock = el.parentElement && el.parentElement.closest("p,li,pre,blockquote,td,dd");
    if (parentBlock && root.contains(parentBlock) && !/^H[1-4]$/.test(el.tagName)) continue;
    if (!shown(el)) continue;
    const text = clean(el.innerText);
    if (!text) continue;
    if (/^H[1-4]$/.test(el.tagName)) {
      sections.push({ heading: text.slice(0, 120), text: "", node: el });
      continue;
    }
    const current = sections[sections.length - 1];
    current.text += (current.text ? "\\n" : "") + text;
    total += text.length;
    words += text.split(" ").length;
  }
  if (total < 200) {
    const all = (root.innerText || "").replace(/[ \\t\\f\\v]+/g, " ").replace(/\\n\\s*\\n\\s*/g, "\\n").trim().slice(0, MAX);
    sections.length = 0;
    sections.push({ heading: clean(document.title) || "Page", text: all, node: null });
    words = all ? all.split(/\\s+/).length : 0;
  }
  const kept = sections.filter((s) => s.text || s.node);
  window.__corvusAssistHeadings = kept.map((s) => s.node);
  return {
    url: location.href,
    title: document.title,
    lang: document.documentElement.lang || "",
    sections: kept.map((s) => ({ heading: s.heading, text: s.text })),
    words,
  };
})()`;
}

/** Scrolls to the n-th section read by readPageScript and flashes it briefly. */
export function jumpToSectionScript(index: number): string {
  return `(() => {
  const list = window.__corvusAssistHeadings || [];
  const el = list[${Math.max(0, Math.floor(index))}];
  if (!el || !el.isConnected) return false;
  el.scrollIntoView({ block: "start", behavior: "smooth" });
  if (el.animate) el.animate([{ backgroundColor: "rgba(109, 92, 240, 0.28)" }, { backgroundColor: "transparent" }], { duration: 1600, easing: "ease-out" });
  return true;
})()`;
}

export function selectionScript(): string {
  return `(() => String(getSelection() || "").slice(0, 4000))()`;
}

/**
 * Collects the next batch of visible text nodes for translation, starting after the ones already
 * translated. Node references and originals stay in this isolated world.
 */
export function collectSegmentsScript(maxSegments: number, maxChars: number): string {
  return `(() => {
  ${COMMON}
  const state = window.__corvusTx || (window.__corvusTx = { nodes: [], originals: [], done: new Set(), active: false, cursor: 0 });
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const value = node.nodeValue || "";
      if (value.trim().length < 2 || !/[\\p{L}]/u.test(value)) return NodeFilter.FILTER_REJECT;
      const parent = node.parentElement;
      if (!parent || parent.closest("script,style,noscript,template,code,pre,kbd,samp,textarea,[contenteditable=''],[contenteditable=true],[translate=no],.notranslate")) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const batch = [];
  let chars = 0;
  let more = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (state.done.has(node)) continue;
    if (!shown(node.parentElement)) continue;
    const text = node.nodeValue.trim().slice(0, 300);
    if (batch.length >= ${Math.max(1, maxSegments)} || chars + text.length > ${Math.max(100, maxChars)}) { more = true; break; }
    batch.push(node);
    chars += text.length;
  }
  state.pending = batch;
  return { segments: batch.map((n) => n.nodeValue.trim().slice(0, 300)), more };
})()`;
}

/** Replaces the pending batch with translations (null = keep). Returns how many nodes changed. */
export function applyTranslationsScript(translations: Array<string | null>): string {
  return `(() => {
  const state = window.__corvusTx;
  if (!state || !state.pending) return 0;
  const values = ${JSON.stringify(translations)};
  let changed = 0;
  state.pending.forEach((node, i) => {
    state.done.add(node);
    const value = values[i];
    if (typeof value !== "string" || !node.isConnected) return;
    const original = node.nodeValue;
    const lead = original.match(/^\\s*/)[0];
    const trail = original.match(/\\s*$/)[0];
    state.nodes.push(node);
    state.originals.push(original);
    node.nodeValue = lead + value + trail;
    changed++;
  });
  state.pending = null;
  state.active = true;
  return changed;
})()`;
}

export function restoreTranslationScript(): string {
  return `(() => {
  const state = window.__corvusTx;
  if (!state) return 0;
  state.nodes.forEach((node, i) => { if (node.isConnected) node.nodeValue = state.originals[i]; });
  const n = state.nodes.length;
  window.__corvusTx = undefined;
  return n;
})()`;
}

export interface RefBox {
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
  secret: boolean;
}

/** Scrolls an agent element ref into view and describes its box (viewport CSS px) for the overlay. */
export function describeRefScript(ref: string): string {
  return `(() => {
  const el = document.querySelector('[data-corvus-ref="' + ${JSON.stringify(ref)}.replace(/["\\\\]/g, "") + '"]');
  if (!el) return null;
  el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  const r = el.getBoundingClientRect();
  const clean = (s) => (s || "").replace(/\\s+/g, " ").trim();
  const label = clean(el.getAttribute("aria-label") || (el.labels && el.labels[0] && el.labels[0].innerText) || el.innerText || el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("name") || el.value || "").slice(0, 60);
  const secret = el.tagName === "INPUT" && (el.getAttribute("type") || "").toLowerCase() === "password";
  return { x: r.left, y: r.top, width: r.width, height: r.height, label, secret };
})()`;
}
