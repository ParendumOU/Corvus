/**
 * Isolated-world scripts for autofill. They run in their own world (shared DOM, separate JS globals)
 * so page scripts cannot read Corvus' logic or the values it writes before the page does. Kept as
 * plain strings so the bundler cannot rewrite them. They share one login-form finder and one
 * one-time-code field finder, whose field test is the source of shared/otp-field.ts's self-contained
 * functions (the tab preload runs the same functions to tell which kind of field was clicked).
 *
 * Secret values (passwords, 2FA codes) are embedded in the script text only for the fill call itself
 * and are never logged. Fields Corvus fills with a secret are marked `data-corvus-secret` so the
 * agent's page snapshot never reports their value; agent fills also mask them on screen.
 */
import { isOtpFacts, otpFieldFacts } from "../shared/otp-field";

/** Separate from the agent (1717), reader (1721) and assist worlds. */
export const AUTOFILL_WORLD_ID = 1723;

/** Attribute on fields Corvus filled with a secret; snapshots never include their value. */
export const SECRET_FIELD_ATTR = "data-corvus-secret";

export interface LoginDetection {
  hasPassword: boolean;
  hasUsername: boolean;
  /** Current value of the detected username field (so a save can capture it). */
  username: string;
  /** A visible one-time-code (2FA) field is on the page. */
  hasOtp: boolean;
  origin: string;
}

/** What a fill-by-reference wrote; never the values themselves. */
export interface FillOutcome {
  ok: boolean;
  /** Why nothing was filled: "missing" (ref gone), "not-field", "no-form". */
  reason?: string;
  user?: boolean;
  pass?: boolean;
  /** Number of inputs written (split one-time-code boxes count one each). */
  fields?: number;
}

const IS_VISIBLE = `
  const isVisible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none";
  };
`;

/**
 * Locates the page's login form: the first visible, enabled password field and the text/email field
 * most likely to be its username (same form, prefers email/autocomplete hints, else the nearest
 * preceding text input). Returns `{ user, pass }` DOM elements or null.
 */
const FIND_LOGIN = `
  const usernameLikely = (el) => {
    const hint = ((el.name || "") + " " + (el.id || "") + " " + (el.getAttribute("autocomplete") || "") + " " + (el.getAttribute("type") || "")).toLowerCase();
    return /email|user|login|account|phone|tel/.test(hint);
  };
  const userCandidates = (scope, exclude) => Array.prototype.slice
    .call(scope.querySelectorAll("input[type=text], input[type=email], input[type=tel], input:not([type])"))
    .filter((el) => el !== exclude && !el.disabled && !el.readOnly && isVisible(el) && !isOtpField(el));
  const userFor = (pass) => {
    const candidates = userCandidates(pass.form || document, pass);
    const before = candidates.filter((el) => el.compareDocumentPosition(pass) & Node.DOCUMENT_POSITION_FOLLOWING);
    const pool = before.length ? before : candidates;
    return pool.filter(usernameLikely).pop() || pool.pop() || null;
  };
  const findLogin = () => {
    const passwords = Array.prototype.slice.call(document.querySelectorAll("input[type=password]"));
    for (const pass of passwords) {
      if (pass.disabled || pass.readOnly || !isVisible(pass) || isOtpField(pass)) continue;
      return { user: userFor(pass), pass };
    }
    return null;
  };
`;

/**
 * One-time-code fields, as shared/otp-field.ts decides (its functions' source is embedded here), or a
 * row of 6 to 8 single-character boxes. Returns the input(s) to fill, in order, or null.
 */
const FIND_OTP = `
  const otpFieldFacts = ${String(otpFieldFacts)};
  const isOtpFacts = ${String(isOtpFacts)};
  const autoOtp = (el) => (el.getAttribute("autocomplete") || "").toLowerCase().split(/\\s+/).includes("one-time-code");
  const typeOf = (el) => (el.getAttribute("type") || "text").toLowerCase();
  const otpCapable = (el) => el.tagName === "INPUT" && ["text", "tel", "number", "password"].includes(typeOf(el));
  // A password field is a code field only when marked so: no need to read its facts.
  const isOtpField = (el) => otpCapable(el) && (typeOf(el) !== "password" || autoOtp(el)) && isOtpFacts(otpFieldFacts(el));
  const usableInput = (el) => el && otpCapable(el) && !el.disabled && !el.readOnly && isVisible(el);
  const commonAncestor = (els, depth) => {
    let node = els[0].parentElement;
    for (let i = 0; node && i < depth; i++, node = node.parentElement) {
      if (els.every((e) => node.contains(e))) return node;
    }
    return null;
  };
  const splitBoxesAround = (seed) => {
    const scope = (seed && (seed.form || seed.closest("fieldset, [role=group], div"))) || document;
    const boxes = Array.prototype.slice.call((scope.querySelectorAll ? scope : document).querySelectorAll("input"))
      .filter((el) => usableInput(el) && el.maxLength === 1 && typeOf(el) !== "password");
    if (boxes.length < 6 || boxes.length > 8) return null;
    if (seed && !boxes.includes(seed)) return null;
    return commonAncestor(boxes, 4) ? boxes : null;
  };
  const findOtp = () => {
    const inputs = Array.prototype.slice.call(document.querySelectorAll("input")).filter(usableInput);
    const exact = inputs.find(autoOtp);
    if (exact) return exact.maxLength === 1 ? splitBoxesAround(exact) || [exact] : [exact];
    const split = splitBoxesAround(null);
    if (split) return split;
    const hinted = inputs.find(isOtpField);
    return hinted ? [hinted] : null;
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
  const markSecret = (el, mask) => {
    el.setAttribute("${SECRET_FIELD_ATTR}", "1");
    if (mask) el.style.setProperty("-webkit-text-security", "disc", "important");
  };
  const fillCode = (fields, code, mask) => {
    if (fields.length > 1) fields.forEach((el, i) => setValue(el, code.charAt(i)));
    else setValue(fields[0], code);
    fields.forEach((el) => markSecret(el, mask));
    return fields.length;
  };
`;

const PRELUDE = `${IS_VISIBLE}${FIND_OTP}${FIND_LOGIN}${SET_VALUE}`;

const findRef = (ref: string): string =>
  `document.querySelector('[data-corvus-ref="' + ${JSON.stringify(ref)}.replace(/["\\\\]/g, "") + '"]')`;

/** Detects a login form and a one-time-code field; reports the username field's current value. */
export function detectLoginScript(): string {
  return `(() => {${PRELUDE}
  const login = findLogin();
  const hasOtp = Boolean(findOtp());
  if (!login) return { hasPassword: false, hasUsername: false, username: "", hasOtp, origin: location.origin };
  return { hasPassword: true, hasUsername: Boolean(login.user), username: login.user ? String(login.user.value || "") : "", hasOtp, origin: location.origin };
})()`;
}

/**
 * Fills the detected username and password through the native setters, firing input/change events.
 * An empty password (a login that holds only a 2FA) leaves the password field as it is. With `submit`
 * (auto sign-in, after the person confirmed), also submits the login form; with `keepTyped`, fields
 * that already hold something are left alone.
 */
export function fillLoginScript(username: string, password: string, opts: { submit?: boolean; keepTyped?: boolean } = {}): string {
  return `(() => {${PRELUDE}
  const login = findLogin();
  if (!login || !login.pass) return false;
  const free = (el) => !${opts.keepTyped ? "true" : "false"} || !el.value;
  if (login.user && ${JSON.stringify(username)} && free(login.user)) setValue(login.user, ${JSON.stringify(username)});
  if (!${JSON.stringify(password)}) return Boolean(login.user);
  if (free(login.pass)) {
    setValue(login.pass, ${JSON.stringify(password)});
    markSecret(login.pass, false);
  }
  if (${opts.submit ? "true" : "false"}) {
    const form = login.pass.form;
    const button = (form || document).querySelector("button[type=submit], input[type=submit], button:not([type])");
    if (form && typeof form.requestSubmit === "function") form.requestSubmit(button && button.form === form ? button : undefined);
    else if (button) button.click();
    else login.pass.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
  }
  return true;
})()`;
}

/** Fills the page's one-time-code field (the person's pick). Returns the fields written. */
export function fillOtpScript(code: string): string {
  return `(() => {${PRELUDE}
  const fields = findOtp();
  if (!fields) return 0;
  return fillCode(fields, ${JSON.stringify(code)}, false);
})()`;
}

/**
 * Agent fill of a 2FA code into the element a snapshot ref points at (or the split-box row it belongs
 * to). The field is marked secret and masked on screen so neither snapshots nor screenshots show it.
 */
export function fillOtpByRefScript(ref: string, code: string): string {
  return `(() => {${PRELUDE}
  const el = ${findRef(ref)};
  if (!el) return { ok: false, reason: "missing" };
  if (!usableInput(el) || typeOf(el) === "password" && !autoOtp(el)) return { ok: false, reason: "not-field" };
  const fields = el.maxLength === 1 ? splitBoxesAround(el) || [el] : [el];
  return { ok: true, fields: fillCode(fields, ${JSON.stringify(code)}, true) };
})()`;
}

/**
 * Agent sign-in by reference. With a ref, the login is located around that field: a password field
 * gets the password (and the form's username field), a text field gets the username (and the form's
 * password field if there is one, so two-step sign-ins work). Without a ref, the page's login form.
 */
export function fillLoginByRefScript(ref: string | null, username: string, password: string): string {
  return `(() => {${PRELUDE}
  let user = null;
  let pass = null;
  const ref = ${JSON.stringify(ref)};
  if (ref) {
    const el = ${findRef(ref ?? "")};
    if (!el) return { ok: false, reason: "missing" };
    if (el.tagName !== "INPUT" || el.disabled || el.readOnly) return { ok: false, reason: "not-field" };
    if (typeOf(el) === "password") {
      pass = el;
      user = userFor(el);
    } else if (["text", "email", "tel"].includes(typeOf(el))) {
      user = el;
      const scope = el.form || document;
      pass = Array.prototype.slice.call(scope.querySelectorAll("input[type=password]")).find((p) => !p.disabled && !p.readOnly && isVisible(p) && !isOtpField(p)) || null;
    } else {
      return { ok: false, reason: "not-field" };
    }
  } else {
    const login = findLogin();
    if (!login) return { ok: false, reason: "no-form" };
    user = login.user;
    pass = login.pass;
  }
  const name = ${JSON.stringify(username)};
  if (user && name) setValue(user, name);
  if (pass) {
    setValue(pass, ${JSON.stringify(password)});
    markSecret(pass, true);
  }
  const filledUser = Boolean(user && name);
  if (!filledUser && !pass) return { ok: false, reason: "no-form" };
  return { ok: true, user: filledUser, pass: Boolean(pass) };
})()`;
}
