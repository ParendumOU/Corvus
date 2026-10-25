/**
 * Element actions for MCP clients (focus, check, select_option, fill_form / fill_fields), run in the
 * agent's isolated world. Values go in through the native setters and fire input/change events, as
 * typing would, so frameworks see them.
 */
import type { FieldValue } from "@corvus/shared";
import { findRef } from "./page-scripts";

/** Shared: the element by ref (scrolled into view), and how to tell what kind of control it is. */
const ELEMENT_FNS = (ref: string): string => `
  const el = ${findRef(ref)};
  if (!el) return { error: "Element ${ref} not found; take a new page_snapshot" };
  el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  const tag = el.tagName;
  const type = (el.getAttribute("type") || "").toLowerCase();
  const role = (el.getAttribute("role") || "").toLowerCase();
  const fire = (target, name) => target.dispatchEvent(new Event(name, { bubbles: true }));
  const isToggle = (tag === "INPUT" && (type === "checkbox" || type === "radio")) || ["checkbox", "radio", "switch", "menuitemcheckbox", "menuitemradio"].includes(role);
  const isChecked = () => (tag === "INPUT" ? el.checked : el.getAttribute("aria-checked") === "true");
  const check = (want) => {
    if (!isToggle) return { error: "Element ${ref} is not a checkbox, radio or switch" };
    if (isChecked() === want) return { ok: true };
    if (!want && (type === "radio" || role === "radio" || role === "menuitemradio")) return { error: "A radio button cannot be unchecked; check another option instead" };
    el.click();
    return isChecked() === want ? { ok: true } : { error: "The page did not change the state of ${ref}" };
  };
  const select = (values) => {
    const wanted = values.map((v) => String(v).trim().toLowerCase());
    const matches = (o) => wanted.includes(String(o.value).trim().toLowerCase()) || wanted.includes((o.label || o.textContent || "").replace(/\\s+/g, " ").trim().toLowerCase());
    if (tag === "SELECT") {
      const options = Array.from(el.options);
      const hits = options.filter(matches);
      if (!hits.length) return { error: "No option matches " + JSON.stringify(values) + "; options: " + JSON.stringify(options.slice(0, 20).map((o) => (o.label || o.textContent || "").trim())) };
      if (el.multiple) options.forEach((o) => { o.selected = hits.includes(o); });
      else el.value = hits[0].value;
      fire(el, "input");
      fire(el, "change");
      return { ok: true };
    }
    if (role === "listbox" || role === "combobox") {
      const options = Array.from(el.querySelectorAll("[role=option]"));
      const hits = options.filter((o) => wanted.includes((o.getAttribute("aria-label") || o.textContent || "").replace(/\\s+/g, " ").trim().toLowerCase()) || wanted.includes(String(o.getAttribute("data-value") || "").toLowerCase()));
      if (!hits.length) return { error: "No option matches " + JSON.stringify(values) };
      hits.forEach((o) => o.click());
      return { ok: true };
    }
    return { error: "Element ${ref} is not a select or listbox" };
  };
  const setText = (text) => {
    if (tag === "INPUT" || tag === "TEXTAREA") {
      if (el.readOnly || el.disabled) return { error: "Element ${ref} is read-only" };
      const proto = tag === "INPUT" ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      el.focus();
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, text);
      fire(el, "input");
      fire(el, "change");
      return { ok: true };
    }
    if (el.isContentEditable) {
      el.focus();
      el.textContent = text;
      el.dispatchEvent(new InputEvent("input", { bubbles: true }));
      return { ok: true };
    }
    return { error: "Element ${ref} is not a text field" };
  };`;

export function focusScript(ref: string): string {
  return `(() => {
  ${ELEMENT_FNS(ref)}
  if (typeof el.focus !== "function") return { error: "Element ${ref} cannot take focus" };
  el.focus();
  return { ok: true };
})()`;
}

export function checkScript(ref: string, checked: boolean): string {
  return `(() => {
  ${ELEMENT_FNS(ref)}
  return check(${checked ? "true" : "false"});
})()`;
}

export function selectScript(ref: string, values: readonly string[]): string {
  return `(() => {
  ${ELEMENT_FNS(ref)}
  return select(${JSON.stringify(values)});
})()`;
}

/**
 * fill_form / fill_fields: text for text fields, a boolean for checkboxes, radios and switches, a
 * string or string[] for selects (by value or label).
 */
export function fillScript(ref: string, value: FieldValue): string {
  return `(() => {
  ${ELEMENT_FNS(ref)}
  const value = ${JSON.stringify(value)};
  if (typeof value === "boolean") return check(value);
  if (Array.isArray(value)) return select(value);
  if (tag === "SELECT" || role === "listbox") return select([value]);
  if (isToggle) return check(value === "true" || value === "on" || value === "1");
  return setText(value);
})()`;
}
