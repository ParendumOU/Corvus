/**
 * One-time-code (2FA) fields: which inputs of a page take the code an authenticator app shows. The tab
 * preload uses this to tell a click in a code field from one in a login field, and the autofill
 * scripts (main/credential-scripts.ts) embed both functions' source, so the page probe, the fills and
 * the click all decide alike. Both functions are self-contained on purpose: no imports and no outer
 * names, only what they are handed (the preload is type-checked without the DOM library, hence the
 * small structural types below).
 */

/** What decides whether an input takes a one-time code, read from the input and the text around it. */
export interface OtpFieldFacts {
  /** Lowercased type attribute; "text" when absent. */
  type: string;
  /** Lowercased autocomplete attribute. */
  autocomplete: string;
  /** Lowercased inputmode attribute. */
  inputMode: string;
  /** -1 when not set. */
  maxLength: number;
  pattern: string;
  placeholder: string;
  /** Its name, id, aria-label and title. */
  attrs: string;
  /** Its labels: label elements (for= or wrapping) and aria-labelledby. */
  label: string;
  /** Text beside it: aria-describedby, and the elements next to it and to its single-field wrappers. */
  context: string;
}

interface DomNode {
  readonly parentElement: DomNode | null;
  readonly previousElementSibling: DomNode | null;
  readonly nextElementSibling: DomNode | null;
  readonly textContent: string | null;
  querySelectorAll(selectors: string): { readonly length: number };
}

/** The parts of an input element the facts are read from. */
export interface OtpInputElement extends DomNode {
  readonly name: string;
  readonly id: string;
  readonly maxLength: number;
  readonly labels: ArrayLike<DomNode> | null;
  readonly ownerDocument: { getElementById(id: string): DomNode | null };
  getAttribute(name: string): string | null;
}

/** Reads the facts of an input from the page. */
export function otpFieldFacts(el: OtpInputElement): OtpFieldFacts {
  const attr = (name: string): string => el.getAttribute(name) || "";
  // textContent, not innerText: reading it never lays the page out, and every field of a page is read.
  const textOf = (node: DomNode | null): string => (node?.textContent || "").replace(/\s+/g, " ").trim();
  const FIELDS = "input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]):not([type=image]):not([type=checkbox]):not([type=radio]), select, textarea";
  const byIds = (ids: string): string =>
    ids.split(/\s+/).filter(Boolean).map((id) => textOf(el.ownerDocument.getElementById(id))).join(" ");
  const labels: string[] = [];
  for (let i = 0; el.labels && i < el.labels.length; i++) labels.push(textOf(el.labels[i] ?? null));
  // Labels and help that are not tied to the field: the elements next to it, then next to each
  // wrapper around it that holds no other field (a wrapper with more fields is a form, not a field).
  const near: string[] = [];
  let node: DomNode = el;
  for (let depth = 0; depth < 3; depth++) {
    for (const side of [node.previousElementSibling, node.nextElementSibling]) {
      // Short text only: a long one is the page around the field, not its label (and costly to scan).
      const short = side && (side.textContent || "").length <= 300;
      const text = short && side.querySelectorAll(FIELDS).length === 0 ? textOf(side) : "";
      if (text && text.length <= 200) near.push(text);
    }
    const parent = node.parentElement;
    if (!parent || parent.querySelectorAll(FIELDS).length > 1) break;
    node = parent;
  }
  return {
    type: (attr("type") || "text").toLowerCase(),
    autocomplete: attr("autocomplete").toLowerCase(),
    inputMode: attr("inputmode").toLowerCase(),
    maxLength: typeof el.maxLength === "number" ? el.maxLength : -1,
    pattern: attr("pattern"),
    placeholder: attr("placeholder"),
    attrs: [el.name || "", el.id || "", attr("aria-label"), attr("title")].join(" ").trim(),
    label: [...labels, byIds(attr("aria-labelledby"))].join(" ").trim(),
    context: [byIds(attr("aria-describedby")), ...near].join(" ").trim(),
  };
}

/**
 * Whether an input with these facts takes a one-time code:
 * - autocomplete="one-time-code" (text, tel, number or password inputs);
 * - a text, tel or number input whose name, label or placeholder reads like a 2FA code ("otp",
 *   "totp", "2fa", "verification code", "one-time code", "codigo de verificacion"...), unless it reads
 *   like a card, coupon, phone, e-mail, user name or search field;
 * - one shaped like a code (numeric with 6 to 8 characters, a 6 to 8 digit pattern, or a placeholder
 *   like "123456", "1 2 3 4 5 6" or "XXX-XXX") that says "code", or whose neighbouring text speaks of
 *   a verification code, an authenticator app or two-factor sign-in (and not of a card or coupon).
 */
export function isOtpFacts(f: OtpFieldFacts): boolean {
  const OTP_HINT = /(one[-_ ]?time|\botp\b|totp|2fa|\bmfa\b|two[-_ ]?(factor|step)|verification[-_ ]?code|verify[-_ ]?code|auth(entication|enticator)?[-_ ]?code|security[-_ ]?code|login[-_ ]?code|sign[-_ ]?in[-_ ]?code|passcode|c[o\u00f3]digo de (verificaci[o\u00f3]n|seguridad|acceso|autenticaci[o\u00f3]n)|un solo uso|(doble|dos) (factor|pasos))/i;
  const NEARBY_HINT = /(one[-_ ]?time|\botp\b|totp|2fa|\bmfa\b|two[-_ ]?(factor|step)|verification[-_ ]?code|verify[-_ ]?code|authenticator|authentication[-_ ]?code|login[-_ ]?code|sign[-_ ]?in[-_ ]?code|c[o\u00f3]digo de (verificaci[o\u00f3]n|acceso|autenticaci[o\u00f3]n)|autenticador|un solo uso|(doble|dos) (factor|pasos))/i;
  const NOT_OTP = /(card|cvv|cvc|csc|credit|zip|postal|promo|coupon|voucher|gift|captcha|phone|e-?mail|user|search|referral|invite|tarjeta|cup[o\u00f3]n|tel[e\u00e9]fono|usuario)/i;
  const NOT_NEARBY = /(card|cvv|cvc|csc|credit|zip|postal|promo|coupon|voucher|gift|captcha|tarjeta|cup[o\u00f3]n)/i;
  if (!["text", "tel", "number", "password"].includes(f.type)) return false;
  if (f.autocomplete.split(/\s+/).includes("one-time-code")) return true;
  if (f.type === "password") return false;
  const own = `${f.attrs} ${f.placeholder} ${f.label}`;
  if (NOT_OTP.test(own)) return false;
  if (OTP_HINT.test(own)) return true;
  const numeric = f.inputMode === "numeric" || f.type === "number";
  const sized = f.maxLength >= 6 && f.maxLength <= 8;
  const digitPattern = /(\\d|\[0-9\])\{[6-8](,[6-8]?)?\}/.test(f.pattern);
  const masked = /^([0-9]{6,8}|[xX#*_\u2022\u00b7]{6,8})$/.test(f.placeholder.replace(/[\s-]+/g, ""));
  const saysCode = /code|token|c[o\u00f3]digo/i.test(own);
  if (numeric && sized && saysCode) return true;
  if (masked && (numeric || sized || digitPattern || saysCode)) return true;
  return NEARBY_HINT.test(f.context) && !NOT_NEARBY.test(f.context) && (masked || numeric || sized || digitPattern || saysCode);
}
