import type http from "node:http";
import type { WebContents } from "electron";
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
 * A Spanish checkout form: name and surnames apart, street in two lines, the country a select (codes as
 * values, names as texts), some fields with autocomplete and some without, and a phone and an e-mail
 * field the person cannot see (in a transparent box, placed off the page) that a fill must leave
 * empty. Sending it stays on the page.
 */
const CHECKOUT_PAGE = `<!doctype html><html lang="es"><head><title>Finalizar compra</title>
<style>body{font:14px sans-serif;margin:32px} .field{display:flex;flex-direction:column;gap:4px;margin:0 0 10px;max-width:320px}</style></head><body>
<main><h1>Datos de envio</h1>
<form id="checkout" method="POST" action="/addr-done" onsubmit="return false">
<div class="field"><label for="nombre">Nombre</label><input id="nombre" name="nombre" type="text" autocomplete="given-name"></div>
<div class="field"><label for="apellidos">Apellidos</label><input id="apellidos" name="apellidos" type="text"></div>
<div class="field"><label for="direccion">Dirección</label><input id="direccion" name="direccion" type="text" autocomplete="address-line1"></div>
<div class="field"><label for="piso">Piso/puerta</label><input id="piso" name="piso" type="text"></div>
<div class="field"><label for="cp">Código postal</label><input id="cp" name="cp" type="text" autocomplete="postal-code"></div>
<div class="field"><label for="ciudad">Ciudad</label><input id="ciudad" name="ciudad" type="text"></div>
<div class="field"><label for="provincia">Provincia</label><input id="provincia" name="provincia" type="text"></div>
<div class="field"><label for="pais">País</label><select id="pais" name="pais" autocomplete="country"><option value="">Selecciona</option><option value="FR">Francia</option><option value="ES">España</option><option value="PT">Portugal</option></select></div>
<div class="field"><label for="telefono">Teléfono</label><input id="telefono" name="telefono" type="tel"></div>
<div class="field"><label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email"></div>
<div class="field" style="opacity:0"><input id="tel-oculto" name="tel2" type="tel" autocomplete="tel" tabindex="-1"></div>
<input id="email-oculto" name="email2" type="email" autocomplete="email" tabindex="-1" style="position:absolute;left:-9999px">
<button type="submit">Pagar</button>
</form></main></body></html>`;

/** A plain sign-in form on the same site: its fields must keep the login dropdown. */
const LOGIN_PAGE = `<!doctype html><html><head><title>Acceso</title></head><body>
<form onsubmit="return false"><label for="u">Usuario</label><input id="u" name="username" type="text" autocomplete="username">
<label for="p">Contraseña</label><input id="p" name="password" type="password" autocomplete="current-password"><button>Entrar</button></form>
</body></html>`;

/** The pages of the address autofill smoke, served by the shared smoke server. */
export function serveAddressesSmokeRoute(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const pathname = (req.url ?? "/").split("?")[0] ?? "/";
  const page = pathname === "/addr-checkout" ? CHECKOUT_PAGE : pathname === "/addr-login" ? LOGIN_PAGE : null;
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

const FIELD_IDS = ["nombre", "apellidos", "direccion", "piso", "cp", "ciudad", "provincia", "pais", "telefono", "email"] as const;
type FormValues = Record<(typeof FIELD_IDS)[number], string>;

const READ_FORM = `(() => { const out = {}; for (const id of ${JSON.stringify(FIELD_IDS)}) out[id] = document.getElementById(id).value; return out; })()`;

/** Sets the form's fields as typing would (the page's own value setter, then input and change). */
const writeForm = (values: Partial<FormValues>): string => `(() => {
  const values = ${JSON.stringify(values)};
  for (const [id, value] of Object.entries(values)) {
    const el = document.getElementById(id);
    el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }
  return true;
})()`;

/** Made-up data only: no real person's. */
const SEEDED = {
  label: "Casa smoke",
  name: "Lucia Prueba Ejemplo",
  givenName: "Lucia",
  familyName: "Prueba Ejemplo",
  street: "Calle Ficticia 12\n3o B",
  postalCode: "28999",
  city: "Villaejemplo",
  region: "Provincia Inventada",
  country: "ES",
  phone: "+34 600 000 111",
  email: "lucia.smoke@example.com",
};

/**
 * Address autofill: a click into a Spanish checkout form's name field lists the saved address under it,
 * and a pick fills the whole form (street split in two lines, the country select set) without touching
 * what the person typed elsewhere. Sending a new address offers to save it, sending it again with a new
 * phone offers to update that same record. With addresses off in Settings, neither the dropdown nor the
 * offer shows. A sign-in form still gets the login dropdown. The Addresses tab lists the saved address.
 */
export async function runAddressesSmoke(ctx: AppContext, { url, win, check, capture }: Helpers): Promise<void> {
  const port = new URL(url).port;
  const origin = `http://addr.corvus-smoke.test:${port}`;
  const vault = win.profile.addresses;
  const before = new Set(vault.all().map((a) => a.id));
  const credentialIds: string[] = [];
  const dropdown = dropdownDriver(ctx, win);
  const tabs: TabRuntime[] = [];

  const open = async (path: string): Promise<{ tab: TabRuntime; wc: WebContents }> => {
    const tab = win.createTab(`${origin}${path}`);
    tabs.push(tab);
    const wc = tab.view.webContents;
    await until(() => !wc.isDestroyed() && wc.getURL().includes(path) && !tab.loading);
    await sleep(300);
    return { tab, wc };
  };
  /** A real click into a field; true when a dropdown opened after it. */
  const clickField = async (page: WebContents, selector: string, timeoutMs = 5000): Promise<boolean> => {
    const token = dropdown.token();
    const box = await js<{ x: number; y: number }>(page, `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
    if (!box) return false;
    page.focus();
    page.sendInputEvent({ type: "mouseDown", x: box.x, y: box.y, button: "left", clickCount: 1 });
    page.sendInputEvent({ type: "mouseUp", x: box.x, y: box.y, button: "left", clickCount: 1 });
    return dropdown.opened(token, timeoutMs);
  };
  const closeDropdown = (page: WebContents): void => {
    for (const type of ["keyDown", "keyUp"] as const) page.sendInputEvent({ type, keyCode: "Escape" });
  };
  const pickAddress = (id: string): boolean => {
    const s = dropdown.state();
    const index = s ? dropdownEntries(s).findIndex((e) => e.type === "address" && e.address.id === id) : -1;
    if (!s || index < 0) return false;
    ctx.autofill.fieldDropdown(win)?.onAction({ type: "activate", token: s.token, index });
    return true;
  };
  const submit = (page: WebContents): Promise<unknown> => js(page, `document.getElementById("checkout").requestSubmit(); true`);
  const addressSave = () => ctx.autofill.stateFor(win).addressSave ?? null;

  try {
    const seeded = vault.add(SEEDED);

    // 1 and 2: a pick fills the whole form, a field the person typed in stays as it was.
    const { wc } = await open("/addr-checkout");
    await js(wc, writeForm({ ciudad: "Escrita a mano" }));
    const opened = await clickField(wc, "#nombre");
    const s = dropdown.state();
    const offered = s?.kind === "address" && dropdownEntries(s).some((e) => e.type === "address" && e.address.id === seeded.id) && dropdownEntries(s).some((e) => e.type === "manage");
    check("addresses: a real click into the name field of a Spanish checkout form lists the saved address and Manage addresses", opened && offered, { opened, kind: s?.kind, entries: s ? dropdownEntries(s) : null });
    await windowShot(win, "address-dropdown", "addresses");
    const picked = pickAddress(seeded.id);
    const expected: FormValues = {
      nombre: "Lucia",
      apellidos: "Prueba Ejemplo",
      direccion: "Calle Ficticia 12",
      piso: "3o B",
      cp: "28999",
      ciudad: "Escrita a mano",
      provincia: "Provincia Inventada",
      pais: "ES",
      telefono: "+34 600 000 111",
      email: "lucia.smoke@example.com",
    };
    let values: FormValues | null = null;
    const filled = await until(async () => {
      values = await js<FormValues>(wc, READ_FORM);
      return Boolean(values && FIELD_IDS.every((id) => values?.[id] === expected[id]));
    }, 6000);
    check("addresses: picking it fills every field, the street split in line 1 and line 2, and the country select set to ES (\"España\")", picked && filled, { picked, values, expected });
    check("addresses: a field that already held a typed value is left as it was", (values as FormValues | null)?.ciudad === "Escrita a mano", values);
    const hidden = await js<string[]>(wc, `["tel-oculto", "email-oculto"].map((id) => document.getElementById(id).value)`);
    check("addresses: fields the person cannot see (a transparent box, placed off the page) stay empty", Boolean(hidden) && hidden!.every((v) => v === ""), hidden);
    check("addresses: a pick counts as a use of the address", (vault.get(seeded.id)?.useCount ?? 0) >= 1, vault.get(seeded.id));

    // Sending the form as filled (the saved address, the typed city) offers an update, never a duplicate.
    await submit(wc);
    const afterFill = await until(() => addressSave() !== null, 3000);
    check("addresses: sending a form filled from a saved address with one field changed offers an update of it, not a new address", afterFill && addressSave()?.kind === "update", addressSave());
    const fillSave = addressSave();
    if (fillSave) ctx.autofill.dismissAddressSave(win, fillSave.id);

    // Sending exactly what is saved (country select included) offers nothing.
    const { wc: same } = await open("/addr-checkout");
    await js(same, writeForm({ ...expected, ciudad: "Villaejemplo" }));
    await submit(same);
    await sleep(1500);
    check("addresses: sending exactly a saved address (country chosen in the select) offers nothing", addressSave() === null, { addressSave: addressSave(), saved: vault.get(seeded.id) });

    // 3: a new address typed and sent: offered as new, saved on accept; sent again with a new phone: an update of that record.
    const typed: FormValues = {
      nombre: "Mario",
      apellidos: "Ensayo Ficticio",
      direccion: "Avenida Imaginaria 7",
      piso: "1o A",
      cp: "41999",
      ciudad: "Pueblo Prueba",
      provincia: "Otra Provincia",
      pais: "FR",
      telefono: "+34 600 000 222",
      email: "mario.smoke@example.com",
    };
    const { wc: fresh } = await open("/addr-checkout");
    await js(fresh, writeForm(typed));
    await submit(fresh);
    const offeredNew = await until(() => addressSave()?.kind === "new", 5000);
    const newSave = addressSave();
    check("addresses: sending a new address offers to save it", offeredNew && ctx.autofill.stateFor(win).addressPrompt, { newSave, prompt: ctx.autofill.stateFor(win).addressPrompt });
    if (newSave) ctx.autofill.acceptAddressSave(win, newSave.id);
    const added = vault.all().find((a) => !before.has(a.id) && a.id !== seeded.id);
    check(
      "addresses: accepting saves it, with both street lines, the name split and the country as its code",
      Boolean(added && added.givenName === "Mario" && added.familyName === "Ensayo Ficticio" && added.street === "Avenida Imaginaria 7\n1o A" && added.postalCode === "41999" && added.country === "FR") && addressSave() === null,
      added,
    );
    const count = vault.all().length;
    const { wc: again } = await open("/addr-checkout");
    await js(again, writeForm({ ...typed, telefono: "+34 600 000 333" }));
    await submit(again);
    const offeredUpdate = await until(() => addressSave()?.kind === "update", 5000);
    const updateSave = addressSave();
    if (updateSave) ctx.autofill.acceptAddressSave(win, updateSave.id);
    const updated = added ? vault.get(added.id) : null;
    check(
      "addresses: sending it again with a new phone offers an update, and accepting changes only that record",
      offeredUpdate && vault.all().length === count && updated?.phone === "+34 600 000 333" && vault.get(seeded.id)?.phone === SEEDED.phone,
      { updateSave, count, now: vault.all().length, updated },
    );

    // 4: addresses off in Settings: no dropdown, no offer.
    ctx.settings.update({ passwords: { addresses: false } });
    try {
      const { wc: off } = await open("/addr-checkout");
      const openedOff = await clickField(off, "#nombre", 1500);
      await js(off, writeForm({ ...typed, direccion: "Camino Apagado 3", cp: "50999", telefono: "+34 600 000 444" }));
      await submit(off);
      await sleep(1500);
      check("addresses: with addresses off in Settings, a click gives no dropdown and sending gives no offer", !openedOff && addressSave() === null, { openedOff, addressSave: addressSave() });
    } finally {
      ctx.settings.update({ passwords: { addresses: true } });
    }

    // 5: a sign-in form keeps the login dropdown.
    credentialIds.push(win.profile.credentials.add({ origin, username: "smoke-addr-user", password: "pw-addr-smoke" }).id);
    const { wc: login } = await open("/addr-login");
    await until(() => ctx.autofill.stateFor(win).matchCount > 0, 5000);
    const loginOpened = await clickField(login, "#u");
    check("addresses: a sign-in form's username field still opens the login dropdown, not the address one", loginOpened && dropdown.state()?.kind === "login", { loginOpened, kind: dropdown.state()?.kind });
    closeDropdown(login);

    // 6: the Addresses tab of corvus://passwords lists the saved address.
    const page = win.createTab("corvus://passwords/#addresses");
    tabs.push(page);
    const listed = await until(async () => Boolean(await js<boolean>(page.view.webContents, `document.body.innerText.includes(${JSON.stringify(SEEDED.label)})`)), 10_000);
    check("addresses: the Addresses tab of corvus://passwords lists the saved address", listed, await js<string>(page.view.webContents, `document.body.innerText.slice(0, 600)`));
    await capture("addresses/passwords-page", page.view.webContents);
  } finally {
    ctx.settings.update({ passwords: { addresses: true } });
    for (const tab of tabs) if (!tab.view.webContents.isDestroyed()) win.closeTab(tab.id);
    for (const a of vault.all()) if (!before.has(a.id)) vault.remove(a.id);
    for (const id of credentialIds) win.profile.credentials.remove(id);
  }
}
