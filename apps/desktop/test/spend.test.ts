import { describe, expect, it } from "vitest";
import { describeSpend, isSpendClick, isSpendConfirm, isSpendSubmit, isSpendUrl, normalizeSpendLabel } from "@corvus/shared";
import { classifyAction, stricterRisk } from "../src/shared/agent-safety";

const PRODUCT = "https://shop.example/product/42";
const CHECKOUT = "https://shop.example/checkout/payment";

/** [label, role, spends?, page URL (default: a product page)] */
type Row = [string, string, boolean, string?];

const ENGLISH: Row[] = [
  ["Buy now", "button", true],
  ["Buy Now", "link", true],
  ["Buy", "button", true],
  ["Buy it now", "button", true],
  ["→ Buy now", "button", true],
  ["Buy now – €49.00", "button", true],
  ["Place order", "button", true],
  ["Place your order", "button", true],
  ["Pay", "button", true],
  ["Pay $12.99", "button", true],
  ["Pay now", "link", true],
  ["Pay with card", "button", true],
  ["Checkout", "button", true],
  ["Check out", "button", true],
  ["Proceed to checkout", "button", true],
  ["Purchase", "button", true],
  ["Complete purchase", "button", true],
  ["Complete order", "button", true],
  ["Confirm payment", "button", true],
  ["Confirm and pay", "button", true],
  ["Order now", "button", true],
  ["Pre-order", "button", true],
  ["Subscribe for $9.99/month", "button", true],
  ["Subscribe", "button", true, CHECKOUT],
  ["Upgrade to Pro", "button", true],
  ["Upgrade", "button", true],
  ["Start my paid subscription", "button", true],
  ["Donate", "button", true],
  ["Donate $25", "button", true],
  ["Send money", "button", true],
  ["Transfer funds", "button", true],
  ["Tip $5", "button", true],
  ["Book now", "button", true],
  ["Book this room", "button", true],
  ["Reserve", "button", true],
  ["Rent for $3.99", "link", true],
  ["Confirm", "button", true, CHECKOUT],
  ["Submit", "button", true, CHECKOUT],
  ["Books", "link", false],
  ["Books", "button", false],
  ["Order history", "link", false],
  ["Order history", "button", false],
  ["Order status", "button", false],
  ["Orders", "button", false],
  ["Track order", "button", false],
  ["Payment methods", "link", false],
  ["Payment methods", "button", false],
  ["Add payment method", "button", false],
  ["Add to cart", "button", false],
  ["Add to bag", "button", false],
  ["Add to basket", "button", false],
  ["Subscribe", "button", false],
  ["Subscribe", "link", false],
  ["Subscribe to our newsletter", "button", false],
  ["Confirm subscription", "button", false],
  ["Book club", "button", false],
  ["Book a demo", "button", false],
  ["Booking history", "button", false],
  ["Buy", "link", false],
  ["Checkout", "link", false],
  ["Buyer protection", "link", false],
  ["Purchase history", "button", false],
  ["Pay slips", "button", false],
  ["Paypal", "button", false],
  ["Reserve with Google", "button", false],
  ["Send", "button", false],
  ["Transfer files", "button", false],
  ["Get 20% off", "button", false],
  ["Upgrade browser", "button", false],
  ["Confirm", "button", false],
  ["Confirm address", "button", false, CHECKOUT],
  ["Continue", "button", false, CHECKOUT],
  ["Apply", "button", false, CHECKOUT],
  ["Search", "button", false],
  ["Read more", "link", false],
  ["Sign in", "button", false],
  ["Buy now", "textbox", false],
  ["Pay with card", "radio", false],
];

const SPANISH: Row[] = [
  ["Comprar", "button", true],
  ["Comprar ahora", "link", true],
  ["Pagar", "button", true],
  ["Pagar 12,99 €", "button", true],
  ["Finalizar compra", "button", true],
  ["Finalizar compra", "link", true],
  ["Realizar pedido", "button", true],
  ["Tramitar pedido", "button", true],
  ["Hacer pedido", "button", true],
  ["Confirmar pago", "button", true],
  ["Suscribirse por 4,99 €/mes", "button", true],
  ["Donar", "button", true],
  ["Reservar ahora", "button", true],
  ["Contratar", "button", true],
  ["Ir a pagar", "button", true],
  ["Confirmar", "button", true, "https://tienda.example/pago"],
  ["Añadir al carrito", "button", false],
  ["Agregar al carrito", "button", false],
  ["Añadir a la cesta", "button", false],
  ["Mis pedidos", "link", false],
  ["Pedidos", "button", false],
  ["Historial de pedidos", "button", false],
  ["Métodos de pago", "link", false],
  ["Formas de pago", "button", false],
  ["Suscribirse", "button", false],
  ["Suscríbete al boletín", "button", false],
  ["Seguir comprando", "button", false],
  ["Libros", "link", false],
  ["Pedir cita", "button", false],
  ["Reservar cita", "button", false],
  ["Comprar", "link", false],
];

const ESTONIAN: Row[] = [
  ["Osta", "button", true],
  ["Osta kohe", "link", true],
  ["Maksa", "button", true],
  ["Maksa 12,99 €", "button", true],
  ["Telli", "button", true],
  ["Telli kohe", "button", true],
  ["Kinnita tellimus", "button", true],
  ["Vormista tellimus", "button", true],
  ["Kinnita makse", "button", true],
  ["Anneta", "button", true],
  ["Broneeri kohe", "button", true],
  ["Mine kassasse", "button", true],
  ["Kinnita", "button", true, "https://pood.example/kassa"],
  ["Lisa ostukorvi", "button", false],
  ["Ostukorv", "button", false],
  ["Ostukorvi", "button", false],
  ["Ostud", "button", false],
  ["Tellimused", "link", false],
  ["Tellimuste ajalugu", "button", false],
  ["Maksevõimalused", "button", false],
  ["Telli uudiskiri", "button", false],
  ["Ostutingimused", "link", false],
  ["Raamatud", "link", false],
  ["Osta", "link", false],
  ["Kinnita", "button", false],
];

const OTHER: Row[] = [
  ["Jetzt kaufen", "button", true],
  ["Zahlungspflichtig bestellen", "button", true],
  ["In den Warenkorb", "button", false],
  ["Bestellungen", "link", false],
  ["Passer la commande", "button", true],
  ["Ajouter au panier", "button", false],
  ["Acquista ora", "button", true],
  ["Aggiungi al carrello", "button", false],
  ["Finalizar pedido", "button", true],
  ["Afrekenen", "button", true],
  ["In winkelwagen", "button", false],
  ["Köp nu", "button", true],
  ["Lägg i varukorgen", "button", false],
  ["Osta nyt", "button", true],
  ["Lisää ostoskoriin", "button", false],
  ["Kup teraz", "button", true],
  ["Dodaj do koszyka", "button", false],
  ["Оформить заказ", "button", true],
  ["Добавить в корзину", "button", false],
];

describe.each([
  ["English", ENGLISH],
  ["Spanish", SPANISH],
  ["Estonian", ESTONIAN],
  ["other languages", OTHER],
])("isSpendClick: %s", (_lang, rows) => {
  it.each(rows)("%s (%s) spends: %s", (label, role, spends, url) => {
    expect(isSpendClick(label, { role, url: url ?? PRODUCT })).toBe(spends);
  });
});

describe("isSpendClick edge cases", () => {
  it("reads an unknown role like a button (never weaker)", () => {
    expect(isSpendClick("Buy", {})).toBe(true);
    expect(isSpendClick("Books", {})).toBe(false);
  });

  it("ignores empty labels", () => {
    expect(isSpendClick("", { role: "button" })).toBe(false);
    expect(isSpendClick("  →  ", { role: "button" })).toBe(false);
  });

  it("counts a commit verb on a button whose form posts to a payment URL", () => {
    expect(isSpendClick("Confirm", { role: "button", url: PRODUCT, form: { action: "https://shop.example/checkout/complete" } })).toBe(true);
  });

  it("normalizes case, icons and trailing punctuation", () => {
    expect(normalizeSpendLabel("  🛒  BUY NOW!  ")).toBe("buy now");
  });
});

describe("isSpendUrl", () => {
  it.each([
    ["https://shop.example/checkout", true],
    ["https://shop.example/checkout/payment?step=2", true],
    ["https://checkout.stripe.com/c/pay/cs_test", true],
    ["https://pay.google.com/x", true],
    ["https://www.paypal.com/checkoutnow?token=1", true],
    ["https://tienda.example/finalizar-compra", true],
    ["https://pood.example/kassa", true],
    ["https://shop.example/product/42", false],
    ["https://shop.example/account/login", false],
    ["https://www.paypal.com/myaccount/summary", false],
    ["https://example.com/blog/paying-it-forward", false],
    ["", false],
  ])("%s -> %s", (url, spends) => {
    expect(isSpendUrl(url)).toBe(spends);
  });
});

describe("isSpendSubmit", () => {
  it("is a spend on a checkout or payment page", () => {
    expect(isSpendSubmit({ url: CHECKOUT })).toBe(true);
    expect(isSpendSubmit({ url: "https://pood.example/kassa" })).toBe(true);
  });

  it("is a spend when the form's default button spends, or the form posts to a payment URL", () => {
    expect(isSpendSubmit({ url: PRODUCT, form: { submitName: "Place order", submitRole: "button" } })).toBe(true);
    expect(isSpendSubmit({ url: PRODUCT, form: { submitName: "Realizar pedido" } })).toBe(true);
    expect(isSpendSubmit({ url: PRODUCT, form: { action: "https://shop.example/checkout/complete", submitName: "Continue" } })).toBe(true);
  });

  it("is not a spend for a search or sign-in form", () => {
    expect(isSpendSubmit({ url: PRODUCT })).toBe(false);
    expect(isSpendSubmit({ url: PRODUCT, form: { submitName: "Search", action: "https://shop.example/search" } })).toBe(false);
    expect(isSpendSubmit({ url: "https://shop.example/account/login", form: { submitName: "Sign in" } })).toBe(false);
  });
});

describe("isSpendConfirm", () => {
  it("asks about questions that name money or a purchase", () => {
    for (const q of ["Buy 2 tickets for $84?", "Place your order now?", "Confirm payment of 12,99 €", "Do you want to subscribe to Pro?", "¿Quieres comprar este artículo?", "Kas soovid tellimuse kinnitada? Telli kohe"]) {
      expect(isSpendConfirm(q, PRODUCT), q).toBe(true);
    }
  });

  it("asks about any question on a checkout or payment page", () => {
    expect(isSpendConfirm("Are you sure?", CHECKOUT)).toBe(true);
  });

  it("leaves ordinary questions alone", () => {
    for (const q of ["Leave this page? Changes you made may not be saved.", "Delete this comment?", "Remove 3 items from your list?", "¿Borrar esta nota?", "Kas oled kindel?"]) {
      expect(isSpendConfirm(q, PRODUCT), q).toBe(false);
    }
  });
});

describe("describeSpend", () => {
  it("names the action and the site for the dialog", () => {
    expect(describeSpend({ kind: "click", name: "Place order", url: "https://shop.example/checkout" })).toBe('Click "Place order" on shop.example');
    expect(describeSpend({ kind: "submit", submitName: "Pay now", url: "https://shop.example/x" })).toBe('Submit "Pay now" on shop.example');
    expect(describeSpend({ kind: "submit", url: "https://shop.example/checkout" })).toBe("Submit a checkout or payment form on shop.example");
  });
});

describe("classifyAction and spending", () => {
  it("always asks before a click that spends money", () => {
    const risk = classifyAction("click", { ref: "e1" }, "Buy now", { role: "button", url: PRODUCT });
    expect(risk).toMatchObject({ risky: true, handoff: false, alwaysAsk: true, spend: true });
    expect(risk.reason).toBe('Spends money: clicks "Buy now".');
  });

  it("catches spend words the old risky list did not know (Spanish, Estonian)", () => {
    expect(classifyAction("click", { ref: "e1" }, "Comprar", { role: "button" }).alwaysAsk).toBe(true);
    expect(classifyAction("click", { ref: "e1" }, "Kinnita tellimus", { role: "button" }).alwaysAsk).toBe(true);
  });

  it("keeps add to cart risky but not always-ask", () => {
    const risk = classifyAction("click", { ref: "e1" }, "Add to cart", { role: "button" });
    expect(risk.risky).toBe(true);
    expect(risk.alwaysAsk).toBeUndefined();
  });

  it("does not treat a Books or Order history link as a purchase", () => {
    expect(classifyAction("click", { ref: "e1" }, "Books", { role: "link" }).risky).toBe(false);
    const history = classifyAction("click", { ref: "e1" }, "Order history", { role: "link" });
    expect(history.alwaysAsk).toBeUndefined();
  });

  it("always asks before Enter in a checkout form, but not in a search form", () => {
    const checkout = classifyAction("type", { ref: "e2", text: "ACME", submit: true }, "Name on card holder", { url: CHECKOUT });
    expect(checkout).toMatchObject({ alwaysAsk: true, spend: true });
    expect(checkout.reason).toContain("Spends money");
    const viaButton = classifyAction("type", { ref: "e2", text: "x", submit: true }, "Promo code", { url: PRODUCT, form: { submitName: "Place order" } });
    expect(viaButton.reason).toBe('Spends money: presses Enter in "Promo code", which submits "Place order".');
    const search = classifyAction("type", { ref: "e2", text: "umbrella", submit: true }, "Search products", { url: PRODUCT, form: { submitName: "Search" } });
    expect(search).toMatchObject({ risky: true });
    expect(search.alwaysAsk).toBeUndefined();
  });

  it("still hands a card number field to the person (handoff beats always-ask)", () => {
    const risk = classifyAction("type", { ref: "e3", text: "4111", submit: true }, "Card number", { url: CHECKOUT });
    expect(risk.handoff).toBe(true);
  });

  it("keeps navigating to a checkout page risky, not always-ask", () => {
    const risk = classifyAction("navigate", { url: "https://shop.example/checkout" });
    expect(risk.risky).toBe(true);
    expect(risk.alwaysAsk).toBeUndefined();
  });

  it("stricterRisk prefers handoff, then always-ask, then risky", () => {
    const safe = { risky: false, handoff: false, reason: "" };
    const risky = { risky: true, handoff: false, reason: "r" };
    const spend = { risky: true, handoff: false, alwaysAsk: true, spend: true, reason: "s" };
    const handoff = { risky: true, handoff: true, reason: "h" };
    expect(stricterRisk(safe, spend)).toBe(spend);
    expect(stricterRisk(spend, risky)).toBe(spend);
    expect(stricterRisk(spend, handoff)).toBe(handoff);
    expect(stricterRisk(risky, safe)).toBe(risky);
  });
});
