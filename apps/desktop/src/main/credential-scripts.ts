/**
 * Isolated-world scripts for autofill. They run in their own world (shared DOM, separate JS globals)
 * so page scripts cannot read Corvus' logic or the values it writes before the page does. Kept as
 * plain strings so the bundler cannot rewrite them. All three share one login-form finder.
 */

/** Separate from the agent (1717), reader (1721) and assist worlds. */
export const AUTOFILL_WORLD_ID = 1723;

export interface LoginDetection {
  hasPassword: boolean;
  hasUsername: boolean;
  /** Current value of the detected username field (so a save can capture it). */
  username: string;
  origin: string;
}

/**
 * Locates the page's login form: the first visible, enabled password field and the text/email field
 * most likely to be its username (same form, prefers email/autocomplete hints, else the nearest
 * preceding text input). Returns `{ user, pass }` DOM elements or null.
 */
const FIND_LOGIN = `
  const isVisible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none";
  };
  const usernameLikely = (el) => {
    const hint = ((el.name || "") + " " + (el.id || "") + " " + (el.getAttribute("autocomplete") || "") + " " + (el.getAttribute("type") || "")).toLowerCase();
    return /email|user|login|account|phone|tel/.test(hint);
  };
  const findLogin = () => {
    const passwords = Array.prototype.slice.call(document.querySelectorAll("input[type=password]"));
    for (const pass of passwords) {
      if (pass.disabled || pass.readOnly || !isVisible(pass)) continue;
      const scope = pass.form || document;
      const candidates = Array.prototype.slice
        .call(scope.querySelectorAll("input[type=text], input[type=email], input[type=tel], input:not([type])"))
        .filter((el) => el !== pass && !el.disabled && !el.readOnly && isVisible(el));
      const before = candidates.filter((el) => el.compareDocumentPosition(pass) & Node.DOCUMENT_POSITION_FOLLOWING);
      const pool = before.length ? before : candidates;
      const user = pool.filter(usernameLikely).pop() || pool.pop() || null;
      return { user, pass };
    }
    return null;
  };
`;

const SET_VALUE = `
  const setValue = (el, value) => {
    const proto = el.tagName === "INPUT" ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    el.focus();
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.blur();
  };
`;

/** Detects a login form; reports whether it has a username field and that field's current value. */
export function detectLoginScript(): string {
  return `(() => {${FIND_LOGIN}
  const login = findLogin();
  if (!login) return { hasPassword: false, hasUsername: false, username: "", origin: location.origin };
  return { hasPassword: true, hasUsername: Boolean(login.user), username: login.user ? String(login.user.value || "") : "", origin: location.origin };
})()`;
}

/** Fills the detected username and password through the native setters, firing input/change events. */
export function fillLoginScript(username: string, password: string): string {
  return `(() => {${FIND_LOGIN}${SET_VALUE}
  const login = findLogin();
  if (!login || !login.pass) return false;
  if (login.user && ${JSON.stringify(username)}) setValue(login.user, ${JSON.stringify(username)});
  setValue(login.pass, ${JSON.stringify(password)});
  return true;
})()`;
}
