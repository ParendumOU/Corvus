/**
 * Fields that take a payment card's data, whatever their type. The card detection (card-fields.ts)
 * skips password fields, but a card's security code box often is one: read as a login it would offer
 * to save (and sync) the CVV as a password. The tab preload uses these so a card field is never a
 * login's username or password, a card form never gives a login to save, and the workflow recorder
 * never records what a card field holds. Pure, unit tested.
 */
import { classifyCardField, isCardForm, type CardFieldFacts, type CardRole } from "./card-fields";

/** The card role of a field, a password field read as a text field. */
export function cardDataRole(f: CardFieldFacts): CardRole | null {
  return classifyCardField(f.tag === "INPUT" && f.type.toLowerCase() === "password" ? { ...f, type: "text" } : f);
}

/** The field takes card data: any `cc-` autocomplete token, or a card role from its words (English or Spanish). */
export function isCardDataField(f: CardFieldFacts): boolean {
  return f.autocomplete.toLowerCase().split(/\s+/).some((t) => t.startsWith("cc-")) || cardDataRole(f) !== null;
}

/** The fields make a card form (one of them takes the card number), password fields included. */
export function isCardDataForm(fields: readonly CardFieldFacts[]): boolean {
  return isCardForm(fields.map(cardDataRole));
}
