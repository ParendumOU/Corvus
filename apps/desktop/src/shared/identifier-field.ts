/**
 * The first step of a two-step ("identifier first") sign-in: a page that asks only for the e-mail or
 * username, and for the password on the next step (login.ionos.es, Google, Microsoft). The tab
 * preload uses this to tell a click in such a field from one in any other text field, and the
 * autofill scripts (main/credential-scripts.ts) embed both functions' source, so the probe, the fill
 * and the click decide alike. Both functions are self-contained on purpose: no imports and no outer
 * names, only what they are handed (the preload is type-checked without the DOM library, hence the
 * small structural types below).
 */

/** What decides whether a text field is a sign-in's username step, read from the field and its form. */
export interface IdentifierFieldFacts {
  /** Lowercased type attribute; "text" when absent. */
  type: string;
  /** Lowercased autocomplete attribute. */
  autocomplete: string;
  /** Its name, id, aria-label, placeholder, title and labels, lowercased. */
  hints: string;
  /** It sits in a search form (role=search). */
  search: boolean;
  /** Its form (or the part of the page around it with a button, without a form). */
  form: {
    /** A password field shows in it: a one-step login form, not a username step. */
    password: boolean;
    /** A field in it, shown or not, is marked for a new password: a sign-up form. */
    newPassword: boolean;
    /** Text fields that show in it, this one included. */
    textFields: number;
    /** Its action, name, id and aria-label, and the text of its buttons, lowercased. */
    hints: string;
  };
}

interface Box {
  readonly width: number;
  readonly height: number;
}

interface DomElement {
  readonly tagName: string;
  readonly textContent: string | null;
  readonly parentElement: DomElement | null;
  getAttribute(name: string): string | null;
  getBoundingClientRect(): Box;
  querySelectorAll(selectors: string): ArrayLike<DomElement>;
}

/** The parts of an input element the facts are read from. */
export interface IdentifierInputElement extends DomElement {
  readonly name: string;
  readonly id: string;
  readonly form: DomElement | null;
  readonly labels: ArrayLike<{ readonly textContent: string | null }> | null;
  readonly ownerDocument: {
    getElementById(id: string): { readonly textContent: string | null } | null;
    readonly defaultView: { getComputedStyle(el: DomElement): { readonly visibility: string; readonly display: string } } | null;
  };
  closest(selectors: string): DomElement | null;
}

/** Reads the facts of a text field and its form from the page. */
export function identifierFieldFacts(el: IdentifierInputElement): IdentifierFieldFacts {
  const attr = (node: DomElement, name: string): string => node.getAttribute(name) || "";
  const textOf = (node: { readonly textContent: string | null } | null): string => (node?.textContent || "").replace(/\s+/g, " ").trim();
  const shows = (node: DomElement): boolean => {
    const r = node.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const style = el.ownerDocument.defaultView?.getComputedStyle(node);
    return !style || (style.visibility !== "hidden" && style.display !== "none");
  };
  const BUTTONS = "button, input[type=submit], input[type=button], [role=button]";
  // Without a form: the nearest part of the page around the field that has a button (its "Next").
  let scope: DomElement | null = el.form;
  for (let node = el.parentElement, depth = 0; !scope && node && depth < 6; node = node.parentElement, depth++) {
    if (node.querySelectorAll(BUTTONS).length > 0) scope = node;
  }
  const inputs = scope ? Array.prototype.slice.call(scope.querySelectorAll("input")) as DomElement[] : [el];
  const typeOf = (node: DomElement): string => (attr(node, "type") || "text").toLowerCase();
  const buttons = scope ? (Array.prototype.slice.call(scope.querySelectorAll(BUTTONS)) as DomElement[]) : [];
  const texts = [el.name || "", el.id || "", attr(el, "aria-label"), attr(el, "placeholder"), attr(el, "title")];
  for (let i = 0; el.labels && i < el.labels.length; i++) texts.push(textOf(el.labels[i] ?? null));
  for (const id of attr(el, "aria-labelledby").split(/\s+/)) if (id) texts.push(textOf(el.ownerDocument.getElementById(id)));
  const formTexts = scope ? [attr(scope, "action"), attr(scope, "name"), attr(scope, "id"), attr(scope, "aria-label")] : [];
  for (const b of buttons) formTexts.push((attr(b, "value") || textOf(b) || attr(b, "aria-label")).slice(0, 80));
  const lower = (parts: string[]): string => parts.join(" ").replace(/\s+/g, " ").trim().toLowerCase();
  return {
    type: typeOf(el),
    autocomplete: attr(el, "autocomplete").toLowerCase(),
    hints: lower(texts),
    search: Boolean(el.closest("[role=search]")),
    form: {
      password: inputs.some((i) => typeOf(i) === "password" && shows(i)),
      newPassword: inputs.some((i) => attr(i, "autocomplete").toLowerCase().split(/\s+/).includes("new-password")),
      textFields: inputs.filter((i) => ["text", "email", "tel", "number"].includes(typeOf(i)) && shows(i)).length,
      hints: lower(formTexts),
    },
  };
}

/**
 * Whether a text field with these facts is a sign-in's username step: a text, e-mail or phone field
 * with no password field showing in its form (a hidden decoy one does not count), not for a one-time
 * code, a search, a newsletter or a sign-up (a new-password field, or only Subscribe, Register or
 * Create account buttons, with none to sign in or go on), with at most one other text field next to it, and
 * - marked autocomplete="username", or
 * - marked autocomplete="email", or named like a username ("identifier", "user", "login", "e-mail",
 *   "account", "usuario", "correo", "ID de cliente"...), in a form whose button or address speaks of
 *   signing in or going on ("Sign in", "Next", "Continue", "Siguiente", "Iniciar sesion", "Acceder").
 */
export function isIdentifierFacts(f: IdentifierFieldFacts): boolean {
  const LOGIN = /sign[\s_-]?in|log[\s_-]?[io]n|logon|next|continue|weiter|siguiente|continuar|iniciar|acceder|entrar|identif|auth|sesi[oó]n/;
  const NOT_LOGIN = /subscri|suscri|newsletter|bolet[ií]n|sign[\s_-]?up|regist|create|crear|join|[uú]nete|contact|search|buscar|forgot|reset|recuper|olvid/;
  const USERNAME = /identifier|user|login|e-?mail|correo|account|cuenta|usuario|member|socio|client|customer|dni|nif|phone|tel[eé]fono/;
  const tokens = f.autocomplete.split(/\s+/);
  if (!["text", "email", "tel"].includes(f.type) || f.search || tokens.includes("one-time-code") || tokens.includes("new-password")) return false;
  // A sign-in page may also offer "Create account" or "Forgot email?": its "Next" decides.
  const login = LOGIN.test(f.form.hints);
  if (f.form.password || f.form.newPassword || f.form.textFields > 2 || (NOT_LOGIN.test(f.form.hints) && !login) || /search|buscar/.test(f.hints)) return false;
  if (tokens.includes("username")) return true;
  return login && (tokens.includes("email") || USERNAME.test(f.hints));
}
