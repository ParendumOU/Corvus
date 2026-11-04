/**
 * Card form detection and fill values: which saved-card value each field of a page's card form takes.
 * Everything lives inside cardKit, which is self-contained on purpose (no imports, no outer names): the
 * fill script embeds its source with `String(cardKit)`, and the tab preload calls the same functions, so
 * the click, the fill and the save prompt all decide alike (see address-fields.ts for why).
 *
 * The security code field is recognised ("csc") only so the fill can write the CVV the person typed in
 * Corvus's prompt and so the other code never mistakes it for something else; nothing ever reads it.
 */
import type { CardFields } from "./cards";

export const CARD_ROLES = ["number", "name", "givenName", "familyName", "exp", "expMonth", "expYear", "csc"] as const;
export type CardRole = (typeof CARD_ROLES)[number];

/** What the page script reads from a form field to classify it. */
export interface CardFieldFacts {
  tag: "INPUT" | "SELECT" | "TEXTAREA";
  type: string;
  autocomplete: string;
  name: string;
  id: string;
  label: string;
  placeholder: string;
  /** The field's maxlength, 0 when it has none. */
  maxLength: number;
}

interface DomText {
  readonly textContent: string | null;
}

/** The parts of a form field the facts are read from (the preload is type-checked without the DOM library). */
export interface CardInputElement {
  readonly tagName: string;
  readonly name: string;
  readonly id: string;
  readonly labels: ArrayLike<DomText> | null;
  readonly ownerDocument: { getElementById(id: string): DomText | null };
  getAttribute(name: string): string | null;
}

/** A field of the form being filled: its facts, what it holds now, and whether it is the one clicked. */
export interface CardFillField {
  facts: CardFieldFacts;
  value: string;
  anchor: boolean;
}

export interface CardKit {
  cardFieldFacts(el: CardInputElement): CardFieldFacts;
  classifyCardField(f: CardFieldFacts): CardRole | null;
  isCardForm(roles: readonly (CardRole | null)[]): boolean;
  planCardFill(fields: readonly CardFillField[], card: CardFields, cvv: string): (string | null)[];
  matchCardOption(options: readonly { value: string; text: string }[], wanted: string): string | null;
}

export function cardKit(): CardKit {
  const foldText = (s: string): string =>
    s
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .trim();

  const cardFieldFacts = (el: CardInputElement): CardFieldFacts => {
    const attr = (name: string): string => el.getAttribute(name) || "";
    const textOf = (node: DomText | null): string => (node?.textContent || "").replace(/\s+/g, " ").trim();
    const labels: string[] = [];
    for (let i = 0; el.labels && i < el.labels.length; i++) labels.push(textOf(el.labels[i] ?? null));
    const byIds = attr("aria-labelledby")
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => textOf(el.ownerDocument.getElementById(id)));
    const tag = String(el.tagName).toUpperCase();
    const max = Number(attr("maxlength"));
    return {
      tag: tag === "SELECT" || tag === "TEXTAREA" ? tag : "INPUT",
      type: (attr("type") || (tag === "INPUT" ? "text" : tag.toLowerCase())).toLowerCase(),
      autocomplete: attr("autocomplete").toLowerCase(),
      name: el.name || "",
      id: el.id || "",
      label: [...labels, ...byIds, attr("aria-label")].join(" ").replace(/\s+/g, " ").trim().slice(0, 200),
      placeholder: attr("placeholder"),
      maxLength: Number.isFinite(max) && max > 0 ? max : 0,
    };
  };

  const classifyCardField = (f: CardFieldFacts): CardRole | null => {
    const skipTypes = ["password", "hidden", "checkbox", "radio", "submit", "button", "file", "search", "image", "reset", "email"];
    if (f.tag === "INPUT" && skipTypes.includes(foldText(f.type))) return null;
    const tokens = foldText(f.autocomplete)
      .split(/\s+/)
      .filter((t) => t && t !== "shipping" && t !== "billing" && !t.startsWith("section-"));
    const token = tokens[tokens.length - 1] ?? "";
    const byToken: Record<string, CardRole> = {
      "cc-number": "number",
      "cc-name": "name",
      "cc-given-name": "givenName",
      "cc-family-name": "familyName",
      "cc-exp": "exp",
      "cc-exp-month": "expMonth",
      "cc-exp-year": "expYear",
      "cc-csc": "csc",
    };
    if (Object.prototype.hasOwnProperty.call(byToken, token)) return byToken[token] ?? null;

    const words = (s: string): string =>
      foldText(s.replace(/([a-z])([A-Z])/g, "$1 $2"))
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
    const hint = [f.name, f.id, f.label, f.placeholder].map(words).filter(Boolean).join(" ");
    if (!hint) return null;
    if (/gift|regalo|coupon|cupon|voucher|password|contrasena|\bpin\b|promo/.test(hint)) return null;
    const exp = /expir|\bexp\b|caducidad|caduca|vencimiento|vence|valid (thru|until)|validez/;
    const rules: [RegExp, CardRole][] = [
      [/\bcvv|\bcvc|\bcvn|\bcsc\b|security code|codigo de seguridad|card ?verification|\bcid\b/, "csc"],
      [/\bmm ?(yy|aa|yyyy|aaaa)\b/, "exp"],
      [new RegExp(`(${exp.source}).*\\b(month|mes|mm)\\b|\\b(month|mes)\\b.*(${exp.source})|\\b(cc|card|exp) ?(month|mm)\\b`), "expMonth"],
      [new RegExp(`(${exp.source}).*\\b(year|ano|yy|yyyy|aa|aaaa)\\b|\\b(year|ano)\\b.*(${exp.source})|\\b(cc|card|exp) ?(year|yy|yyyy)\\b`), "expYear"],
      [new RegExp(`${exp.source}|\\bmm ?(yy|aa|yyyy|aaaa)\\b`), "exp"],
      [/card ?(number|no\b|num\b)|cardnumber|\bcc ?(num|number|no)\b|ccnumber|numero de (la )?tarjeta|\bnum(ero)? tarjeta|\bpan\b/, "number"],
      [/name on card|card ?holder|holder ?name|titular|nombre (en|de) (la )?tarjeta|nombre del titular|\bcc ?name|ccname|card ?name/, "name"],
    ];
    for (const [re, role] of rules) if (re.test(hint)) return role;
    return null;
  };

  const isCardForm = (roles: readonly (CardRole | null)[]): boolean => roles.includes("number");

  /** The expiry as a single field takes it: its placeholder or length says the separator and the year's digits. */
  const expiryFor = (f: CardFieldFacts, mm: string, yyyy: string): string => {
    const hint = `${f.placeholder} ${f.label}`.toLowerCase();
    const shape = /m{1,2}\s*([/\-. ]*)\s*(y{2,4}|a{2,4})/.exec(hint);
    if (shape) {
      const sep = shape[1]!.trim() || (shape[1]!.length > 0 ? " " : "");
      return `${mm}${sep}${shape[2]!.length >= 4 ? yyyy : yyyy.slice(-2)}`;
    }
    if (f.maxLength === 4) return `${mm}${yyyy.slice(-2)}`;
    if (f.maxLength === 6) return `${mm}${yyyy}`;
    if (f.maxLength >= 7) return `${mm}/${yyyy}`;
    return `${mm}/${yyyy.slice(-2)}`;
  };

  const yearFor = (f: CardFieldFacts, yyyy: string): string => {
    const hint = foldText(`${f.placeholder}`);
    return f.maxLength === 2 || /^(yy|aa)$/.test(hint) ? yyyy.slice(-2) : yyyy;
  };

  /**
   * What each field of a card form gets from a saved card and the CVV the person just typed: null leaves
   * it alone. Nothing unless the clicked field is a card field of a card form; a field that already holds
   * something stays as it is (except the one clicked). An empty CVV writes no security code.
   */
  const planCardFill = (fields: readonly CardFillField[], card: CardFields, cvv: string): (string | null)[] => {
    const roles = fields.map((f) => classifyCardField(f.facts));
    const anchor = fields.findIndex((f) => f.anchor);
    if (anchor < 0 || roles[anchor] === null || !isCardForm(roles)) return fields.map(() => null);
    const words = card.nameOnCard.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
    const hasExpiry = card.expMonth !== "" && card.expYear !== "";
    return fields.map((f, i) => {
      const role = roles[i];
      let v: string | null = null;
      if (role === "number") v = card.number;
      else if (role === "name") v = card.nameOnCard;
      else if (role === "givenName") v = words[0] ?? "";
      else if (role === "familyName") v = words.slice(1).join(" ");
      else if (role === "exp") v = hasExpiry ? expiryFor(f.facts, card.expMonth, card.expYear) : "";
      else if (role === "expMonth") v = card.expMonth;
      else if (role === "expYear") v = card.expYear ? (f.facts.tag === "SELECT" ? card.expYear : yearFor(f.facts, card.expYear)) : "";
      else if (role === "csc") v = /^\d{3,4}$/.test(cvv) ? cvv : "";
      if (v === null || v === "") return null;
      return f.anchor || f.value.trim() === "" ? v : null;
    });
  };

  /** The value of the select option for a month ("08") or a year ("2028"), or null. */
  const matchCardOption = (options: readonly { value: string; text: string }[], wanted: string): string | null => {
    const w = foldText(wanted);
    if (!/^\d{1,4}$/.test(w)) return null;
    const candidates: string[] = [];
    if (w.length === 4) candidates.push(w, w.slice(-2));
    else {
      const n = Number(w);
      if (n < 1 || n > 12) return null;
      const en = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
      const es = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
      const nameEn = en[n - 1]!;
      const nameEs = es[n - 1]!;
      candidates.push(String(n).padStart(2, "0"), String(n), nameEn, nameEs, nameEn.slice(0, 3), nameEs.slice(0, 3));
    }
    const folded = options.map((o) => ({ value: o.value, v: foldText(o.value), t: foldText(o.text) }));
    const starts = (text: string, c: string): boolean => text.startsWith(c) && !/[0-9a-z]/.test(text.charAt(c.length));
    for (const test of [(o: { v: string; t: string }, c: string) => o.v === c, (o: { v: string; t: string }, c: string) => o.t === c, (o: { v: string; t: string }, c: string) => o.t !== "" && starts(o.t, c)]) {
      for (const c of candidates) {
        const hit = folded.find((o) => test(o, c));
        if (hit) return hit.value;
      }
    }
    return null;
  };

  return { cardFieldFacts, classifyCardField, isCardForm, planCardFill, matchCardOption };
}

export const { cardFieldFacts, classifyCardField, isCardForm, planCardFill, matchCardOption } = cardKit();
