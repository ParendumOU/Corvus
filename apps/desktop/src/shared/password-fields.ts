/**
 * Password fields and their part in a form: the current password, a new one, or its confirmation. The
 * tab preload uses this to tell a click in a field for a new password (where Corvus suggests a strong
 * one) and which password a submitted form sets; the autofill scripts (main/credential-scripts.ts)
 * embed both functions' source, so a suggestion fills the fields the click saw. Both functions are
 * self-contained on purpose: no imports and no outer names, only what they are handed (the preload is
 * type-checked without the DOM library, hence the small structural types below).
 */

export type PasswordRole = "current" | "new" | "confirm";

/** What tells a password field's part, read from the field and its labels. */
export interface PasswordFieldFacts {
  /** Lowercased autocomplete attribute. */
  autocomplete: string;
  /** Its name, id, aria-label, placeholder, title and labels, lowercased. */
  hints: string;
}

interface TextNode {
  readonly textContent: string | null;
}

/** The parts of a password input the facts are read from. */
export interface PasswordInputElement {
  readonly name: string;
  readonly id: string;
  readonly labels: ArrayLike<TextNode> | null;
  readonly ownerDocument: { getElementById(id: string): TextNode | null };
  getAttribute(name: string): string | null;
}

/** Reads the facts of a password input from the page. */
export function passwordFieldFacts(el: PasswordInputElement): PasswordFieldFacts {
  const attr = (name: string): string => el.getAttribute(name) || "";
  const texts = [el.name || "", el.id || "", attr("aria-label"), attr("placeholder"), attr("title")];
  for (let i = 0; el.labels && i < el.labels.length; i++) texts.push(el.labels[i]?.textContent || "");
  for (const id of attr("aria-labelledby").split(/\s+/)) if (id) texts.push(el.ownerDocument.getElementById(id)?.textContent || "");
  return { autocomplete: attr("autocomplete").toLowerCase(), hints: texts.join(" ").replace(/\s+/g, " ").trim().toLowerCase() };
}

/**
 * The part of each password field of one form, in page order:
 * - autocomplete="current-password", or a label like "Current", "Old" or "Contraseña actual": the
 *   current password; "Confirm", "Repeat", "Again" or "password2": a confirmation; autocomplete
 *   "new-password", or "New", "Create" or "Choose": a new password (a second one confirms the first);
 * - unnamed fields go by their place: before the new password the current one, after it its
 *   confirmation; with none named, a lone field signs in, two are a new password and its confirmation,
 *   and three or more are the current password, the new one and its confirmation.
 */
export function passwordRoles(fields: readonly PasswordFieldFacts[]): PasswordRole[] {
  const CONFIRM = /confirm|repeat|retype|re-?enter|again|verif|repit|repet|otra vez|de nuevo|(pass(word)?|pwd|pw)[\s_-]?(2|two)\b/;
  const CURRENT = /current|existing|actual|anterior|antigu|(^|[^a-z])old/;
  const NEW = /new|nuev|creat|choose|elig|regist|sign[\s_-]?up/;
  const roles = fields.map((f): PasswordRole | null => {
    const tokens = f.autocomplete.split(/\s+/);
    if (tokens.includes("current-password") || CURRENT.test(f.hints)) return "current";
    if (CONFIRM.test(f.hints)) return "confirm";
    return tokens.includes("new-password") || NEW.test(f.hints) ? "new" : null;
  });
  let at = roles.indexOf("new");
  roles.forEach((r, i) => {
    if (r === "new" && i > at) roles[i] = "confirm";
  });
  if (roles.length === 1) return [roles[0] ?? "current"];
  if (at < 0) {
    const confirmAt = roles.indexOf("confirm");
    const unknown = roles.flatMap((r, i) => (r === null ? [i] : []));
    const before = unknown.filter((i) => i < confirmAt);
    at = confirmAt >= 0 ? (before[before.length - 1] ?? -1) : (unknown[!roles.includes("current") && roles.length >= 3 ? 1 : 0] ?? -1);
  }
  return roles.map((r, i) => r ?? (at < 0 || i < at ? "current" : i === at ? "new" : "confirm"));
}
