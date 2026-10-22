/**
 * Which agent actions spend money. Pure (no DOM, no Node) so the desktop app and the MCP server
 * share one rule set, unit tested with a table of real shop labels.
 *
 * A spending action always asks the person, whatever "Ask before risky actions" says, and for MCP
 * clients at every access level. The rules lean on exact phrases and on the element role, so a link
 * to "Books", "Order history" or "Payment methods" is not a purchase, and "Add to cart" is not one
 * either (it stays under the normal risky rules).
 *
 * How a label is read (after lowercasing and trimming icons and punctuation):
 * - strong phrases ("buy now", "place order", "finalizar compra", "kinnita tellimus") spend on a
 *   button anywhere in the label, and on a link when the label starts with them;
 * - a spend verb followed by an amount ("Pay €12.99", "Osta 12 €") spends on a button or a link;
 * - on a button (any role but a link or a form field), a label that starts with a spend verb
 *   ("Buy", "Pay with card", "Comprar", "Maksa", "Checkout") spends, with per-verb rules for what may
 *   follow so nouns like "Order history", "Book club" or "Pay slips" do not;
 * - "Subscribe" spends only with a price, a paid-plan word or on a checkout or payment page, so a
 *   newsletter signup does not;
 * - generic commit verbs ("Confirm", "Submit", "Kinnita") spend on a checkout or payment page.
 */

/** The page and form around an element, as far as the spend rules need them. */
export interface SpendForm {
  /** The form's action URL. */
  action?: string;
  /** Accessible name of the form's default submit button (what pressing Enter clicks). */
  submitName?: string;
  /** Its role, as page_snapshot computes roles ("button" for a submit input). */
  submitRole?: string;
}

export interface SpendContext {
  /** Role as page_snapshot computes it ("button", "link", ...). Empty means unknown: read like a button. */
  role?: string;
  /** URL of the page the action happens on. */
  url?: string;
  /** The form the element belongs to, when it is in one. */
  form?: SpendForm;
}

const WORD = String.raw`\p{L}\p{N}`;
/** Start and end of a word, Unicode aware (\b only knows ASCII, so it breaks on "ó" or "ä"). */
const S = `(?<![${WORD}])`;
const E = `(?![${WORD}])`;
const SEP = String.raw`[\s:,\-]+`;

const alt = (parts: readonly string[]): string => `(?:${parts.join("|")})`;
const rx = (source: string): RegExp => new RegExp(source, "u");

const CUR_SYM = "[$€£¥₹₽]";
const CUR_CODE = alt(["eur", "usd", "gbp", "sek", "nok", "dkk", "pln", "chf", "kr", "zł", "zl", "руб", "rub"]);
/** An amount of money: "$9.99", "€ 12", "12,99 €", "199 kr", "12.99 EUR". */
const MONEY = String.raw`(?:${CUR_SYM}\s?\d+|\d(?:[\d.,\s]*\d)?\s?(?:${CUR_SYM}|${CUR_CODE}${E}))`;
const MONEY_RE = rx(MONEY);

/** A billing period ("/mo", "per month", "al mes", "kuus"): only paid plans have one. */
const PERIOD_RE = rx(
  String.raw`(?:/\s?(?:mo|month|yr|year|wk|week|kuu|mes|año|monat|jahr|mois|an|mese|anno|maand|jaar|månad|år|mies|rok|мес)${E}|${S}(?:per|a) (?:month|year|week)${E}|${S}(?:monthly|yearly|annually|al mes|al año|kuus|aastas|pro monat|im monat|jährlich|monatlich|par mois|par an|al mese|all'anno|per maand|per jaar|i månaden|per år|miesięcznie|rocznie|в месяц|в год)${E})`,
);

/** Words that make "Subscribe" a paid plan. */
const PAID_PLAN_RE = rx(
  `${S}${alt(["premium", "pro", "plus", "paid", "plan", "membership", "annual", "monthly", "yearly", "vip", "gold", "unlimited", "subscription", "suscripción", "suscripcion", "tellimus", "mitgliedschaft", "abonnement", "abbonamento", "assinatura"])}${E}`,
);

/** Mailing-list signups are never purchases, whatever verb they use. */
const NEWSLETTER_RE = rx(
  alt(["newsletter", "news letter", "boletín", "boletin", "uudiskiri", "uudiskirja", "infokiri", "nyhetsbrev", "nieuwsbrief", "uutiskirje", "biuletyn", "рассылк", "mailing list", "lista de correo"]),
);

/** "Add to cart" and friends: risky by the normal rules, never a spend. */
const ADD_VERBS = ["add", "añadir", "anadir", "añade", "anade", "agregar", "agrega", "lisa", "ajouter", "ajoute", "aggiungi", "adicionar", "adicione", "toevoegen", "voeg", "lägg", "dodaj", "добавить", "lisää", "hinzufügen", "legen"];
const CART_WORDS = [
  "cart", "bag", "basket", "trolley", "wish ?list", "favou?rites?", "list", "registry",
  "carrito", "cesta", "bolsa", "ostukorvi", "korvi", "soovinimekirja", "warenkorb", "merkzettel", "wunschliste",
  "panier", "carrello", "carrinho", "winkelwagen", "winkelmand", "varukorg", "varukorgen", "koszyka", "корзину", "ostoskoriin", "ostoskori",
];
const ADD_TO_CART_RE = rx(`^${alt(ADD_VERBS)}${E}.*${S}${alt(CART_WORDS)}${E}`);
const TO_CART_RE = rx(`^${alt(["in den warenkorb", "in winkelwagen", "in de winkelwagen", "в корзину", "do koszyka", "ostukorvi", "i varukorgen", "ostoskoriin", "au panier", "al carrito", "a la cesta", "al carrello", "ao carrinho", "no carrinho"])}${E}`);

/**
 * Phrases that spend wherever they are on a button, and at the start of a link. Kept to decisive
 * wording: the last click of a checkout, not the way there.
 */
const STRONG = [
  // English
  String.raw`buy (?:it |them |this |one )?now`,
  String.raw`buy with 1-click`,
  String.raw`1-click (?:buy|purchase|order|checkout)`,
  String.raw`pay (?:now|securely|today)`,
  String.raw`pay and (?:confirm|order|subscribe|book|finish|complete|place order)`,
  String.raw`(?:place|submit|complete|confirm|finali[sz]e|finish) (?:my |your |the |this )?(?:order|purchase|payment|booking|reservation|donation|transfer)`,
  String.raw`confirm (?:and|&) pay`,
  String.raw`make (?:a |the |my )?(?:payment|donation|purchase)`,
  String.raw`send (?:money|payment|funds|a tip)`,
  String.raw`transfer (?:money|funds)`,
  String.raw`(?:order|book|reserve|donate|rent|pre-?order) now`,
  String.raw`(?:order|book|reserve|subscribe) (?:and|&) pay`,
  String.raw`start (?:my |your |the )?paid (?:subscription|membership|plan)`,
  // Spanish
  String.raw`(?:comprar|compra|cómpralo|compralo|pagar|paga|pedir|pide|reservar|reserva|donar|dona) (?:ahora|ya)`,
  String.raw`(?:finalizar|completar|confirmar|realizar|tramitar|hacer|efectuar|procesar|enviar) (?:la |el |mi |tu |su )?(?:compra|pedido|pago|reserva|donación|donacion|transferencia)`,
  String.raw`(?:confirmar|finalizar) y pagar`,
  String.raw`pagar y (?:confirmar|finalizar|pedir|reservar)`,
  String.raw`enviar dinero`,
  // Estonian
  String.raw`(?:osta|maksa|telli|tasu|broneeri|anneta|rendi) kohe`,
  String.raw`(?:kinnita|vormista|esita|lõpeta|lopeta) (?:oma )?(?:tellimus|tellimuse|ost|ostu|makse|maksmine|broneering|annetus)`,
  String.raw`(?:kinnita|telli|broneeri) ja maksa`,
  String.raw`maksa ja (?:kinnita|telli|broneeri)`,
  String.raw`saada raha`,
  String.raw`kanna (?:raha )?üle`,
  // German
  String.raw`jetzt (?:kaufen|bezahlen|bestellen|buchen|spenden|mieten)`,
  String.raw`(?:zahlungspflichtig|kostenpflichtig) (?:bestellen|buchen|kaufen|abonnieren|abschließen|abschliessen)`,
  String.raw`(?:bestellung|kauf|zahlung|buchung) (?:abschließen|abschliessen|bestätigen|bestaetigen|absenden)`,
  // French
  String.raw`(?:acheter|payer|commander|réserver|reserver|louer) maintenant`,
  String.raw`(?:passer|valider|confirmer|finaliser) (?:la |ma |votre )?commande`,
  String.raw`(?:confirmer|valider) (?:le |mon |votre )?(?:paiement|achat)`,
  String.raw`(?:confirmer|valider) et payer`,
  String.raw`payer et commander`,
  String.raw`faire un don`,
  // Italian
  String.raw`(?:acquista|compra|paga|ordina|prenota|dona|noleggia) ora`,
  String.raw`(?:conferma|completa|invia) (?:l'|il |la |lo )?(?:ordine|acquisto|pagamento|prenotazione)`,
  String.raw`conferma e paga`,
  // Portuguese
  String.raw`(?:comprar|pagar|reservar|alugar) agora`,
  String.raw`(?:finalizar|confirmar|concluir|fazer|fechar) (?:a |o |meu |minha )?(?:compra|pedido|pagamento|reserva|encomenda)`,
  // Dutch
  String.raw`(?:nu|direct) (?:kopen|betalen|bestellen|boeken|reserveren|doneren|huren)`,
  String.raw`(?:koop|betaal|bestel|boek|reserveer|doneer|huur) (?:nu|direct)`,
  String.raw`(?:bestelling|betaling|aankoop|boeking) (?:plaatsen|bevestigen|afronden|voltooien)`,
  String.raw`plaats (?:je |uw )?bestelling`,
  String.raw`bestellen en betalen`,
  // Finnish
  String.raw`(?:osta|maksa|tilaa|varaa|lahjoita) nyt`,
  String.raw`(?:vahvista|lähetä|tee) (?:tilaus|maksu|osto|varaus)`,
  // Swedish
  String.raw`(?:köp|betala|beställ|boka|donera|hyr) nu`,
  String.raw`(?:slutför|bekräfta|genomför) (?:köp|köpet|beställning|beställningen|betalning|betalningen|bokning|bokningen)`,
  String.raw`lägg (?:din )?beställning`,
  // Polish
  String.raw`(?:kup|zapłać|zaplac|zamów|zamow|zarezerwuj) teraz`,
  String.raw`(?:zamawiam|kupuję|kupuje) i (?:płacę|place)`,
  String.raw`złóż zamówienie`,
  String.raw`(?:potwierdź|potwierdz) (?:zamówienie|płatność|zakup)`,
  // Russian
  String.raw`(?:купить|оплатить|заказать) сейчас`,
  String.raw`оформить (?:заказ|подписку)`,
  String.raw`(?:подтвердить|оплатить) (?:заказ|оплату|покупку|платёж|платеж)`,
  String.raw`купить в (?:один|1) клик`,
];
const STRONG_ANYWHERE_RE = rx(`${S}${alt(STRONG)}${E}`);
const STRONG_AT_START_RE = rx(`^${alt(STRONG)}${E}`);

/** Purchase nouns that may follow "Book" / "Reserve" (and their translations). */
const BOOKABLE = [
  "now", "it", "this", "today",
  String.raw`(?:a |an |the |your |my |this )?(?:room|rooms|flight|flights|ticket|tickets|stay|trip|hotel|car|seat|seats|tour|cruise|holiday|vacation|package|night|nights)`,
];

interface VerbRule {
  /** The verb or verb phrase, as the first word(s) of the label. */
  verbs: readonly string[];
  /** Anything may follow except these nouns ("Order history"). */
  not?: readonly string[];
  /** Only these may follow (or nothing, or an amount): "Order now", "Book a room". */
  allow?: readonly string[];
}

/** Spend verbs that count as the first word of a button (not a link). */
const VERB_RULES: readonly VerbRule[] = [
  // English
  { verbs: ["buy"] },
  { verbs: ["purchase"], not: ["history", "details", "summary", "receipts?", "records?", "protection", "options", "orders?", "terms", "info"] },
  { verbs: ["pay"], not: ["slips?", "stubs?", "history", "periods?", "rates?", "grades?", "settings", "methods?", "options", "information", "info", "details", "statements?", "dates?", "schedule", "calculator", "scales?", "gap"] },
  { verbs: ["checkout"], not: ["faq", "help", "guide", "policy"] },
  { verbs: ["check out"], allow: ["now", "securely", "with", "as guest"] },
  { verbs: ["donate", "pre-?order", "top up", "top-up", "add (?:funds|money|credit)", "recharge"] },
  { verbs: ["order"], allow: ["now", "today", "it", "this", "online", "(?:and|&) pay", "for (?:delivery|pickup|collection)"] },
  { verbs: ["book", "reserve"], allow: BOOKABLE },
  { verbs: ["rent"], allow: ["now", "it", "this", "for"] },
  { verbs: ["upgrade"], allow: ["now", "to", "plan", "my plan", "your plan", "account", "subscription", "membership"] },
  { verbs: ["renew"], allow: ["now", "subscription", "membership", "plan", "license", "licence"] },
  { verbs: ["transfer"], allow: ["now", "money", "funds", "to"] },
  { verbs: ["proceed to (?:checkout|payment|pay)", "continue to (?:checkout|payment|pay)", "go to (?:checkout|payment)"] },
  // Spanish
  { verbs: ["comprar", "cómpralo", "compralo", "pagar", "pague", "págalo", "pagalo", "contratar", "contrata", "donar"] },
  { verbs: ["pedir"], allow: ["ahora", "ya"] },
  { verbs: ["reservar"], allow: ["ahora", "ya", String.raw`(?:la |el |una |un |tu |mi )?(?:habitación|habitacion|habitaciones|vuelo|vuelos|billete|billetes|entrada|entradas|viaje|hotel|coche|plaza|plazas|asiento|asientos|noche|noches)`] },
  { verbs: ["alquilar"], allow: ["ahora", "ya", "por"] },
  { verbs: ["transferir"], allow: ["ahora", "dinero", "fondos", "a"] },
  { verbs: ["renovar"], allow: ["ahora", "suscripción", "suscripcion", "plan", "membresía", "membresia", "licencia"] },
  { verbs: ["ir a pagar", "ir al pago", "proceder al pago", "continuar al pago", "continuar con el pago", "ir a caja", "tramitar"] },
  // Estonian
  { verbs: ["osta", "maksa", "maksma", "anneta"] },
  { verbs: ["tasu"], allow: ["kohe", "arve", "arved"] },
  { verbs: ["telli"], allow: ["kohe", "ja maksa"] },
  { verbs: ["broneeri"], allow: ["kohe", "tuba", "toad", "lend", "lennud", "pilet", "piletid", "reis", "hotell", "auto", "koht", "kohad"] },
  { verbs: ["rendi"], allow: ["kohe"] },
  { verbs: ["kassasse", "mine kassasse", "edasi kassasse", "mine maksma", "edasi maksma", "liigu maksma", "vormista ost"] },
  // German
  { verbs: ["kaufen", "bezahlen", "spenden", "zur kasse", "weiter zur kasse", "zur zahlung", "weiter zur zahlung"] },
  { verbs: ["bestellen", "buchen", "mieten"], allow: ["jetzt"] },
  // French
  { verbs: ["acheter", "payer", "passer à la caisse", "aller à la caisse", "aller au paiement", "procéder au paiement", "continuer vers le paiement"] },
  { verbs: ["commander", "réserver", "reserver", "louer"], allow: ["maintenant"] },
  // Italian
  { verbs: ["acquista", "compra", "paga", "procedi al pagamento", "procedi all'acquisto", "vai alla cassa", "vai al pagamento"] },
  { verbs: ["ordina", "prenota", "noleggia", "dona"], allow: ["ora", "subito"] },
  // Portuguese
  { verbs: ["doar", "ir para o pagamento"] },
  { verbs: ["alugar"], allow: ["agora"] },
  // Dutch
  { verbs: ["kopen", "koop", "betalen", "betaal", "doneren", "doneer", "afrekenen", "naar de kassa", "verder naar betalen", "doorgaan naar betalen"] },
  { verbs: ["bestellen", "bestel", "boeken", "boek", "reserveren", "reserveer", "huren", "huur"], allow: ["nu", "direct"] },
  // Finnish
  { verbs: ["lahjoita", "kassalle", "siirry kassalle", "siirry maksamaan", "maksamaan"] },
  { verbs: ["tilaa", "varaa"], allow: ["nyt"] },
  // Swedish
  { verbs: ["köp", "betala", "donera", "till kassan", "gå till kassan"] },
  { verbs: ["beställ", "boka", "hyr"], allow: ["nu"] },
  // Polish
  { verbs: ["kup", "zapłać", "zaplac", "wpłać", "wplac", "do kasy", "przejdź do kasy", "przejdź do płatności"] },
  { verbs: ["zamów", "zamow", "zarezerwuj"], allow: ["teraz"] },
  // Russian
  { verbs: ["купить", "оплатить", "пожертвовать", "перейти к оплате", "перейти к оформлению", "к оплате"] },
  { verbs: ["заказать", "забронировать", "арендовать"], allow: ["сейчас"] },
];

function verbRuleRe(rule: VerbRule): RegExp {
  const verb = alt(rule.verbs);
  if (rule.allow) {
    const next = `(?:${alt(rule.allow)}${E}|${MONEY}|\\()`;
    return rx(`^${verb}(?:$|${SEP}${next})`);
  }
  const not = rule.not?.length ? `(?!${SEP}${alt(rule.not)}${E})` : "";
  return rx(`^${verb}${E}${not}`);
}
const VERB_RES = VERB_RULES.map(verbRuleRe);

/** A spend verb followed straight by an amount ("Pay €12.99", "Rent for $3.99", "Osta 12 €"). */
const VERB_MONEY_RE = rx(
  `^${alt(VERB_RULES.flatMap((r) => r.verbs))}${SEP}(?:${alt(["for", "por", "für", "pour", "per", "voor", "för", "za", "за", "eest", "hintaan"])}\\s+)?${MONEY}`,
);

/** Verbs that only spend with an amount on the button ("Unlock for $2.99", "Continue - pay €20"). */
const MONEY_ONLY_RE = rx(`^${alt(["tip", "get", "unlock", "join", "start", "continue", "proceed", "confirm", "submit", "complete", "obtener", "consigue", "desbloquear", "continuar", "jätka", "jatka", "weiter", "continuer", "continua", "doorgaan", "fortsätt", "dalej", "продолжить"])}${E}.*${MONEY}`);

/** Subscribe-like verbs: a spend only with a price, a paid-plan word, or on a payment page. */
const SUBSCRIBE_RE = rx(
  `^${alt(["subscribe", "suscribirse", "suscribirme", "suscríbete", "suscribete", "suscribir", "abonarse", "abonnieren", "s'abonner", "abonnez-vous", "je m'abonne", "abbonati", "assinar", "assine", "abonneren", "abonneer", "prenumerera", "subskrybuj", "zasubskrybuj", "подписаться", "liitu", "join"])}${E}`,
);

/** Generic "commit" verbs: a spend on a checkout or payment page. */
const COMMIT_VERBS = [
  "confirm", "submit", "complete", "finish", "finali[sz]e", "place", "authori[sz]e", "approve",
  "confirmar", "finalizar", "completar", "realizar", "tramitar", "enviar",
  "kinnita", "vormista", "esita", "saada", "lõpeta", "lopeta",
  "bestätigen", "bestaetigen", "abschließen", "abschliessen", "absenden",
  "confirmer", "valider", "finaliser",
  "conferma", "completa", "invia", "concluir",
  "bevestigen", "afronden", "voltooien",
  "vahvista", "lähetä",
  "bekräfta", "slutför", "genomför",
  "potwierdź", "potwierdz", "zatwierdź", "zatwierdz",
  "подтвердить", "оформить",
];
/** What a commit verb confirms that is not the payment itself ("Confirm address"). */
const COMMIT_NOT = [
  "address(?:es)?", "e-?mail", "shipping", "delivery", "details", "information", "info", "cart", "basket", "bag", "code", "coupon", "promo", "voucher", "discount", "password", "account",
  "dirección", "direccion", "envío", "envio", "correo", "cupón", "cupon", "código", "codigo", "contraseña",
  "aadress", "tarne", "kood", "kupong", "e-post", "parool",
  "adresse", "lieferung", "versand", "gutschein", "passwort", "livraison", "indirizzo", "spedizione", "endereço", "entrega",
  "adres", "levering", "toimitus", "osoite", "leverans", "adress", "dostawa", "адрес", "доставк\\p{L}*",
];
const COMMIT_RE = rx(
  `^${alt(COMMIT_VERBS)}${E}(?!${SEP}(?:${alt(["my", "your", "the", "tu", "su", "la", "el", "mi", "oma", "ihre", "votre", "il", "o", "a", "je", "uw", "din"])}\\s+)?${alt(COMMIT_NOT)}${E})`,
);

/** Roles that are fields or structure, never the click that pays. */
const NOT_ACTIONABLE = new Set([
  "textbox", "searchbox", "combobox", "checkbox", "radio", "slider", "spinbutton", "switch", "option", "listbox",
  "tab", "tablist", "heading", "img", "image", "separator", "progressbar", "status", "alert", "dialog", "navigation",
  "main", "article", "region", "textarea", "select",
]);

/** Checkout and payment pages (path segments or host labels), in the languages above. */
const SPEND_URL_WORDS = [
  "checkout", "checkouts", "checkoutnow", "check-out", "payment", "payments", "pay", "billing", "purchase", "place-?order", "donate", "donation",
  "pago", "pagos", "pagar", "finalizar-compra", "tramitar-pedido",
  "kassa", "kassasse", "maksa", "maksmine", "makse",
  "kasse", "zahlung", "bezahlen",
  "paiement", "afrekenen", "betalen", "betaling", "pagamento", "cassa", "kassan", "betalning", "platnosc", "platnosci", "oplata",
];
const SPEND_URL_RE = new RegExp(`(?:^|[/.\\-_?=&#])${alt(SPEND_URL_WORDS)}(?=$|[/.\\-_?=&#])`, "i");

/** Lowercase, collapse spaces and drop leading/trailing icons and punctuation. */
export function normalizeSpendLabel(name: string): string {
  return name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‘’ʼ´`]/g, "'")
    .replace(/[‐-―−]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^[^\p{L}\p{N}$€£¥₹₽]+/u, "")
    .replace(/[^\p{L}\p{N}$€£¥₹₽)]+$/u, "")
    .trim()
    .slice(0, 160);
}

/** A checkout or payment page (or a form that posts to one). */
export function isSpendUrl(url: string | undefined): boolean {
  if (!url) return false;
  let target = url;
  try {
    const u = new URL(url);
    target = `${u.host}${u.pathname}${u.search}${u.hash}`;
  } catch {
    // Not absolute: test it as given.
  }
  return SPEND_URL_RE.test(target.toLowerCase());
}

/** Whether clicking an element with this accessible name spends money. */
export function isSpendClick(name: string, ctx: SpendContext = {}): boolean {
  const role = (ctx.role ?? "").toLowerCase();
  if (NOT_ACTIONABLE.has(role)) return false;
  const n = normalizeSpendLabel(name);
  if (!n) return false;
  if (ADD_TO_CART_RE.test(n) || TO_CART_RE.test(n) || NEWSLETTER_RE.test(n)) return false;

  const isLink = role === "link";
  if ((isLink ? STRONG_AT_START_RE : STRONG_ANYWHERE_RE).test(n)) return true;
  if (VERB_MONEY_RE.test(n)) return true;
  if (isLink) return false;

  if (VERB_RES.some((re) => re.test(n))) return true;
  if (MONEY_ONLY_RE.test(n)) return true;
  const onPaymentPage = isSpendUrl(ctx.url) || isSpendUrl(ctx.form?.action);
  if (SUBSCRIBE_RE.test(n) && (MONEY_RE.test(n) || PERIOD_RE.test(n) || PAID_PLAN_RE.test(n) || onPaymentPage)) return true;
  return onPaymentPage && COMMIT_RE.test(n);
}

/**
 * Whether submitting a form (Enter in a field, or `type` with submit) spends money: the page or the
 * form's action is a checkout or payment URL, or the form's default submit button is a spend button.
 */
export function isSpendSubmit(ctx: SpendContext = {}): boolean {
  if (isSpendUrl(ctx.url) || isSpendUrl(ctx.form?.action)) return true;
  const submit = ctx.form?.submitName;
  return Boolean(submit) && isSpendClick(submit!, { role: ctx.form?.submitRole || "button", ...(ctx.url ? { url: ctx.url } : {}) });
}

/** Host of a URL for prompts ("shop.example"), or "" when it has none. */
export function spendHost(url: string | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

/** Human description of a spend, for prompts: `Click "Place order" on shop.example`. */
export function describeSpend(action: { kind: "click" | "submit"; name?: string; submitName?: string; url?: string }): string {
  const host = spendHost(action.url);
  const where = host ? ` on ${host}` : "";
  const clip = (s: string): string => (s.length > 80 ? `${s.slice(0, 77)}...` : s);
  if (action.kind === "click") return `Click "${clip(action.name || "a button")}"${where}`;
  if (action.submitName) return `Submit "${clip(action.submitName)}"${where}`;
  return `Submit a checkout or payment form${where}`;
}
