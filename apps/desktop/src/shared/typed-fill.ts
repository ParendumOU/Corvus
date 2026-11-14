/**
 * Writing a value into a form field the way typing does. Pages hear events a script made (isTrusted
 * false) as a bot's: Twitch's sign-in (Kasada) refuses such a login with "Your browser is not
 * currently supported". Autofill types through the browser's own editing instead (execCommand
 * insertText into the field that has the keyboard, its content selected): the page gets a trusted
 * input event at once and a trusted change when the field loses the keyboard, as with Chrome's own
 * autofill. Self-contained: the autofill scripts embed it as source (shared/credential-scripts.ts),
 * and the tab preload calls it for cards and addresses, in every frame.
 */

/** A text field as the fill reads it (the preload is type-checked without the DOM types). */
export interface TypedField {
  value: string;
  type?: string;
  select?: () => void;
  getRootNode(): { activeElement?: unknown };
  ownerDocument: { execCommand(command: string, showUi: boolean, value: string): boolean };
}

/**
 * Types `value` over what `el` holds, `el` having the keyboard. False when it could not (nothing to
 * type, the field without the keyboard, editing refused) or the field ended up with something else,
 * and the caller writes the value itself. Outside password fields a page may format what was typed
 * (spaces in a card number, a slash in a date), which still counts as typed.
 */
export function typeIntoField(el: TypedField, value: string): boolean {
  if (!value || el.getRootNode().activeElement !== el || typeof el.select !== "function") return false;
  el.select();
  if (!el.ownerDocument.execCommand("insertText", false, value)) return false;
  const written = String(el.value ?? "");
  if (written === value) return true;
  const plain = (s: string): string => s.replace(/[\s\-/]/g, "");
  return el.type !== "password" && plain(written) === plain(value);
}
