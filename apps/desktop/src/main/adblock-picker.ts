/**
 * "Hide this element": a picker that runs in an isolated world of the page. It outlines the element
 * under the pointer, a click chooses it (the page never sees that click), Up widens to the parent,
 * Enter or "Hide" confirms and Escape cancels. The script resolves with the chosen element's CSS
 * selector (unique on the page, avoiding generated ids and classes) or null.
 */
export interface PickerStart {
  /** Start with the element at this point (CSS px of the page), as from a right-click. */
  x?: number;
  y?: number;
}

export function elementPickerScript(start: PickerStart): string {
  return `new Promise((resolve) => {
  const doc = document;
  if (window.__corvusPicker) { window.__corvusPicker(null); }
  const stable = (s) => /^[A-Za-z_][\\w-]{0,48}$/.test(s) && !/\\d{4,}|[a-f0-9]{8,}/i.test(s);
  const selectorFor = (el) => {
    const parts = [];
    for (let node = el; node && node.nodeType === 1 && node !== doc.documentElement && node !== doc.body; node = node.parentElement) {
      if (node.id && stable(node.id)) { parts.unshift("#" + CSS.escape(node.id)); break; }
      let part = node.localName;
      const classes = [...node.classList].filter(stable).slice(0, 3);
      if (classes.length) part += classes.map((c) => "." + CSS.escape(c)).join("");
      const parent = node.parentElement;
      if (parent && [...parent.children].filter((s) => s !== node && s.matches(part)).length > 0) {
        const same = [...parent.children].filter((s) => s.localName === node.localName);
        part += ":nth-of-type(" + (same.indexOf(node) + 1) + ")";
      }
      parts.unshift(part);
      try { if (doc.querySelectorAll(parts.join(" > ")).length === 1) break; } catch (e) { break; }
    }
    return parts.join(" > ");
  };

  const host = doc.createElement("corvus-element-picker");
  host.style.cssText = "all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;";
  const root = host.attachShadow({ mode: "closed" });
  // Built node by node (no innerHTML): pages that enforce Trusted Types would refuse markup strings.
  const make = (tag, cls, label) => { const el = doc.createElement(tag); if (cls) el.className = cls; if (label) el.textContent = label; return el; };
  const style = make("style", "", \`
    .box { position: fixed; border: 2px solid #8b5cf6; background: rgba(139, 92, 246, 0.18); border-radius: 3px; pointer-events: none; transition: all 60ms ease-out; }
    .bar { position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%); display: flex; gap: 8px; align-items: center; max-width: min(720px, 92vw);
      padding: 8px 10px 8px 14px; border-radius: 12px; background: #1f1d2b; color: #f4f2ff; font: 13px/1.4 system-ui, sans-serif; box-shadow: 0 8px 28px rgba(0,0,0,.35); pointer-events: auto; }
    .text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    code { font: 12px ui-monospace, monospace; color: #c4b5fd; }
    button { border: 0; border-radius: 8px; padding: 5px 10px; font: inherit; cursor: pointer; background: #383450; color: inherit; }
    button.primary { background: #8b5cf6; color: #fff; }
    [hidden] { display: none !important; }
  \`);
  const box = make("div", "box");
  box.hidden = true;
  const bar = make("div", "bar");
  const text = make("span", "text", "Click an element to hide it · Esc to cancel");
  const wider = make("button", "wider", "Wider");
  wider.title = "Select the element around it (Up)";
  wider.hidden = true;
  const hideBtn = make("button", "hide primary", "Hide");
  hideBtn.hidden = true;
  const cancelBtn = make("button", "cancel", "Cancel");
  bar.append(text, wider, hideBtn, cancelBtn);
  root.append(style, box, bar);
  doc.documentElement.appendChild(host);
  let hovered = null;
  let chosen = null;

  const outline = (el) => {
    if (!el) { box.hidden = true; return; }
    const r = el.getBoundingClientRect();
    Object.assign(box.style, { left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px" });
    box.hidden = false;
  };
  const choose = (el) => {
    if (!el || el === doc.documentElement || el === doc.body) return;
    chosen = el;
    outline(el);
    text.replaceChildren("Hide ", make("code", "", selectorFor(el)), "?");
    wider.hidden = !el.parentElement || el.parentElement === doc.body;
    hideBtn.hidden = false;
  };
  const target = (e) => {
    const el = doc.elementFromPoint(e.clientX, e.clientY);
    return el && el !== host ? el : null;
  };
  const finish = (value) => {
    for (const [type, fn] of listeners) window.removeEventListener(type, fn, true);
    host.remove();
    window.__corvusPicker = undefined;
    resolve(value);
  };
  const inBar = (e) => e.composedPath().includes(bar);
  const swallow = (e) => { if (!inBar(e)) { e.preventDefault(); e.stopImmediatePropagation(); } };
  const listeners = [
    ["mousemove", (e) => { if (!chosen && !inBar(e)) { hovered = target(e); outline(hovered); } }],
    ["click", (e) => { if (inBar(e)) return; swallow(e); choose(target(e)); }],
    ["mousedown", swallow], ["mouseup", swallow], ["pointerdown", swallow], ["pointerup", swallow], ["auxclick", swallow], ["contextmenu", swallow],
    ["keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); finish(null); }
      else if (e.key === "Enter" && chosen) { e.preventDefault(); e.stopImmediatePropagation(); finish({ selector: selectorFor(chosen) }); }
      else if (e.key === "ArrowUp" && chosen && chosen.parentElement && chosen.parentElement !== doc.body) { e.preventDefault(); e.stopImmediatePropagation(); choose(chosen.parentElement); }
    }],
    ["scroll", () => outline(chosen || hovered)],
  ];
  for (const [type, fn] of listeners) window.addEventListener(type, fn, true);
  wider.addEventListener("click", () => chosen && chosen.parentElement && choose(chosen.parentElement));
  hideBtn.addEventListener("click", () => chosen && finish({ selector: selectorFor(chosen) }));
  cancelBtn.addEventListener("click", () => finish(null));
  window.__corvusPicker = finish;
  ${typeof start.x === "number" && typeof start.y === "number" ? `choose(doc.elementFromPoint(${Math.round(start.x)}, ${Math.round(start.y)}));` : ""}
})`;
}

/**
 * The user filter a picked selector becomes: this site's element hiding rule, or null when the
 * selector could break out of a CSS rule or is not a selector at all.
 */
export function pickedFilter(host: string, selector: unknown): string | null {
  if (typeof selector !== "string") return null;
  const s = selector.trim();
  if (!s || s.length > 500 || /[{}\n\r]|##|#@#|\/\*/.test(s)) return null;
  const site = host.toLowerCase().replace(/^www\./, "");
  if (!/^[a-z0-9.-]+$/.test(site)) return null;
  return `${site}##${s}`;
}
