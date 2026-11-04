import type http from "node:http";
import type { WebContents, WebFrameMain } from "electron";
import { dropdownEntries } from "../shared/field-dropdown";
import type { AppContext } from "./context";
import { windowShot } from "./smoke-cert-errors";
import { dropdownDriver } from "./smoke-otp-fill";
import type { BrowserWindowCtl, TabRuntime } from "./window";

interface Helpers {
  /** The smoke server; its pages are also served for every host under corvus-smoke.test. */
  url: string;
  win: BrowserWindowCtl;
  check: (name: string, ok: boolean, detail?: unknown) => void;
  capture: (name: string, wc: WebContents) => Promise<void>;
}

/**
 * The card fields of a checkout (autocomplete tokens on some, Spanish labels only on others), its
 * security code a text or a password field, and a name field the person cannot see (1 px,
 * screen-reader-only) that a fill must leave empty. Sending it stays on the page.
 */
const cardForm = (cvcType: "text" | "password"): string => `<form id="pay" method="POST" action="/card-done" onsubmit="return false">
<div class="field"><label for="numero">Número de tarjeta</label><input id="numero" name="numero" type="text" inputmode="numeric" autocomplete="cc-number"></div>
<div class="field"><label for="titular">Titular de la tarjeta</label><input id="titular" name="titular" type="text"></div>
<div class="field"><label for="caducidad">Caducidad (MM/AA)</label><input id="caducidad" name="caducidad" type="text" placeholder="MM/AA" maxlength="5"></div>
<div class="field"><label for="cvc">CVC</label><input id="cvc" name="cvc" type="${cvcType}" autocomplete="cc-csc" maxlength="4"></div>
<input id="oculto" name="oculto" type="text" autocomplete="cc-name" tabindex="-1" style="position:absolute;width:1px;height:1px;padding:0;margin:-1px;border:0;overflow:hidden;clip:rect(0,0,0,0)">
<button type="submit">Pagar</button>
</form>`;
const HIDDEN_EMPTY = `document.getElementById("oculto").value === ""`;

const STYLE = "<style>body{font:14px sans-serif;margin:32px} .field{display:flex;flex-direction:column;gap:4px;margin:0 0 10px;max-width:320px} iframe{border:1px solid #ccc;width:420px;height:320px}</style>";

const checkoutPage = (cvcType: "text" | "password"): string => `<!doctype html><html lang="es"><head><title>Pago</title>${STYLE}</head><body><main><h1>Pago con tarjeta</h1>${cardForm(cvcType)}</main></body></html>`;

/** A shop page whose card fields live in a payment provider's frame on another origin. */
const hostPage = (frameUrl: string): string =>
  `<!doctype html><html lang="es"><head><title>Tienda</title>${STYLE}</head><body><main><h1>Tienda</h1><p>Paga abajo.</p><iframe id="payframe" src="${frameUrl}"></iframe></main></body></html>`;

const FRAME_PAGE = `<!doctype html><html lang="es"><head><title>Pasarela</title>${STYLE}</head><body style="margin:12px">${cardForm("text")}</body></html>`;

/**
 * Cards are filled only in secure contexts, and over http that is this computer only: the shop and its
 * payment provider are two loopback names, two sites apart.
 */
const SHOP_HOST = "http://localhost";
const PAY_HOST = "http://127.0.0.1";

/** The pages of the card autofill smoke, served by the shared smoke server. */
export function serveCardsSmokeRoute(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const pathname = (req.url ?? "/").split("?")[0] ?? "/";
  const host = req.headers.host ?? "";
  const port = host.split(":")[1] ?? "";
  const page = pathname === "/card-checkout" ? checkoutPage("text") : pathname === "/card-checkout-pw" ? checkoutPage("password") : pathname === "/card-host" ? hostPage(`${PAY_HOST}:${port}/card-frame`) : pathname === "/card-frame" ? FRAME_PAGE : null;
  if (!page) return false;
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(page);
  return true;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await cond()) return true;
    await sleep(120);
  }
  return false;
}

const js = <T>(wc: WebContents, expr: string): Promise<T | null> => (wc.isDestroyed() ? Promise.resolve(null) : (wc.executeJavaScript(expr, true) as Promise<T>).catch(() => null));
const frameJs = <T>(frame: WebFrameMain | undefined, expr: string): Promise<T | null> => (frame && !frame.detached ? (frame.executeJavaScript(expr, true) as Promise<T>).catch(() => null) : Promise.resolve(null));

interface CardValues {
  numero: string;
  titular: string;
  caducidad: string;
  cvc: string;
}
const READ_FORM = `(() => { const v = (id) => document.getElementById(id).value; return { numero: v("numero"), titular: v("titular"), caducidad: v("caducidad"), cvc: v("cvc") }; })()`;
const writeForm = (values: Partial<CardValues>): string => `(() => {
  for (const [id, value] of Object.entries(${JSON.stringify(values)})) {
    const el = document.getElementById(id);
    el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }
  return true;
})()`;
const BOX = (selector: string): string => `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`;

/** Made-up data and a published test number only. */
const SEEDED = { label: "Tarjeta smoke", nameOnCard: "Lucia Prueba", number: "4111111111111111", expMonth: "08", expYear: "2028" };
const FILLED: CardValues = { numero: "4111111111111111", titular: "Lucia Prueba", caducidad: "08/28", cvc: "123" };
const same = (v: CardValues | null): boolean => Boolean(v) && (Object.keys(FILLED) as (keyof CardValues)[]).every((k) => v?.[k] === FILLED[k]);

/**
 * Card autofill: a click into a checkout's card number lists the saved card ("Visa ...1111 - 08/28")
 * and Manage payment methods; a pick asks for the CVV and fills number, name, expiry (as MM/YY) and
 * that CVV; Cancel fills nothing. The same works in a payment provider's frame on another origin, and
 * fills only that frame. Sending a new card offers to save it (never its CVV). With payment methods
 * off in Settings no dropdown shows. The Payment methods tab lists the card.
 */
export async function runCardsSmoke(ctx: AppContext, { url, win, check, capture }: Helpers): Promise<void> {
  const port = new URL(url).port;
  const origin = `${SHOP_HOST}:${port}`;
  const vault = win.profile.cards;
  const before = new Set(vault.all().map((c) => c.id));
  const dropdown = dropdownDriver(ctx, win);
  const tabs: TabRuntime[] = [];
  const asked: string[] = [];
  const askedSites: string[] = [];
  let answer: string | null = "123";
  ctx.autofill.setCvvAsker(async (_w, request) => {
    asked.push(request.title);
    askedSites.push(request.site);
    return answer;
  });

  const open = async (path: string, base = origin): Promise<{ tab: TabRuntime; wc: WebContents }> => {
    const tab = win.createTab(`${base}${path}`);
    tabs.push(tab);
    const wc = tab.view.webContents;
    await until(() => !wc.isDestroyed() && wc.getURL().includes(path) && !tab.loading);
    await sleep(400);
    return { tab, wc };
  };
  /**
   * A real click at a point of the page. sendInputEvent reaches only the page's own process, so a click
   * into a frame of another site (a process of its own) goes through the DevTools input domain, which
   * routes it to that frame as the mouse does.
   */
  const clickAt = async (page: WebContents, box: { x: number; y: number } | null, timeoutMs = 5000, otherSite = false): Promise<boolean> => {
    const token = dropdown.token();
    if (!box) return false;
    page.focus();
    const at = { x: Math.round(box.x), y: Math.round(box.y) };
    if (otherSite) {
      const attach = !page.debugger.isAttached();
      if (attach) page.debugger.attach("1.3");
      try {
        for (const type of ["mousePressed", "mouseReleased"]) await page.debugger.sendCommand("Input.dispatchMouseEvent", { type, ...at, button: "left", clickCount: 1 });
      } finally {
        if (attach) page.debugger.detach();
      }
    } else {
      page.sendInputEvent({ type: "mouseDown", ...at, button: "left", clickCount: 1 });
      page.sendInputEvent({ type: "mouseUp", ...at, button: "left", clickCount: 1 });
    }
    return dropdown.opened(token, timeoutMs);
  };
  const pickCard = (id: string): boolean => {
    const s = dropdown.state();
    const index = s ? dropdownEntries(s).findIndex((e) => e.type === "card" && e.card.id === id) : -1;
    if (!s || index < 0) return false;
    ctx.autofill.fieldDropdown(win)?.onAction({ type: "activate", token: s.token, index });
    return true;
  };
  const cardSave = () => ctx.autofill.stateFor(win).cardSave ?? null;

  try {
    const seeded = vault.add(SEEDED);

    // 1: the dropdown under the card number lists the card and Manage payment methods.
    const { tab: checkout, wc } = await open("/card-checkout");
    const opened = await clickAt(wc, await js(wc, BOX("#numero")));
    const s = dropdown.state();
    const entries = s ? dropdownEntries(s) : [];
    check(
      "cards: a real click into a checkout's card number lists the saved card and Manage payment methods",
      opened && s?.kind === "card" && entries.some((e) => e.type === "card" && e.card.id === seeded.id && e.card.title === "Visa ...1111 - 08/28") && entries.some((e) => e.type === "manage"),
      { opened, kind: s?.kind, entries },
    );
    await windowShot(win, "card-dropdown", "cards");

    // 2: Cancel on the CVV prompt fills nothing.
    answer = null;
    pickCard(seeded.id);
    await sleep(1200);
    const untouched = await js<CardValues>(wc, READ_FORM);
    check("cards: cancelling the CVV prompt fills nothing", asked.at(-1) === "Visa ...1111" && Boolean(untouched) && Object.values(untouched ?? {}).every((v) => v === ""), { asked, untouched });

    // 3: Fill writes number, name, expiry as the field expects and the CVV; a workflow recorded meanwhile keeps none of it.
    answer = "123";
    ctx.flows.startRecording(win);
    await sleep(300);
    await clickAt(wc, await js(wc, BOX("#numero")));
    pickCard(seeded.id);
    let values: CardValues | null = null;
    const filled = await until(async () => {
      values = await js<CardValues>(wc, READ_FORM);
      return same(values);
    }, 6000);
    await sleep(300);
    const recorded = ctx.flows.stopRecording(win).steps;
    ctx.flows.discardRecording(win.profile);
    check("cards: picking the card and typing its CVV fills number, name, expiry (MM/YY) and the CVV", filled, { values, expected: FILLED });
    check("cards: a card field the person cannot see (1 px, screen-reader-only) stays empty", (await js<boolean>(wc, HIDDEN_EMPTY)) === true);
    check("cards: after a card fill, agents' scripts and raw reads are refused in the tab, as after a password fill", ctx.secretFills.check(checkout.id) !== null);
    const typed = recorded.filter((step) => step.kind === "type");
    check(
      "cards: a workflow recorded during the fill records the card fields as secret, never their values",
      typed.length > 0 && typed.every((step) => step.kind === "type" && step.secret && step.value === undefined) && !JSON.stringify(recorded).includes("4111"),
      recorded,
    );
    check("cards: a fill counts as a use of the card", (vault.get(seeded.id)?.useCount ?? 0) >= 1, vault.get(seeded.id)?.useCount);

    // 4: a payment provider's frame on another origin: the click there lists the card, the fill goes to that frame only.
    const { wc: host } = await open("/card-host");
    const frame = await (async () => {
      let found: WebFrameMain | undefined;
      await until(() => {
        found = host.mainFrame.frames.find((f) => f.origin === `${PAY_HOST}:${port}`);
        return Boolean(found);
      }, 6000);
      return found;
    })();
    await until(async () => Boolean(await frameJs<boolean>(frame, `document.readyState === "complete" && Boolean(document.getElementById("numero"))`)), 6000);
    await sleep(400);
    const frameBox = await js<{ x: number; y: number }>(host, `(() => { const r = document.getElementById("payframe").getBoundingClientRect(); return { x: r.left + 1, y: r.top + 1 }; })()`);
    const fieldBox = await frameJs<{ x: number; y: number }>(frame, BOX("#numero"));
    const inFrame = await clickAt(host, frameBox && fieldBox ? { x: frameBox.x + fieldBox.x, y: frameBox.y + fieldBox.y } : null, 5000, true);
    const fs = dropdown.state();
    check("cards: a click into a card number inside a payment frame of another site (its own process) lists the saved card", inFrame && fs?.kind === "card" && dropdownEntries(fs).some((e) => e.type === "card" && e.card.id === seeded.id), { inFrame, frame: frame?.origin, kind: fs?.kind });
    await windowShot(win, "card-dropdown-frame", "cards");
    pickCard(seeded.id);
    let frameValues: CardValues | null = null;
    const frameFilled = await until(async () => {
      frameValues = await frameJs<CardValues>(frame, READ_FORM);
      return same(frameValues);
    }, 6000);
    const hostText = await js<string>(host, "document.body.innerText");
    check("cards: picking it there fills the payment frame (number, name, expiry, CVV), and nothing in the shop page", frameFilled && !String(hostText).includes("4111"), { frameValues });
    check("cards: in the payment frame too, a card field the person cannot see stays empty", (await frameJs<boolean>(frame, HIDDEN_EMPTY)) === true);
    check("cards: the CVV prompt names the payment frame's site when it is another site than the page's, and none for the page itself", askedSites.at(-1) === `127.0.0.1:${port}` && askedSites[0] === "", askedSites);

    // 5: sending a new card offers to save it, without a CVV; its CVV in a password field is no password to save.
    const { wc: fresh } = await open("/card-checkout-pw");
    await js(fresh, writeForm({ numero: "5555 5555 5555 4444", titular: "Mario Ensayo", caducidad: "11/29", cvc: "987" }));
    await js(fresh, `document.getElementById("pay").requestSubmit(); true`);
    const offered = await until(() => cardSave()?.kind === "new", 5000);
    const save = cardSave();
    check("cards: sending a new card offers to save it", offered && ctx.autofill.stateFor(win).cardPrompt && save?.line === "Mastercard ...4444 - 11/29", save);
    check("cards: a card form whose CVV is a password field offers no password to save", !ctx.autofill.stateFor(win).canSave, ctx.autofill.stateFor(win));
    if (save) ctx.autofill.acceptCardSave(win, save.id);
    const added = vault.all().find((c) => !before.has(c.id) && c.id !== seeded.id);
    check(
      "cards: accepting saves number, name and expiry, never the CVV",
      Boolean(added && added.number === "5555555555554444" && added.nameOnCard === "Mario Ensayo" && added.expMonth === "11" && added.expYear === "2029") && !JSON.stringify(added).includes("987"),
      added && { name: added.nameOnCard, exp: `${added.expMonth}/${added.expYear}` },
    );

    // 6: payment methods off in Settings: no dropdown.
    ctx.settings.update({ passwords: { cards: false } });
    try {
      const { wc: off } = await open("/card-checkout");
      const openedOff = await clickAt(off, await js(off, BOX("#numero")), 1500);
      check("cards: with payment methods off in Settings, a click gives no dropdown", !openedOff, { openedOff });
    } finally {
      ctx.settings.update({ passwords: { cards: true } });
    }

    // 6b: a checkout over plain http on another computer is no secure context: no dropdown.
    const { wc: plain } = await open("/card-checkout", `http://shop.corvus-smoke.test:${port}`);
    const openedPlain = await clickAt(plain, await js(plain, BOX("#numero")), 1500);
    check("cards: a checkout over plain http that is not this computer gives no dropdown", !openedPlain, { openedPlain });

    // 7: the Payment methods tab lists the card, its number masked.
    const page = win.createTab("corvus://passwords/#cards");
    tabs.push(page);
    const listed = await until(async () => Boolean(await js<boolean>(page.view.webContents, `document.body.innerText.includes("Visa ...1111")`)), 10_000);
    const text = (await js<string>(page.view.webContents, "document.body.innerText")) ?? "";
    check("cards: the Payment methods tab lists the card with its number masked", listed && text.includes("**** **** **** 1111") && !text.includes("4111111111111111"), text.slice(0, 600));
    await capture("cards/passwords-page", page.view.webContents);
  } finally {
    ctx.flows.discardRecording(win.profile);
    ctx.autofill.setCvvAsker(null);
    ctx.settings.update({ passwords: { cards: true } });
    for (const tab of tabs) if (!tab.view.webContents.isDestroyed()) win.closeTab(tab.id);
    vault.applyRemote(vault.all().filter((c) => !before.has(c.id)).map((c) => ({ id: c.id, card: null })));
  }
}
