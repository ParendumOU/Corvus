// Preload attached to every tab. It exposes window.corvusInternal only on corvus:// pages, so
// regular web content never sees an IPC surface. The main process re-validates every call.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { ANNOTATION_COLORS, ANNOTATION_COLOR_HEX, MAX_QUOTE_CHARS, buildAnchor, locateAnchor } from "../shared/annotations";
import { ANNOTATION_APPLY_CHANNEL, ANNOTATION_CREATE_CHANNEL, ANNOTATION_DELETE_CHANNEL, ANNOTATION_UPDATE_CHANNEL, type AnnotationApplyMessage } from "../shared/annotations-ipc";
import { AUTOFILL_CAPTURE_CHANNEL, AUTOFILL_FIELD_CHANNEL } from "../shared/credentials-ipc";
import { FLOW_CAPTURE_CHANNEL, FLOW_RECORD_SET_CHANNEL } from "../shared/flow-ipc";
import { INTERNAL_EVENT, INTERNAL_RPC, type InternalBridge, type InternalEvent } from "../shared/ipc";

// The preload is type-checked with the Node project (no DOM lib); declare the globals it reads.
declare const location: { protocol: string; origin: string };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const document: any;
declare const window: { top: unknown };

if (location.protocol === "corvus:" && window.top === window) {
  const bridge: InternalBridge = {
    call: ((method: string, ...args: unknown[]) => ipcRenderer.invoke(INTERNAL_RPC, method, args)) as InternalBridge["call"],
    onEvent: (listener) => {
      const handler = (_event: IpcRendererEvent, message: InternalEvent): void => listener(message);
      ipcRenderer.on(INTERNAL_EVENT, handler);
      return () => ipcRenderer.off(INTERNAL_EVENT, handler);
    },
  };
  contextBridge.exposeInMainWorld("corvusInternal", bridge);
}

// On web pages, capture a submitted login synchronously (before navigation) so the main process can
// offer to save it. Runs in the preload's isolated world: it reads the DOM but exposes nothing to the
// page. The main process re-validates the sender and only ever stores it after an explicit user action.
if ((location.protocol === "https:" || location.protocol === "http:") && window.top === window) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const usernameLikely = (el: any): boolean => {
    const hint = `${el.name || ""} ${el.id || ""} ${el.getAttribute("autocomplete") || ""} ${el.getAttribute("type") || ""}`.toLowerCase();
    return /email|user|login|account|phone|tel/.test(hint);
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const captureFrom = (scope: any): void => {
    try {
      const passwords = Array.prototype.slice.call(scope.querySelectorAll("input[type=password]"));
      const pass = passwords.find((p: any) => p.value);
      if (!pass) return;
      const fields = Array.prototype.slice
        .call((pass.form || scope).querySelectorAll("input[type=text], input[type=email], input[type=tel], input:not([type])"))
        .filter((el: any) => el !== pass && el.value);
      const user = fields.filter(usernameLikely).pop() || fields.pop() || null;
      ipcRenderer.send(AUTOFILL_CAPTURE_CHANNEL, {
        origin: location.origin,
        username: user ? String(user.value || "") : "",
        password: String(pass.value),
      });
    } catch {
      // never let autofill break a page's own submit
    }
  };
  document.addEventListener("submit", (e: { target: unknown }) => captureFrom(e.target || document), true);

  // A click in a login field (a password field, or a text field of a form that has one) reports the
  // field's box so the main process can list the saved logins right under it. Only the box is sent.
  const TEXT_TYPES = ["text", "email", "tel", "password"];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const isLoginField = (el: any): boolean => {
    if (!el || el.tagName !== "INPUT" || el.disabled || el.readOnly) return false;
    const type = String(el.getAttribute("type") || "text").toLowerCase();
    if (!TEXT_TYPES.includes(type)) return false;
    return type === "password" || Boolean((el.form || document).querySelector("input[type=password]"));
  };
  document.addEventListener(
    "click",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (e: any) => {
      try {
        if (!e.isTrusted || e.button !== 0 || !isLoginField(e.target)) return;
        const r = e.target.getBoundingClientRect();
        ipcRenderer.send(AUTOFILL_FIELD_CHANNEL, { x: r.left, y: r.top, width: r.width, height: r.height });
      } catch {
        // never let autofill break a page's own click handling
      }
    },
    true,
  );
}

// Flow recorder: while recording is enabled for this tab, report the user's clicks, field edits and
// submits as robust targets (role + accessible name + nth-of-kind, computed exactly as page_snapshot
// does, so replay re-matches them). Secret fields report no value. Runs in the preload's isolated
// world; exposes nothing to the page. The main process re-validates the sender and gates every action.
if ((location.protocol === "https:" || location.protocol === "http:") && window.top === window) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d: any = document;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w: any = window;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const loc: any = location;
  let recording = false;
  ipcRenderer.on(FLOW_RECORD_SET_CHANNEL, (_e: IpcRendererEvent, on: unknown) => {
    recording = on === true;
  });

  const SELECTOR = [
    "a[href]", "button", "input:not([type=hidden])", "textarea", "select", "summary",
    "[role=button]", "[role=link]", "[role=checkbox]", "[role=radio]", "[role=tab]", "[role=menuitem]",
    "[role=option]", "[role=switch]", "[role=combobox]", "[role=textbox]", "[role=searchbox]",
    "[contenteditable='']", "[contenteditable=true]",
  ].join(",");
  const SECRET = /password|passcode|\bpin\b|cvv|cvc|card|credit|security\s?code|otp|2fa/i;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const clean = (s: any): string => (s || "").replace(/\s+/g, " ").trim();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const visible = (el: any): boolean => {
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return false;
    const style = w.getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) > 0;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const roleOf = (el: any): string => {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button" || tag === "summary") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (["button", "submit", "reset", "image"].includes(type)) return "button";
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "range") return "slider";
      if (type === "search") return "searchbox";
      return "textbox";
    }
    if (el.isContentEditable) return "textbox";
    return tag;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const nameOf = (el: any): string => {
    const aria = el.getAttribute("aria-label");
    if (aria) return clean(aria);
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const label = labelledBy.split(/\s+/).map((id: string) => d.getElementById(id)).filter(Boolean).map((n: any) => n.innerText).join(" ");
      if (clean(label)) return clean(label);
    }
    if (el.labels && el.labels.length > 0) return clean(el.labels[0].innerText);
    const own = clean(el.innerText || el.value || "");
    if (own && el.tagName !== "INPUT" && el.tagName !== "TEXTAREA" && el.tagName !== "SELECT") return own;
    const img = el.querySelector && el.querySelector("img[alt]");
    return clean(el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("alt") || (img && img.getAttribute("alt")) || el.getAttribute("name") || own);
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cssPath = (el: any): string => {
    try {
      const parts: string[] = [];
      let node = el;
      for (let depth = 0; node && node.nodeType === 1 && depth < 4; depth++) {
        let part = node.tagName.toLowerCase();
        if (node.id) {
          parts.unshift(`${part}#${node.id}`);
          break;
        }
        const parent = node.parentElement;
        if (parent) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const sibs = Array.prototype.filter.call(parent.children, (c: any) => c.tagName === node.tagName);
          if (sibs.length > 1) part += `:nth-of-type(${Array.prototype.indexOf.call(sibs, node) + 1})`;
        }
        parts.unshift(part);
        node = node.parentElement;
      }
      return parts.join(" > ").slice(0, 400);
    } catch {
      return "";
    }
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const descriptorFor = (start: any): { role: string; name: string; index: number; tag: string; selector: string } | undefined => {
    let node = start;
    while (node && node.nodeType === 1 && !(node.matches && node.matches(SELECTOR))) node = node.parentElement;
    const target = node && node.nodeType === 1 && node.matches && node.matches(SELECTOR) ? node : null;
    if (!target) return undefined;
    const role = roleOf(target);
    const name = nameOf(target).slice(0, 80);
    let index = 0;
    const all = d.querySelectorAll(SELECTOR);
    for (let k = 0; k < all.length; k++) {
      const cand = all[k];
      if (cand === target) break;
      if (cand.disabled || !visible(cand) || (cand.closest && cand.closest("[aria-hidden=true]"))) continue;
      if (roleOf(cand) === role && nameOf(cand).slice(0, 80) === name) index++;
    }
    return { role, name, index, tag: target.tagName.toLowerCase(), selector: cssPath(target) };
  };
  const send = (kind: string, target: unknown, value?: string, secret?: boolean): void => {
    ipcRenderer.send(FLOW_CAPTURE_CHANNEL, { kind, url: loc.href, target, value, secret });
  };

  d.addEventListener(
    "click",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (e: any) => {
      if (!recording) return;
      try {
        const desc = descriptorFor(e.target);
        if (!desc) return;
        // Focusing a text field is not an action; its value is captured on change.
        if (desc.role === "textbox" || desc.role === "searchbox") return;
        send("click", desc);
      } catch {
        // never let recording break the page
      }
    },
    true,
  );

  d.addEventListener(
    "change",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (e: any) => {
      if (!recording) return;
      try {
        const el = e.target;
        if (!el || !el.tagName) return;
        const tag = el.tagName;
        const type = (el.getAttribute && (el.getAttribute("type") || "")).toLowerCase();
        const skipInput = ["checkbox", "radio", "button", "submit", "reset", "file", "range", "color", "image", "hidden"];
        const textLike = (tag === "INPUT" && !skipInput.includes(type)) || tag === "TEXTAREA" || el.isContentEditable;
        if (!textLike) return;
        const desc = descriptorFor(el);
        if (!desc) return;
        const hint = `${el.name || ""} ${el.id || ""} ${(el.getAttribute && el.getAttribute("autocomplete")) || ""} ${desc.name}`;
        const secret = type === "password" || SECRET.test(hint);
        const value = secret ? "" : String(el.isContentEditable ? el.innerText || "" : el.value || "").slice(0, 2000);
        send("input", desc, value, secret);
      } catch {
        // never let recording break the page
      }
    },
    true,
  );

  d.addEventListener(
    "submit",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (e: any) => {
      if (!recording) return;
      try {
        const form = e.target;
        const btn = form && form.querySelector && form.querySelector("button[type=submit], input[type=submit], button:not([type])");
        send("submit", btn ? descriptorFor(btn) : undefined);
      } catch {
        // never let recording break the page
      }
    },
    true,
  );
}

// Page annotations: let the user highlight a selection (color + optional note) and re-apply saved
// highlights on revisit. Runs in the preload's isolated world (DOM access + ipcRenderer, but invisible
// to the page). DOM work stays here; the main process owns persistence and re-validates every change.
// Highlights render through the CSS Custom Highlight API so the page DOM is never mutated.
if ((location.protocol === "https:" || location.protocol === "http:") && window.top === window) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d: any = document;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w: any = window;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const loc: any = location;
  const supported = typeof w.CSS !== "undefined" && w.CSS && w.CSS.highlights && typeof w.Highlight !== "undefined";
  const MAX_TEXT = 3_000_000;
  const UI_ATTR = "data-corvus-annotations";

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  interface Applied { id: string; color: string; note: string; range: any }
  let applied: Applied[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const base = new Map<any, number>();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const acceptText = (node: any): boolean => {
    const parent = node.parentNode;
    if (!parent || !parent.tagName) return false;
    const tag = parent.tagName.toUpperCase();
    if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT") return false;
    if (parent.closest && parent.closest(`[${UI_ATTR}]`)) return false;
    return typeof node.data === "string" && node.data.length > 0;
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const makeWalker = (): any =>
    d.createTreeWalker(d.body, 4 /* SHOW_TEXT */, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      acceptNode: (node: any) => (acceptText(node) ? 1 /* ACCEPT */ : 2 /* REJECT */),
    });

  // Concatenate accepted text nodes in document order; record each node's start offset for mapping back.
  const buildText = (): string => {
    base.clear();
    let text = "";
    const walker = makeWalker();
    let node = walker.nextNode();
    while (node) {
      base.set(node, text.length);
      text += node.data;
      if (text.length > MAX_TEXT) break;
      node = walker.nextNode();
    }
    return text;
  };

  // Character index (within the concatenated text) of a DOM boundary point.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const indexOfPoint = (container: any, offset: number): number | null => {
    if (!d.body) return null;
    const probe = d.createRange();
    probe.setStart(d.body, 0);
    try {
      probe.setEnd(container, offset);
    } catch {
      return null;
    }
    let len = 0;
    const walker = makeWalker();
    let n = walker.nextNode();
    while (n) {
      if (probe.comparePoint(n, 0) > 0) break;
      if (probe.comparePoint(n, n.data.length) <= 0) {
        len += n.data.length;
      } else {
        if (container === n) len += offset;
        else {
          let k = 0;
          while (k < n.data.length && probe.comparePoint(n, k + 1) <= 0) k++;
          len += k;
        }
        break;
      }
      n = walker.nextNode();
    }
    return len;
  };

  // Map a character index back to a {node, offset} DOM position (base is in document order).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const locate = (index: number): { node: any; offset: number } | null => {
    for (const [node, start] of base) {
      if (index >= start && index <= start + node.data.length) return { node, offset: index - start };
    }
    return null;
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rangeFromIndices = (start: number, end: number): any => {
    const s = locate(start);
    const e = locate(end);
    if (!s || !e) return null;
    try {
      const range = d.createRange();
      range.setStart(s.node, s.offset);
      range.setEnd(e.node, e.offset);
      return range;
    } catch {
      return null;
    }
  };

  // ---- UI host (shadow DOM, immune to and invisible to the page) ----
  const host = d.createElement("div");
  host.setAttribute(UI_ATTR, "");
  host.style.cssText = "all:initial;position:fixed;z-index:2147483647;top:0;left:0";
  const shadow = host.attachShadow({ mode: "closed" });
  const style = d.createElement("style");
  style.textContent = `
    .bar,.pop{position:fixed;display:none;font:13px system-ui,sans-serif;background:#1f2430;color:#fff;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.35);padding:6px;gap:4px;align-items:center}
    .bar{flex-direction:row}
    .pop{flex-direction:column;max-width:280px;align-items:stretch}
    .sw{width:20px;height:20px;border-radius:50%;border:2px solid rgba(255,255,255,.25);cursor:pointer;padding:0}
    .btn{background:#39404f;color:#fff;border:0;border-radius:6px;padding:5px 9px;cursor:pointer;font:inherit}
    .btn:hover{background:#4a5264}
    .row{display:flex;gap:4px;align-items:center}
    textarea{width:100%;min-height:54px;resize:vertical;border-radius:6px;border:0;padding:6px;font:inherit;box-sizing:border-box}
    .note{white-space:pre-wrap;padding:2px 2px 6px}
  `;
  shadow.appendChild(style);
  const appendUi = (): void => {
    if (!host.isConnected && d.documentElement) d.documentElement.appendChild(host);
  };

  // Selection toolbar
  const bar = d.createElement("div");
  bar.className = "bar";
  const swatchRow = d.createElement("div");
  swatchRow.className = "row";
  bar.appendChild(swatchRow);
  const noteBtn = d.createElement("button");
  noteBtn.className = "btn";
  noteBtn.textContent = "Note";
  bar.appendChild(noteBtn);
  const noteBox = d.createElement("div");
  noteBox.style.display = "none";
  const noteArea = d.createElement("textarea");
  noteArea.placeholder = "Add a note…";
  const noteSave = d.createElement("button");
  noteSave.className = "btn";
  noteSave.textContent = "Save highlight";
  noteSave.style.marginTop = "4px";
  noteBox.appendChild(noteArea);
  noteBox.appendChild(noteSave);
  bar.appendChild(noteBox);
  shadow.appendChild(bar);

  // Existing-highlight popover
  const pop = d.createElement("div");
  pop.className = "pop";
  shadow.appendChild(pop);

  let pendingAnchor: { start: number; end: number } | null = null;

  const hideBar = (): void => {
    bar.style.display = "none";
    noteBox.style.display = "none";
    noteArea.value = "";
    pendingAnchor = null;
  };
  const hidePop = (): void => {
    pop.style.display = "none";
  };

  const sendCreate = (color: string, note: string): void => {
    if (!pendingAnchor) return;
    const text = buildText();
    const anchor = buildAnchor(text, pendingAnchor.start, pendingAnchor.end);
    if (anchor.quote.length === 0 || anchor.quote.length > MAX_QUOTE_CHARS) {
      hideBar();
      return;
    }
    ipcRenderer.send(ANNOTATION_CREATE_CHANNEL, { url: loc.href, pageTitle: d.title || loc.href, color, note, anchor });
    hideBar();
    const sel = w.getSelection && w.getSelection();
    if (sel && sel.removeAllRanges) sel.removeAllRanges();
  };

  for (const color of ANNOTATION_COLORS) {
    const sw = d.createElement("button");
    sw.className = "sw";
    sw.style.background = ANNOTATION_COLOR_HEX[color];
    sw.title = color;
    sw.addEventListener("mousedown", (e: any) => {
      e.preventDefault();
      e.stopPropagation();
      sendCreate(color, "");
    });
    swatchRow.appendChild(sw);
  }
  noteBtn.addEventListener("mousedown", (e: any) => {
    e.preventDefault();
    e.stopPropagation();
    noteBox.style.display = noteBox.style.display === "none" ? "block" : "none";
    if (noteBox.style.display === "block") noteArea.focus();
  });
  noteSave.addEventListener("mousedown", (e: any) => {
    e.preventDefault();
    e.stopPropagation();
    sendCreate(ANNOTATION_COLORS[0], noteArea.value);
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const placeAt = (el: any, rect: { left: number; top: number; bottom: number }): void => {
    appendUi();
    el.style.display = el === bar ? "flex" : "flex";
    const vw = w.innerWidth || 1024;
    const top = rect.top > 56 ? rect.top - (el.offsetHeight || 40) - 8 : rect.bottom + 8;
    const left = Math.max(8, Math.min(rect.left, vw - (el.offsetWidth || 200) - 8));
    el.style.left = `${left}px`;
    el.style.top = `${Math.max(8, top)}px`;
  };

  const onSelect = (): void => {
    const sel = w.getSelection && w.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      if (noteBox.style.display === "none") hideBar();
      return;
    }
    const range = sel.getRangeAt(0);
    if (host.contains && host.contains(range.commonAncestorContainer)) return;
    if (!d.body || !d.body.contains(range.commonAncestorContainer)) return;
    buildText();
    const start = indexOfPoint(range.startContainer, range.startOffset);
    const end = indexOfPoint(range.endContainer, range.endOffset);
    if (start === null || end === null || end <= start || end - start > MAX_QUOTE_CHARS) {
      hideBar();
      return;
    }
    pendingAnchor = { start, end };
    const rect = range.getBoundingClientRect();
    hidePop();
    placeAt(bar, rect);
  };

  // ---- rendering saved annotations ----
  const ensureStyle = (): void => {
    if (shadow.getElementById && shadow.getElementById("hl")) return;
    const s = d.createElement("style");
    s.id = "hl";
    s.textContent = ANNOTATION_COLORS.map((c) => `::highlight(corvus-anno-${c}){background-color:${ANNOTATION_COLOR_HEX[c]};color:inherit}`).join("");
    (d.head || d.documentElement).appendChild(s);
  };

  const render = (msg: AnnotationApplyMessage): void => {
    if (!supported) return;
    const text = buildText();
    applied = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const byColor: Record<string, any[]> = {};
    for (const a of msg.annotations) {
      const found = locateAnchor(text, a.anchor);
      if (!found) continue;
      const range = rangeFromIndices(found.start, found.end);
      if (!range) continue;
      applied.push({ id: a.id, color: a.color, note: a.note, range });
      (byColor[a.color] = byColor[a.color] || []).push(range);
    }
    for (const c of ANNOTATION_COLORS) {
      const ranges = byColor[c];
      if (ranges && ranges.length) {
        const hl = new w.Highlight(...ranges);
        w.CSS.highlights.set(`corvus-anno-${c}`, hl);
      } else {
        w.CSS.highlights.delete(`corvus-anno-${c}`);
      }
    }
    if (applied.length) ensureStyle();
    // Shared-DOM marker (visible across worlds) so the main process / smoke can observe re-anchoring.
    if (d.documentElement) d.documentElement.setAttribute("data-corvus-annotated", String(applied.length));
    if (msg.scrollToId) {
      const target = applied.find((a) => a.id === msg.scrollToId);
      if (target) {
        const rect = target.range.getBoundingClientRect();
        w.scrollTo({ top: rect.top + (w.pageYOffset || 0) - 120, behavior: "smooth" });
      }
    }
  };

  // ---- popover for an existing highlight ----
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const openPopover = (a: Applied, x: number, y: number): void => {
    pop.textContent = "";
    const note = d.createElement("div");
    note.className = "note";
    note.textContent = a.note || "No note";
    pop.appendChild(note);
    const swRow = d.createElement("div");
    swRow.className = "row";
    for (const color of ANNOTATION_COLORS) {
      const sw = d.createElement("button");
      sw.className = "sw";
      sw.style.background = ANNOTATION_COLOR_HEX[color];
      sw.addEventListener("mousedown", (e: any) => {
        e.preventDefault();
        ipcRenderer.send(ANNOTATION_UPDATE_CHANNEL, { id: a.id, color });
        hidePop();
      });
      swRow.appendChild(sw);
    }
    pop.appendChild(swRow);
    const actions = d.createElement("div");
    actions.className = "row";
    actions.style.marginTop = "4px";
    const edit = d.createElement("button");
    edit.className = "btn";
    edit.textContent = "Edit note";
    edit.addEventListener("mousedown", (e: any) => {
      e.preventDefault();
      const area = d.createElement("textarea");
      area.value = a.note;
      const save = d.createElement("button");
      save.className = "btn";
      save.textContent = "Save";
      save.style.marginTop = "4px";
      save.addEventListener("mousedown", (ev: any) => {
        ev.preventDefault();
        ipcRenderer.send(ANNOTATION_UPDATE_CHANNEL, { id: a.id, note: area.value });
        hidePop();
      });
      pop.textContent = "";
      pop.appendChild(area);
      pop.appendChild(save);
      area.focus();
    });
    const del = d.createElement("button");
    del.className = "btn";
    del.textContent = "Delete";
    del.addEventListener("mousedown", (e: any) => {
      e.preventDefault();
      ipcRenderer.send(ANNOTATION_DELETE_CHANNEL, { id: a.id });
      hidePop();
    });
    actions.appendChild(edit);
    actions.appendChild(del);
    pop.appendChild(actions);
    placeAt(pop, { left: x, top: y, bottom: y });
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hitTest = (x: number, y: number): Applied | null => {
    const caret = d.caretRangeFromPoint ? d.caretRangeFromPoint(x, y) : null;
    if (!caret) return null;
    for (const a of applied) {
      try {
        if (a.range.isPointInRange(caret.startContainer, caret.startOffset)) return a;
      } catch {
        // range may have been invalidated by DOM changes
      }
    }
    return null;
  };

  d.addEventListener(
    "mouseup",
    (e: any) => {
      if (host.contains && host.contains(e.target)) return;
      const hit = hitTest(e.clientX, e.clientY);
      if (hit) {
        hideBar();
        openPopover(hit, e.clientX, e.clientY);
        return;
      }
      hidePop();
      setTimeout(onSelect, 0);
    },
    true,
  );
  d.addEventListener(
    "mousedown",
    (e: any) => {
      if (host.contains && host.contains(e.target)) return;
      hidePop();
      if (noteBox.style.display === "none") hideBar();
    },
    true,
  );

  ipcRenderer.on(ANNOTATION_APPLY_CHANNEL, (_e: IpcRendererEvent, msg: AnnotationApplyMessage) => {
    try {
      appendUi();
      render(msg);
    } catch {
      // never let annotations break the page
    }
  });
}
