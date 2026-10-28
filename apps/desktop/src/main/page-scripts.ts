/**
 * Scripts injected into tabs for AI agents. They run in an isolated world (shared DOM, separate
 * JS globals) so pages cannot tamper with the script's own state. Kept as plain strings so the
 * bundler cannot rewrite them.
 */

/** Isolated world id used for all agent scripts. */
export const AGENT_WORLD_ID = 1717;

export const MAX_SNAPSHOT_ELEMENTS = 250;
/** The most elements page_snapshot may ask for (maxElements). */
export const MAX_SNAPSHOT_ELEMENTS_CAP = 1000;

export interface RawSnapshot {
  url: string;
  title: string;
  text: string;
  truncated: boolean;
  elements: Array<{ ref: string; role: string; name: string; value?: string; bbox?: [number, number, number, number] }>;
  viewport: { width: number; height: number; devicePixelRatio: number; scrollX: number; scrollY: number };
}

/** What page_snapshot asks for besides the text budget. */
export interface SnapshotScriptOptions {
  /** Bounding boxes ([x, y, width, height], viewport CSS px) for coordinate tools. */
  boxes?: boolean;
  /** Only elements that intersect the viewport. */
  viewportOnly?: boolean;
  maxElements?: number;
  /** Include the main text (default true). */
  text?: boolean;
}

/**
 * clean / roleOf / nameOf exactly as page_snapshot computes them, shared with describeTargetScript so
 * a live read of one element gives the same role and name the agent saw in the snapshot.
 */
export const ROLE_NAME_FNS = `
  const clean = (s) => (s || "").replace(/\\s+/g, " ").trim();
  const roleOf = (el) => {
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
  const nameOf = (el) => {
    const aria = el.getAttribute("aria-label");
    if (aria) return clean(aria);
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const label = labelledBy.split(/\\s+/).map((id) => document.getElementById(id)).filter(Boolean).map((n) => n.innerText).join(" ");
      if (clean(label)) return clean(label);
    }
    if (el.labels && el.labels.length > 0) return clean(el.labels[0].innerText);
    const own = clean(el.innerText || el.value || "");
    if (own && el.tagName !== "INPUT" && el.tagName !== "TEXTAREA" && el.tagName !== "SELECT") return own;
    const img = el.querySelector && el.querySelector("img[alt]");
    return clean(el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("alt") || (img && img.getAttribute("alt")) || el.getAttribute("name") || own);
  };`;

export function snapshotScript(maxChars: number, opts: SnapshotScriptOptions = {}): string {
  const maxElements = Math.max(1, Math.min(MAX_SNAPSHOT_ELEMENTS_CAP, Math.floor(opts.maxElements ?? MAX_SNAPSHOT_ELEMENTS)));
  return `(() => {
  const MAX_CHARS = ${Math.max(200, Math.floor(maxChars))};
  const MAX_ELEMENTS = ${maxElements};
  const BOXES = ${opts.boxes === true};
  const VIEWPORT_ONLY = ${opts.viewportOnly === true};
  const WITH_TEXT = ${opts.text !== false};
  const doc = document;
  window.__corvusRefSeq = window.__corvusRefSeq || 0;

  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return false;
    const style = getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) > 0;
  };
${ROLE_NAME_FNS}

  const main = doc.querySelector("main, [role=main], article");
  const chromeLike = "nav, header, footer, aside, script, style, noscript, template, [aria-hidden=true]";
  // innerText of an element that is not rendered (display: none, e.g. a banner hidden by a cosmetic
  // filter) is its textContent, hidden text included: skip those.
  let raw = !WITH_TEXT ? "" : main
    ? main.innerText
    : Array.from(doc.body ? doc.body.children : [])
        .filter((c) => !c.matches(chromeLike) && getComputedStyle(c).display !== "none")
        .map((c) => c.innerText || "")
        .join("\\n");
  if (WITH_TEXT && !(raw || "").trim() && doc.body) raw = doc.body.innerText;
  let text = (raw || "")
    .replace(/[ \\t\\f\\v\\u00a0]+/g, " ")
    .replace(/\\n\\s*\\n\\s*/g, "\\n\\n")
    .trim();
  const truncated = text.length > MAX_CHARS;
  if (truncated) text = text.slice(0, MAX_CHARS);

  const selector = [
    "a[href]", "button", "input:not([type=hidden])", "textarea", "select", "summary",
    "[role=button]", "[role=link]", "[role=checkbox]", "[role=radio]", "[role=tab]", "[role=menuitem]",
    "[role=option]", "[role=switch]", "[role=combobox]", "[role=textbox]", "[role=searchbox]",
    "[contenteditable='']", "[contenteditable=true]",
  ].join(",");
  const elements = [];
  const refFor = (el) => {
    let ref = el.getAttribute("data-corvus-ref");
    if (!ref) {
      window.__corvusRefSeq += 1;
      ref = "e" + window.__corvusRefSeq;
      el.setAttribute("data-corvus-ref", ref);
    }
    return ref;
  };
  const frames = [];
  const collect = (root, ox, oy, depth) => {
  for (const el of root.querySelectorAll(selector)) {
    if (elements.length >= MAX_ELEMENTS) break;
    if (el.disabled || !visible(el) || el.closest("[aria-hidden=true]")) continue;
    const r = el.getBoundingClientRect();
    const box = { left: r.left + ox, top: r.top + oy, width: r.width, height: r.height, right: r.right + ox, bottom: r.bottom + oy };
    if (VIEWPORT_ONLY && (box.bottom < 0 || box.right < 0 || box.top > innerHeight || box.left > innerWidth)) continue;
    const ref = refFor(el);
    const item = { ref, role: roleOf(el), name: nameOf(el).slice(0, 80) };
    if (BOXES) item.bbox = [Math.round(box.left), Math.round(box.top), Math.round(box.width), Math.round(box.height)];
    const tag = el.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
      const type = (el.getAttribute("type") || "").toLowerCase();
      // Never report secrets: password fields, one-time-code fields, and anything Corvus filled with a
      // saved password or 2FA code (marked by the autofill scripts).
      const secret =
        type === "password" ||
        el.hasAttribute("data-corvus-secret") ||
        (el.getAttribute("autocomplete") || "").toLowerCase().split(/\\s+/).includes("one-time-code");
      if (type === "checkbox" || type === "radio") item.value = el.checked ? "checked" : "unchecked";
      else if (!secret && el.value) item.value = String(el.value).slice(0, 80);
    }
    elements.push(item);
  }
  if (depth >= 3) return;
  for (const frame of root.querySelectorAll("iframe, frame")) {
    if (elements.length >= MAX_ELEMENTS || !visible(frame) || frame.closest("[aria-hidden=true]")) continue;
    const r = frame.getBoundingClientRect();
    const fx = ox + r.left + frame.clientLeft;
    const fy = oy + r.top + frame.clientTop;
    let inner = null;
    try { inner = frame.contentDocument; } catch (e) {}
    if (inner && inner.body) {
      collect(inner, fx, fy, depth + 1);
      continue;
    }
    // Another origin: its content cannot be read; click_at reaches inside it.
    let host = "";
    try { host = new URL(frame.getAttribute("src") || "", location.href).host; } catch (e) {}
    const item = { ref: refFor(frame), role: "frame", name: clean(frame.getAttribute("title") || frame.getAttribute("name") || host || "embedded frame").slice(0, 80), states: ["cross-origin"] };
    if (BOXES) item.bbox = [Math.round(ox + r.left), Math.round(oy + r.top), Math.round(r.width), Math.round(r.height)];
    elements.push(item);
  }
  };
  collect(doc, 0, 0, 0);
  const viewport = { width: innerWidth, height: innerHeight, devicePixelRatio: devicePixelRatio || 1, scrollX: scrollX, scrollY: scrollY };
  return { url: location.href, title: doc.title, text, truncated, elements, viewport };
})()`;
}

/**
 * The element with a ref, in the page or in a same-origin frame (page_snapshot gives refs to both).
 * Cross-origin frames cannot be read: coordinate tools reach inside them.
 */
export const findRef = (ref: string): string =>
  `((q) => {
    const look = (doc, depth) => {
      const hit = doc.querySelector(q);
      if (hit || depth >= 3) return hit;
      for (const frame of doc.querySelectorAll("iframe, frame")) {
        let inner = null;
        try { inner = frame.contentDocument; } catch (e) {}
        const found = inner ? look(inner, depth + 1) : null;
        if (found) return found;
      }
      return null;
    };
    return look(document, 0);
  })('[data-corvus-ref="' + ${JSON.stringify(ref)}.replace(/["\\\\]/g, "") + '"]')`;

/** Where an element's frame sits in the top-level viewport (0, 0 for the page itself). */
const FRAME_OFFSET_FN = `
  const frameOffset = (el) => {
    let x = 0, y = 0;
    for (let w = el.ownerDocument.defaultView; w && w.frameElement; w = w.parent) {
      const r = w.frameElement.getBoundingClientRect();
      x += r.left + w.frameElement.clientLeft;
      y += r.top + w.frameElement.clientTop;
    }
    return { x, y };
  };`;

/**
 * Role, accessible name and page URL of one element (as page_snapshot computes them), plus its form's
 * action URL and default submit button (what pressing Enter in the form clicks). Read-only; null
 * when the ref is gone. Used by the spend gate.
 */
export function describeTargetScript(ref: string): string {
  return `(() => {
  ${ROLE_NAME_FNS}
  const el = ${findRef(ref)};
  if (!el) return null;
  const out = { url: location.href, role: roleOf(el), name: nameOf(el).slice(0, 120) };
  const form = el.form || (el.closest && el.closest("form"));
  if (form) {
    let action = "";
    try {
      action = new URL(form.getAttribute("action") || location.href, location.href).href;
    } catch (e) {}
    const isSubmit = (e) =>
      (e.tagName === "BUTTON" && (e.getAttribute("type") || "submit").toLowerCase() === "submit") ||
      (e.tagName === "INPUT" && ["submit", "image"].includes((e.getAttribute("type") || "").toLowerCase()));
    const submit = Array.from(form.elements || []).find(isSubmit);
    out.form = { action };
    if (submit) {
      out.form.submitName = nameOf(submit).slice(0, 120);
      out.form.submitRole = roleOf(submit);
    }
  }
  return out;
})()`;
}

/** Scroll the element into view and return its centre in viewport CSS pixels, or null. */
export function locateScript(ref: string): string {
  return `(() => {
  const el = ${findRef(ref)};
  if (!el) return null;
  el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  ${FRAME_OFFSET_FN}
  const r = el.getBoundingClientRect();
  const o = frameOffset(el);
  return { x: o.x + r.left + r.width / 2, y: o.y + r.top + r.height / 2, w: innerWidth, h: innerHeight };
})()`;
}

export function clickScript(ref: string): string {
  return `(() => {
  const el = ${findRef(ref)};
  if (!el) return false;
  el.scrollIntoView({ block: "center", behavior: "instant" });
  if (typeof el.focus === "function") el.focus();
  el.click();
  return true;
})()`;
}

/** Focus the field and clear it. Returns "input" for value-based fields, "editable" for contenteditable, null if missing. */
export function focusForTypingScript(ref: string): string {
  return `(() => {
  const el = ${findRef(ref)};
  if (!el) return null;
  el.scrollIntoView({ block: "center", behavior: "instant" });
  el.focus();
  if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
    if (typeof el.select === "function") el.select();
    return "input";
  }
  if (el.isContentEditable) {
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    return "editable";
  }
  return "other";
})()`;
}

/** Fallback for background tabs: set the value through the native setter and fire input events. */
export function setValueScript(ref: string, text: string, submit: boolean): string {
  return `(() => {
  const el = ${findRef(ref)};
  if (!el) return false;
  const text = ${JSON.stringify(text)};
  if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
    const proto = el.tagName === "INPUT" ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  } else if (el.isContentEditable) {
    el.textContent = text;
    el.dispatchEvent(new InputEvent("input", { bubbles: true }));
  } else {
    return false;
  }
  if (${submit ? "true" : "false"}) {
    const form = el.form || el.closest("form");
    if (form && typeof form.requestSubmit === "function") form.requestSubmit();
    else el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
  }
  return true;
})()`;
}

export function scrollScript(direction: "up" | "down", amount: number | undefined): string {
  const sign = direction === "up" ? -1 : 1;
  const px = amount !== undefined && Number.isFinite(amount) ? Math.abs(Math.round(amount)) : null;
  return `(() => {
  const dy = ${sign} * ${px === null ? "Math.round(innerHeight * 0.8)" : px};
  window.scrollBy({ top: dy, behavior: "instant" });
  return { scrollY: Math.round(scrollY), maxScrollY: Math.max(0, document.documentElement.scrollHeight - innerHeight) };
})()`;
}

/** Same clickable-element selector page_snapshot lists, to climb from a hit point to its control. */
const CLICKABLE = [
  "a[href]", "button", "input:not([type=hidden])", "textarea", "select", "summary", "label",
  "[role=button]", "[role=link]", "[role=checkbox]", "[role=radio]", "[role=tab]", "[role=menuitem]",
  "[role=option]", "[role=switch]", "[role=combobox]", "[role=textbox]", "[role=searchbox]",
  "[contenteditable='']", "[contenteditable=true]",
].join(",");

/** Shared helpers for describePointScript / describeFocusedScript (frame flags, form, secrets). */
const TARGET_FNS = `
  ${ROLE_NAME_FNS}
  const CAPTCHA_RE = /recaptcha|hcaptcha|turnstile|challenges\\.cloudflare\\.com|arkoselabs|funcaptcha|geetest|captcha/i;
  const PAY_RE = /(^|\\.)(stripe\\.com|stripe\\.network|paypal\\.com|paypalobjects\\.com|braintreegateway\\.com|braintree-api\\.com|adyen\\.com|adyenpayments\\.com|checkout\\.com|klarna\\.com|klarnaservices\\.com|squareup\\.com|squarecdn\\.com|authorize\\.net|worldpay\\.com|mollie\\.com|razorpay\\.com|pay\\.google\\.com|apple\\.com|affirm\\.com|afterpay\\.com|shopify\\.com|shopifycs\\.com)$/i;
  const hostOf = (src) => { try { return new URL(src, location.href).host; } catch (e) { return ""; } };
  const frameInfo = (el) => {
    const src = el.getAttribute("src") || "";
    const host = hostOf(src);
    const label = clean(el.getAttribute("title") || el.getAttribute("name") || el.getAttribute("aria-label") || "");
    return { url: location.href, role: "frame", name: label.slice(0, 120), tag: el.tagName.toLowerCase(), frame: host || "embedded frame",
      captcha: CAPTCHA_RE.test(src + " " + label), payFrame: PAY_RE.test(host) };
  };
  const isSecret = (el) => {
    if (!el || !el.getAttribute) return false;
    const type = (el.getAttribute("type") || "").toLowerCase();
    const ac = (el.getAttribute("autocomplete") || "").toLowerCase().split(/\\s+/);
    return type === "password" || el.hasAttribute("data-corvus-secret") || ac.includes("one-time-code") || ac.some((a) => a.startsWith("cc-"));
  };
  const formOf = (el) => {
    const form = el.form || (el.closest && el.closest("form"));
    if (!form) return undefined;
    let action = "";
    try { action = new URL(form.getAttribute("action") || location.href, location.href).href; } catch (e) {}
    const isSubmit = (e) =>
      (e.tagName === "BUTTON" && (e.getAttribute("type") || "submit").toLowerCase() === "submit") ||
      (e.tagName === "INPUT" && ["submit", "image"].includes((e.getAttribute("type") || "").toLowerCase()));
    const submit = Array.from(form.elements || []).find(isSubmit);
    const out = { action };
    if (submit) { out.submitName = nameOf(submit).slice(0, 120); out.submitRole = roleOf(submit); }
    return out;
  };
  const inCaptcha = (el) => Boolean(el.closest && el.closest(".g-recaptcha, .h-captcha, .cf-turnstile, [class*=captcha i], [id*=captcha i], [data-sitekey]"));
  const describe = (el, hit) => {
    const out = { url: location.href, role: roleOf(el), name: nameOf(el).slice(0, 120), tag: el.tagName.toLowerCase() };
    const own = hit && hit !== el ? clean(hit.innerText || hit.textContent || "").slice(0, 120) : "";
    if (own) out.text = own;
    const form = formOf(el);
    if (form) out.form = form;
    if (isSecret(el)) out.secret = true;
    if (inCaptcha(el)) out.captcha = true;
    return out;
  };`;

/**
 * What is at viewport point (x, y) in CSS px, for the click_at spend gate and the step label. Descends
 * into same-origin frames; a cross-origin frame reports only its host. Climbs from the hit element
 * to its clickable control (snapshot selector, else the outermost cursor:pointer ancestor). Also
 * returns the control's box so the overlay can point at it. Read-only; null when nothing is there.
 */
export function describePointScript(x: number, y: number): string {
  return `(() => {
  ${TARGET_FNS}
  let x = ${Number(x) || 0}, y = ${Number(y) || 0}, ox = 0, oy = 0;
  let el = document.elementFromPoint(x, y);
  while (el && (el.tagName === "IFRAME" || el.tagName === "FRAME")) {
    let inner = null;
    try { inner = el.contentDocument; } catch (e) {}
    if (!inner) return frameInfo(el);
    const r = el.getBoundingClientRect();
    ox += r.left + el.clientLeft; oy += r.top + el.clientTop;
    const next = inner.elementFromPoint(x - ox, y - oy);
    if (!next) return frameInfo(el);
    el = next;
  }
  if (!el) return null;
  let target = el.closest(${JSON.stringify(CLICKABLE)});
  if (!target) {
    target = el;
    const view = el.ownerDocument.defaultView || window;
    for (let p = el.parentElement, i = 0; p && i < 6 && p !== el.ownerDocument.body; p = p.parentElement, i++) {
      if (view.getComputedStyle(p).cursor === "pointer") target = p;
      else if (view.getComputedStyle(target).cursor === "pointer") break;
    }
  }
  const out = describe(target, el);
  const r = target.getBoundingClientRect();
  out.box = { x: r.left + ox, y: r.top + oy, width: r.width, height: r.height };
  return out;
})()`;
}

/** The focused element (descending into same-origin frames), for the press_key / type_text gate. */
export function describeFocusedScript(): string {
  return `(() => {
  ${TARGET_FNS}
  let el = document.activeElement;
  while (el && (el.tagName === "IFRAME" || el.tagName === "FRAME")) {
    let inner = null;
    try { inner = el.contentDocument; } catch (e) {}
    if (!inner) return frameInfo(el);
    el = inner.activeElement;
  }
  if (!el || el === el.ownerDocument.body || el === el.ownerDocument.documentElement) {
    return { url: location.href, role: "", name: "", tag: "body", none: true };
  }
  return describe(el, null);
})()`;
}

/** Viewport size in CSS px (what an agent screenshot is scaled to) and the page scroll position. */
export function viewportScript(): string {
  return `(() => ({ width: innerWidth, height: innerHeight, scrollY: Math.round(scrollY), maxScrollY: Math.max(0, document.documentElement.scrollHeight - innerHeight) }))()`;
}

/** Viewport, scroll and page size in CSS px, and the device pixel ratio (the screenshot tool's metadata). */
export function viewportInfoScript(): string {
  return `(() => {
  const d = document.documentElement;
  return {
    width: innerWidth, height: innerHeight, dpr: devicePixelRatio || 1, scrollX: scrollX, scrollY: scrollY,
    scrollWidth: Math.max(d.scrollWidth, innerWidth), scrollHeight: Math.max(d.scrollHeight, document.body ? document.body.scrollHeight : 0, innerHeight),
  };
})()`;
}

/** Scroll the element into view and return its box in viewport CSS px, or null. */
export function rectScript(ref: string): string {
  return `(() => {
  const el = ${findRef(ref)};
  if (!el) return null;
  el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  ${FRAME_OFFSET_FN}
  const r = el.getBoundingClientRect();
  const o = frameOffset(el);
  return { x: o.x + r.left, y: o.y + r.top, width: r.width, height: r.height };
})()`;
}

/**
 * Background-tab fallback for click_at / hover_at / scroll_at (sendInputEvent needs a painted, visible
 * view): dispatches synthetic pointer events at the element under the point. Returns false when
 * nothing is there.
 */
export function pointerFallbackScript(action: "click" | "hover" | "scroll" | "double" | "right", x: number, y: number, dx = 0, dy = 0): string {
  return `(() => {
  const x = ${Number(x) || 0}, y = ${Number(y) || 0};
  const el = document.elementFromPoint(x, y);
  if (!el) return false;
  const opts = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, view: window };
  if (${JSON.stringify(action)} === "right") {
    const r = Object.assign({}, opts, { button: 2, buttons: 2 });
    el.dispatchEvent(new PointerEvent("pointerdown", r));
    el.dispatchEvent(new MouseEvent("mousedown", r));
    el.dispatchEvent(new PointerEvent("pointerup", r));
    el.dispatchEvent(new MouseEvent("mouseup", r));
    el.dispatchEvent(new MouseEvent("contextmenu", r));
    return true;
  }
  if (${JSON.stringify(action)} === "double") {
    for (const detail of [1, 2]) {
      const c = Object.assign({}, opts, { detail });
      el.dispatchEvent(new MouseEvent("mousedown", c));
      el.dispatchEvent(new MouseEvent("mouseup", c));
      el.dispatchEvent(new MouseEvent("click", c));
    }
    el.dispatchEvent(new MouseEvent("dblclick", Object.assign({}, opts, { detail: 2 })));
    return true;
  }
  if (${JSON.stringify(action)} === "scroll") {
    let s = el;
    while (s && s !== document.body && !(s.scrollHeight > s.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(s).overflowY))) s = s.parentElement;
    (s && s !== document.body ? s : window).scrollBy({ left: ${Number(dx) || 0}, top: ${Number(dy) || 0}, behavior: "instant" });
    return true;
  }
  el.dispatchEvent(new PointerEvent("pointerover", opts));
  el.dispatchEvent(new MouseEvent("mouseover", opts));
  el.dispatchEvent(new PointerEvent("pointermove", opts));
  el.dispatchEvent(new MouseEvent("mousemove", opts));
  if (${JSON.stringify(action)} === "click") {
    el.dispatchEvent(new PointerEvent("pointerdown", opts));
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    if (typeof el.focus === "function") el.focus();
    el.dispatchEvent(new PointerEvent("pointerup", opts));
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    el.dispatchEvent(new MouseEvent("click", opts));
  }
  return true;
})()`;
}
