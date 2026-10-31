/**
 * The strong password Corvus suggests under a field for a new password: which fields get it, and how
 * the person's choices (length, character classes) adapt to what the field takes (its maxlength,
 * minlength and pattern). The tab preload probes a field's pattern in the page (where a pattern that
 * takes ages to match only slows that page), the main process generates the password. Pure, no
 * imports but types, unit-tested.
 */
import type { PasswordOptions } from "./credentials";
import type { PasswordRole } from "./password-fields";

/** The generator's characters per class: no look-alikes (0/O, 1/l/I). */
export const PASSWORD_CHARSETS = {
  lowercase: "abcdefghijkmnpqrstuvwxyz",
  uppercase: "ABCDEFGHJKLMNPQRSTUVWXYZ",
  digits: "23456789",
  symbols: "!@#$%^&*-_=+?",
} as const;

export type PasswordClass = keyof typeof PASSWORD_CHARSETS;
export const PASSWORD_CLASSES: readonly PasswordClass[] = ["lowercase", "uppercase", "digits", "symbols"];
export type ClassFlags = Record<PasswordClass, boolean>;

/** The lengths the suggested password can take, and its first one. */
export const GENERATED_MIN = 8;
export const GENERATED_MAX = 128;
export const GENERATED_DEFAULT = 24;

/** What a field's pattern takes, as probed in the page. */
export interface PatternRules {
  /** The character classes it takes, and which of the generator's symbols. */
  allowed: ClassFlags;
  symbols: string;
  /** The classes it asks for. */
  required: ClassFlags;
  /** The lengths it takes, within the generator's. */
  minLength: number;
  maxLength: number;
}

/** What a password field takes. */
export interface FieldPasswordRules {
  /** 0 when the field sets none. */
  minLength: number;
  maxLength: number;
  /** It asks for digits (inputmode numeric): a PIN, not a password. */
  numeric: boolean;
  /** What its pattern takes; null without one, "none" when it takes nothing the generator makes. */
  pattern: PatternRules | "none" | null;
}

/** A click in a password field, as the tab preload reports it (never its value). */
export interface PasswordFieldClick {
  role: PasswordRole;
  /** Password fields in its form. */
  fields: number;
  /** It holds something ("Copy password" copies it). */
  filled: boolean;
  rules: FieldPasswordRules;
}

/** How the suggestion had to adapt to the field, for the generator to say. */
export type GeneratorNote =
  | { type: "max" | "min"; length: number }
  | { type: "without" | "with"; option: PasswordClass }
  | { type: "symbols"; symbols: string };

/** The options a password is made with for one field. */
export interface GeneratorFit {
  /** The person's choices, adapted to the field. */
  options: PasswordOptions;
  /** The symbols to draw from (only those the field takes). */
  symbols: string;
  /** The lengths the field takes. */
  minLength: number;
  maxLength: number;
  /** The classes the field decides (forbids or requires): their boxes are not the person's to change. */
  fixed: ClassFlags;
  notes: GeneratorNote[];
}

const flags = (pick: (c: PasswordClass) => boolean): ClassFlags => ({ lowercase: pick("lowercase"), uppercase: pick("uppercase"), digits: pick("digits"), symbols: pick("symbols") });
const clamp = (n: number, min: number, max: number): number => Math.max(min, Math.min(max, n));

/**
 * Whether the field gets the suggested password: a field for a new password or its confirmation, or a
 * lone password field (a sign-in form's) when Corvus has no login to offer for it. Never a PIN, a field
 * too short for a strong password, or one whose pattern takes none.
 */
export function offersGenerator(field: Pick<PasswordFieldClick, "role" | "fields" | "rules">, hasAccounts: boolean): boolean {
  const { rules } = field;
  if (rules.numeric || rules.pattern === "none" || (rules.maxLength > 0 && rules.maxLength < GENERATED_MIN)) return false;
  return field.role !== "current" || (field.fields === 1 && !hasAccounts);
}

/** The class subsets to try on a pattern: all of them first, symbols given up first, then the rest. */
const CLASS_SETS: PasswordClass[][] = Array.from({ length: 15 }, (_, i) => PASSWORD_CLASSES.filter((_c, bit) => ((15 - i) >> (3 - bit)) & 1))
  .sort((a, b) => b.length - a.length);

/**
 * What a pattern takes, from a test of whole values against it (the page's own, see the tab preload):
 * the largest set of character classes it takes in some length within the generator's, which of the
 * generator's symbols, which classes it asks for and the lengths it takes. Null when it takes none of
 * the generator's passwords. The values tried mix their classes' characters in turn, one of each.
 */
export function probePattern(fits: (value: string) => boolean): PatternRules | null {
  const all: number[] = [];
  for (let n = GENERATED_MIN; n <= GENERATED_MAX; n++) all.push(n);
  // Lengths a site is likely to cap a password at, to find a fitting one quickly.
  const likely = [24, 16, 12, 8, 20, 32, ...all.filter((n) => n <= 40 || n % 16 === 0)];
  const sample = (classes: PasswordClass[], symbols: string, length: number): string => {
    const pools = classes.map((c) => (c === "symbols" ? symbols : PASSWORD_CHARSETS[c]));
    let value = "";
    for (let i = 0; i < length; i++) {
      const pool = pools[i % pools.length]!;
      value += pool[Math.floor(i / pools.length) % pool.length];
    }
    return value;
  };
  const any = (classes: PasswordClass[], symbols: string): boolean => likely.some((n) => fits(sample(classes, symbols, n)));
  for (const classes of CLASS_SETS) {
    const symbols = classes.includes("symbols") ? [...PASSWORD_CHARSETS.symbols].filter((s) => any(classes, s)).join("") : "";
    if (classes.includes("symbols") && !symbols) continue;
    const lengths = all.filter((n) => fits(sample(classes, symbols, n)));
    if (lengths.length === 0) continue;
    return {
      allowed: flags((c) => classes.includes(c)),
      symbols,
      required: flags((c) => classes.includes(c) && (classes.length === 1 || !any(classes.filter((x) => x !== c), symbols))),
      minLength: lengths[0]!,
      maxLength: lengths[lengths.length - 1]!,
    };
  }
  return null;
}

/**
 * The person's choices adapted to the field: the length within what the field takes (its maxlength,
 * minlength and pattern), without the classes its pattern forbids and with those it asks for, from the
 * symbols it takes. Notes say each change, so the generator can tell the person.
 */
export function fitGenerator(prefs: PasswordOptions, rules: FieldPasswordRules): GeneratorFit {
  const pattern = rules.pattern && rules.pattern !== "none" ? rules.pattern : null;
  const maxLength = clamp(Math.min(rules.maxLength || GENERATED_MAX, pattern?.maxLength ?? GENERATED_MAX), GENERATED_MIN, GENERATED_MAX);
  const minLength = clamp(Math.max(rules.minLength, pattern?.minLength ?? 0), GENERATED_MIN, maxLength);
  const wanted = clamp(Math.round(prefs.length) || GENERATED_DEFAULT, GENERATED_MIN, GENERATED_MAX);
  const notes: GeneratorNote[] = [];
  if (wanted > maxLength) notes.push({ type: "max", length: maxLength });
  if (wanted < minLength) notes.push({ type: "min", length: minLength });
  const allowed = (c: PasswordClass): boolean => !pattern || pattern.allowed[c];
  const required = (c: PasswordClass): boolean => pattern?.required[c] === true;
  let on = flags((c) => required(c) || (prefs[c] && allowed(c)));
  for (const c of PASSWORD_CLASSES) {
    if (prefs[c] && !allowed(c)) notes.push({ type: "without", option: c });
    else if (!prefs[c] && required(c)) notes.push({ type: "with", option: c });
  }
  // Only forbidden classes were chosen: every class the field takes.
  if (!PASSWORD_CLASSES.some((c) => on[c])) on = flags(allowed);
  const symbols = pattern ? pattern.symbols : PASSWORD_CHARSETS.symbols;
  if (on.symbols && symbols !== PASSWORD_CHARSETS.symbols) notes.push({ type: "symbols", symbols });
  return {
    options: { length: clamp(wanted, minLength, maxLength), ...on },
    symbols,
    minLength,
    maxLength,
    fixed: flags((c) => !allowed(c) || required(c)),
    notes,
  };
}

/** A password field's facts from the tab preload, checked (it runs in the page's renderer); null when malformed. */
export function parsePasswordFieldClick(raw: unknown): PasswordFieldClick | null {
  if (typeof raw !== "object" || raw === null) return null;
  const v = raw as Record<string, unknown>;
  const r = (typeof v.rules === "object" && v.rules !== null ? v.rules : {}) as Record<string, unknown>;
  const count = (n: unknown, max: number): number => (typeof n === "number" && Number.isSafeInteger(n) && n > 0 ? Math.min(n, max) : 0);
  if ((v.role !== "current" && v.role !== "new" && v.role !== "confirm") || typeof v.filled !== "boolean") return null;
  return {
    role: v.role,
    fields: Math.max(1, count(v.fields, 100)),
    filled: v.filled,
    rules: { minLength: count(r.minLength, 10_000), maxLength: count(r.maxLength, 10_000), numeric: r.numeric === true, pattern: parsePatternRules(r.pattern) },
  };
}

function parsePatternRules(raw: unknown): PatternRules | "none" | null {
  if (raw === "none") return "none";
  if (typeof raw !== "object" || raw === null) return null;
  const v = raw as Record<string, unknown>;
  const classes = (value: unknown): ClassFlags | null => {
    const o = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
    return PASSWORD_CLASSES.every((c) => typeof o[c] === "boolean") ? flags((c) => o[c] === true) : null;
  };
  const allowed = classes(v.allowed);
  const required = classes(v.required);
  const length = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= GENERATED_MIN && n <= GENERATED_MAX;
  if (!allowed || !required || !length(v.minLength) || !length(v.maxLength) || v.minLength > v.maxLength || typeof v.symbols !== "string") return null;
  const symbols = [...new Set(v.symbols)].filter((s) => PASSWORD_CHARSETS.symbols.includes(s)).join("");
  return { allowed: { ...allowed, symbols: allowed.symbols && symbols !== "" }, required, symbols, minLength: v.minLength, maxLength: v.maxLength };
}

/** The person's choices with one class turned on or off; the last one left stays on. */
export function toggleClass(prefs: PasswordOptions, option: PasswordClass): PasswordOptions {
  const next = { ...prefs, [option]: !prefs[option] };
  return PASSWORD_CLASSES.some((c) => next[c]) ? next : prefs;
}
