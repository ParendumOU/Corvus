/**
 * Scripts injected into tabs for AI agents. They run in an isolated world (shared DOM, separate
 * JS globals) so pages cannot tamper with the script's own state. Kept as plain strings so the
 * bundler cannot rewrite them.
 */

/** Isolated world id used for all agent scripts. */
export const AGENT_WORLD_ID = 1717;

export const MAX_SNAPSHOT_ELEMENTS = 250;

export interface RawSnapshot {
  url: string;
  title: string;
  text: string;
  truncated: boolean;
  elements: Array<{ ref: string; role: string; name: string; value?: string }>;
}

/**
 * clean / roleOf / nameOf exactly as page_snapshot computes them, shared with describeTargetScript so
 * a live read of one element gives the same role and name the agent saw in the snapshot.
 */
const ROLE_NAME_FNS = `
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

export function snapshotScript(maxChars: number): string {
  return `(() => {
  const MAX_CHARS = ${Math.max(200, Math.floor(maxChars))};
  const MAX_ELEMENTS = ${MAX_SNAPSHOT_ELEMENTS};
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
  let raw = main
    ? main.innerText
    : Array.from(doc.body ? doc.body.children : [])
        .filter((c) => !c.matches(chromeLike))
        .map((c) => c.innerText || "")
        .join("\\n");
  if (!(raw || "").trim() && doc.body) raw = doc.body.innerText;
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
  for (const el of doc.querySelectorAll(selector)) {
    if (elements.length >= MAX_ELEMENTS) break;
    if (el.disabled || !visible(el) || el.closest("[aria-hidden=true]")) continue;
    let ref = el.getAttribute("data-corvus-ref");
    if (!ref) {
      window.__corvusRefSeq += 1;
      ref = "e" + window.__corvusRefSeq;
      el.setAttribute("data-corvus-ref", ref);
    }
    const item = { ref, role: roleOf(el), name: nameOf(el).slice(0, 80) };
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
  return { url: location.href, title: doc.title, text, truncated, elements };
})()`;
}

const findRef = (ref: string): string =>
  `document.querySelector('[data-corvus-ref="' + ${JSON.stringify(ref)}.replace(/["\\\\]/g, "") + '"]')`;

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
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: innerWidth, h: innerHeight };
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
