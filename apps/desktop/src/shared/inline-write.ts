/**
 * "Write with Corvus AI" in a page's text fields: the field (and its selection) is captured when
 * the person picks an action, the AI's text streams into the Assist panel, and it goes into the
 * field only when they click Insert. The scripts run in Assist's isolated world, where the
 * captured field waits by token; password, one-time-code and card fields are never read.
 */

export type WriteAction = "fix" | "shorter" | "longer" | "formal" | "friendly" | "translate" | "custom";

/** Menu order and labels; "translate" gets the target language appended. */
export const WRITE_ACTIONS: ReadonlyArray<{ action: WriteAction; label: string }> = [
  { action: "fix", label: "Fix spelling and grammar" },
  { action: "shorter", label: "Make it shorter" },
  { action: "longer", label: "Make it longer" },
  { action: "formal", label: "Make it more formal" },
  { action: "friendly", label: "Make it friendlier" },
  { action: "translate", label: "Translate" },
];

/** What the capture script reports about the field the person right-clicked. */
export interface CapturedField {
  /** Looks the field up again at insert time. */
  token: string;
  /** The selected text, or the whole field when nothing is selected. */
  text: string;
  /** Only the selection is replaced on insert. */
  selected: boolean;
}

/**
 * Captures the focused editable field (inputs that hold plain text, textareas, contenteditable),
 * remembering it and its selection under `token`. Resolves to a CapturedField, or null when the
 * focus is not in such a field or the field holds a secret.
 */
export function captureFieldScript(token: string): string {
  return `(() => {
  let el = document.activeElement;
  while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
  if (!el) return null;
  const tag = el.tagName;
  const type = (el.getAttribute("type") || "text").toLowerCase();
  const auto = (el.getAttribute("autocomplete") || "").toLowerCase();
  const plainInput = tag === "INPUT" && ["text", "search", "email", "url", ""].includes(type);
  if (!(plainInput || tag === "TEXTAREA" || el.isContentEditable)) return null;
  if (type === "password" || /one-time-code|cc-|current-password|new-password/.test(auto)) return null;
  const store = (window.__corvusWriteTargets = window.__corvusWriteTargets || new Map());
  if (el.isContentEditable) {
    const sel = getSelection();
    const range = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
    const inside = range && !range.collapsed && el.contains(range.commonAncestorContainer);
    store.set(${JSON.stringify(token)}, { el, range: inside ? range.cloneRange() : null });
    return { token: ${JSON.stringify(token)}, text: inside ? sel.toString() : el.innerText, selected: Boolean(inside) };
  }
  const start = el.selectionStart, end = el.selectionEnd;
  const selected = typeof start === "number" && typeof end === "number" && end > start;
  store.set(${JSON.stringify(token)}, { el, start: selected ? start : null, end: selected ? end : null });
  return { token: ${JSON.stringify(token)}, text: selected ? el.value.slice(start, end) : el.value, selected };
})()`;
}

/**
 * Puts `text` into the field captured under `token`, replacing its selection or its whole content
 * as an edit the page sees (input events, undo with Ctrl+Z). Resolves to false when the field is gone.
 */
export function insertFieldScript(token: string, text: string): string {
  return `(() => {
  const store = window.__corvusWriteTargets;
  const t = store && store.get(${JSON.stringify(token)});
  if (!t || !t.el.isConnected) return false;
  const el = t.el;
  const text = ${JSON.stringify(text)};
  el.focus();
  if (el.isContentEditable) {
    const sel = getSelection();
    sel.removeAllRanges();
    let range = t.range;
    if (!range) {
      range = document.createRange();
      range.selectNodeContents(el);
    }
    sel.addRange(range);
  } else if (t.start !== null) {
    el.setSelectionRange(t.start, t.end);
  } else {
    el.select();
  }
  if (!document.execCommand("insertText", false, text)) {
    if (el.isContentEditable) return false;
    const start = t.start !== null ? t.start : 0;
    const end = t.start !== null ? t.end : el.value.length;
    el.setRangeText(text, start, end, "end");
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
  }
  store.delete(${JSON.stringify(token)});
  return true;
})()`;
}

/**
 * The model's text as it goes into the field: without a code fence or quotes wrapped around the
 * whole reply (models add them now and then although told not to), unless the field's own text
 * was quoted like that.
 */
export function cleanWriteOutput(reply: string, original: string): string {
  let text = reply.trim();
  const fence = /^```[a-z]*\n([\s\S]*?)\n```$/i.exec(text);
  if (fence) text = fence[1]!.trim();
  const quoted = /^(["“'«])([\s\S]*)(["”'»])$/.exec(text);
  const pairs: Record<string, string> = { '"': '"', "“": "”", "'": "'", "«": "»" };
  if (quoted && pairs[quoted[1]!] === quoted[3] && !/^["“'«]/.test(original.trim())) text = quoted[2]!.trim();
  return text;
}

/** The menu label of an action ("Translate into Spanish" with the target language's name). */
export function writeActionLabel(action: WriteAction, languageName: string): string {
  if (action === "custom") return "Write…";
  const label = WRITE_ACTIONS.find((a) => a.action === action)?.label ?? action;
  return action === "translate" ? `${label} into ${languageName}` : label;
}
