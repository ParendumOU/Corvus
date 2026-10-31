import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { nativeTheme, type WebContents } from "electron";
import { base32Encode, type TotpConfig } from "../shared/totp";
import type { AppContext } from "./context";
import { createKdbx, loadKdbxweb, type ExportEntry } from "./keepass-format";
import type { BrowserWindowCtl, TabRuntime } from "./window";

interface Helpers {
  /** The smoke server (its breach check stand-in). */
  url: string;
  win: BrowserWindowCtl;
  check: (name: string, ok: boolean, detail?: unknown) => void;
  capture: (name: string, wc: WebContents) => Promise<void>;
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
const truthy = (wc: WebContents, expr: string): Promise<boolean> => js<boolean>(wc, `Boolean(${expr})`).then((v) => v === true);

/** A made-up secret per seed: no real account's. */
const totp = (seed: number): TotpConfig => ({ secret: base32Encode(Uint8Array.from({ length: 20 }, (_, i) => (seed * 41 + i * 13 + 5) & 0xff)), algorithm: "SHA1", digits: 6, period: 30 });

/** The password the breach stand-in of the smoke server reports. */
const BREACHED = "password123";
const KP_MASTER = "tables-master";

/**
 * Layout audit of one table (like LAYOUT_AUDIT in smoke-settings.ts): the page never scrolls
 * sideways, a row's cells never overlap, nothing in a cell reaches out of it or out of the row
 * (chips, codes, switches, buttons), a column starts at the same place in every row, on one line or
 * folded onto two, the name keeps room to be read, and a name cut with an ellipsis has its full text
 * as a tooltip.
 */
const TABLE_AUDIT = (selector: string): string => `(() => {
  const table = document.querySelector(${JSON.stringify(selector)});
  if (!table) return null;
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const name = (row, el) => (row.dataset.id || "row") + " " + el.className;
  const inside = (a, b) => a.left >= b.left - 1 && a.right <= b.right + 1 && a.top >= b.top - 1 && a.bottom <= b.bottom + 1;
  const overlap = (a, b) => a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
  const rows = [...table.querySelectorAll(":scope > .pt-row")];
  const oneLine = getComputedStyle(table.querySelector(":scope > .pt-head")).display !== "none";
  const overlaps = [], outside = [], untitled = [], thin = [];
  const starts = { name: new Set(), status: new Set(), code: new Set(), option: new Set(), actions: new Set() };
  for (const row of rows) {
    const box = row.getBoundingClientRect();
    const cells = [".pt-icon", ".pt-name", ".pt-status", ".pt-code", ".pt-option", ".pt-actions"].map((s) => row.querySelector(s)).filter((c) => c && visible(c));
    if (row.querySelector(".pt-name").getBoundingClientRect().width < 150) thin.push(row.dataset.id);
    for (let i = 0; i < cells.length; i++) {
      if (!inside(cells[i].getBoundingClientRect(), box)) outside.push(name(row, cells[i]));
      for (let j = i + 1; j < cells.length; j++) if (overlap(cells[i].getBoundingClientRect(), cells[j].getBoundingClientRect())) overlaps.push(name(row, cells[i]) + " / " + cells[j].className);
      for (const child of cells[i].querySelectorAll("button, .pill, .pw-health, .pw-agent, .tf-code, .tf-left, .toggle, span")) {
        if (visible(child) && !inside(child.getBoundingClientRect(), cells[i].getBoundingClientRect())) outside.push(name(row, child) + " in " + cells[i].className);
      }
    }
    for (const text of row.querySelectorAll(".pt-primary, .pt-secondary, .pt-where")) {
      if (text.scrollWidth > text.clientWidth + 1 && text.title !== text.textContent.trim()) untitled.push(name(row, text));
    }
    for (const [key, sel] of [["name", ".pt-name"], ["status", ".pt-status"], ["code", ".pt-code"], ["option", ".pt-option"], ["actions", ".pt-actions"]]) {
      const cell = row.querySelector(sel);
      if (cell && visible(cell)) starts[key].add(Math.round(cell.getBoundingClientRect().left));
    }
  }
  const misaligned = Object.entries(starts).filter(([, s]) => s.size > 1).map(([k, s]) => k + ": " + [...s].join(","));
  return { rows: rows.length, oneLine, overflow: document.scrollingElement.scrollWidth > window.innerWidth + 1, overlaps: overlaps.slice(0, 6), outside: outside.slice(0, 6), misaligned, untitled: untitled.slice(0, 6), thin: thin.slice(0, 6) };
})()`;

type TableAudit = { rows: number; oneLine: boolean; overflow: boolean; overlaps: string[]; outside: string[]; misaligned: string[]; untitled: string[]; thin: string[] };

const auditOk = (a: TableAudit | null): boolean => Boolean(a && a.rows > 0 && !a.overflow && a.overlaps.length === 0 && a.outside.length === 0 && a.misaligned.length === 0 && a.untitled.length === 0 && a.thin.length === 0);

/**
 * Audit of the page's header: the title's text fits its box and nothing covers it (the brand, the
 * toolbar's search and buttons), and no toolbar item leaves the window.
 */
const HEADER_AUDIT = `(() => {
  const h1 = document.querySelector(".page-header h1");
  const range = document.createRange();
  range.selectNodeContents(h1);
  const text = range.getBoundingClientRect();
  const box = h1.getBoundingClientRect();
  const overlap = (a, b) => a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
  const items = [...document.querySelectorAll(".page-header .brand, .page-toolbar > *")].filter((el) => el.getBoundingClientRect().width > 0);
  const label = (el) => el.tagName.toLowerCase() + "." + String(el.className).split(" ").join(".");
  const top = document.elementFromPoint(text.right - 2, (text.top + text.bottom) / 2);
  return {
    title: h1.textContent,
    clipped: text.right > box.right + 1 || h1.scrollWidth > h1.clientWidth + 1,
    covered: !top || !(top === h1 || h1.contains(top)),
    over: items.filter((el) => overlap(el.getBoundingClientRect(), text)).map(label),
    outside: items.filter((el) => { const r = el.getBoundingClientRect(); return r.left < -1 || r.right > window.innerWidth + 1; }).map(label),
  };
})()`;

type HeaderAudit = { title: string; clipped: boolean; covered: boolean; over: string[]; outside: string[] };

const headerOk = (a: HeaderAudit | null): boolean => Boolean(a && a.title && !a.clipped && !a.covered && a.over.length === 0 && a.outside.length === 0);

const fileState = (file: string): { hash: string; mtime: number; bak: boolean } => ({
  hash: crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
  mtime: fs.statSync(file).mtimeMs,
  bak: fs.existsSync(`${file}.bak`),
});

/**
 * Writes a KeePass database with its entries in groups (`group` of each entry, " / " for subgroups),
 * the way a person's database looks: several groups, some nested, long names.
 */
async function writeGroupedKdbx(file: string, name: string, entries: Array<ExportEntry & { group: string }>): Promise<void> {
  const kdbxweb = await loadKdbxweb();
  const bytes = await createKdbx(entries, KP_MASTER, { name, memoryKiB: 4096, iterations: 1 });
  const db = await kdbxweb.Kdbx.load(new Uint8Array(bytes).buffer, new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString(KP_MASTER)));
  const root = db.getDefaultGroup();
  const groupAt = (pathName: string): typeof root => {
    let group = root;
    for (const part of pathName.split(" / ")) group = group.groups.find((g) => g.name === part) ?? db.createGroup(group, part);
    return group;
  };
  const all = [...root.entries];
  entries.forEach((e, i) => {
    if (e.group) db.move(all[i]!, groupAt(e.group));
  });
  fs.writeFileSync(file, new Uint8Array(await db.save()));
}

/**
 * The three lists of corvus://passwords (the saved logins, the KeePass entries, the 2FA codes) with
 * enough rows to show how they hold up: long sites, usernames, titles and group names, every status
 * chip, 2FA-only logins, two unlocked KeePass databases with nested groups. Screenshots in English
 * and Spanish, 480, 820 and 1280 px wide, light and dark, with `screenshots` (CORVUS_SMOKE_ONLY=tables);
 * the layout audit at those widths and at 1000 and 1600 px runs every time.
 */
export async function runPasswordTablesSmoke(ctx: AppContext, { url, win, check, capture }: Helpers, screenshots = false): Promise<void> {
  const vault = win.profile.credentials;
  const kp = win.profile.keepass;
  const language = ctx.settings.get().appearance.language;
  const agentAccess = ctx.settings.get().passwords.agentAccess;
  const endpoint = ctx.passwordCheckup.endpoint;
  const seeded: string[] = [];
  const add = (origin: string, username: string, password: string, extra: { totp?: TotpConfig; agentSignIn?: boolean; agentTotp?: boolean } = {}): string => {
    const id = vault.add({ origin, username, password, ...extra }).id;
    seeded.push(id);
    return id;
  };
  // Fillers first: the vault lists the most recent first, so the long rows with chips show at the top.
  for (let n = 0; n < 26; n++) add(`https://site${String(n).padStart(2, "0")}.example.test`, `user${n}@example.com`, `Unique-Pass-${n}-x9Q!`, n % 3 === 0 ? { totp: totp(10 + n) } : {});
  const longId = add("https://accounts.a-very-long-subdomain-for-layout-checks.example.test", "first.middle.last.with.a.long.address@example.com", BREACHED, { totp: totp(1), agentSignIn: true, agentTotp: true });
  add("https://reused.example.test", "reuse@example.com", BREACHED, { totp: totp(2) });
  add("https://only-2fa.example.test", "only-2fa@example.com", "", { totp: totp(3) });
  add("https://weak.example.test", "weak@example.com", "abc", { agentSignIn: true });
  add("https://no-user.example.test", "", "Strong-Unique-Pass-41!");
  win.profile.autoSignIn.set(longId, true);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "corvus-tables-"));
  const files = [path.join(dir, "Personal vault with a long file name.kdbx"), path.join(dir, "Work.kdbx")];
  let tab: TabRuntime | null = null;
  let rememberedTab: string | null = null;
  try {
    await writeGroupedKdbx(files[0]!, "Personal", [
      { group: "Banking", title: "Example Bank", username: "holder@example.com", password: BREACHED, url: "https://bank.example.test", totp: totp(40) },
      { group: "Banking / Cards", title: "Card portal with a really long entry title for the layout", username: "card-holder-with-a-long-name@example.com", password: "Card-Pass-77!x", url: "https://cards.example.test/login" },
      { group: "Shopping", title: "Shop", username: "buyer@example.org", password: "abc", url: "https://shop.example.org" },
      { group: "Social / A rather long group name to test truncation", title: "Forum", username: "poster@example.org", password: "Forum-Pass-12!q", url: "https://forum.example.test", totp: totp(41) },
      { group: "", title: "Authenticator only", username: "", password: "", url: "", totp: totp(42) },
    ]);
    await writeGroupedKdbx(files[1]!, "Work", [
      { group: "IT", title: "Intranet", username: "staff@example.com", password: "Intranet-Pass-3!z", url: "https://intranet.example.test", totp: totp(43) },
      { group: "", title: "Wiki", username: "staff@example.com", password: "Wiki-Pass-8!k", url: "https://wiki.example.test" },
    ]);
    kp.addSources(files, "file");
    for (const db of kp.databases().filter((d) => files.includes(d.path))) await kp.unlock(db.id, KP_MASTER, null, false);
    const kpId = (title: string): string => kp.entries().find((e) => e.title === title)?.id ?? "";
    const bank = kp.entries().find((e) => e.title === "Example Bank");
    if (bank) {
      kp.setOptIn(bank.id, { signIn: true, totp: true });
      win.profile.autoSignIn.set(bank.id, true);
    }
    check("password tables: the two KeePass databases unlock with their groups", kp.entries().filter((e) => e.group).length >= 5, kp.entries().map((e) => e.group));

    // Breached, reused and weak chips: the breach check against the smoke server's stand-in.
    ctx.passwordCheckup.endpoint = `${url.replace(/\/$/, "")}/pwned/range/`;
    ctx.settings.update({ passwords: { agentAccess: true } });
    await ctx.passwordCheckup.run(win.profile);

    tab = win.createTab("corvus://passwords/#passwords", { activate: true });
    const wc = tab.view.webContents;
    await until(() => truthy(wc, `document.querySelector(".pw-list") && document.querySelector("#keepass .kp-list") && document.querySelector(".pw-health.danger")`), 15_000);
    rememberedTab = await js<string | null>(wc, `localStorage.getItem("corvus.passwords.tab")`);
    const bounds = tab.view.getBounds();

    /** Scrolls a list to just under the page's header. */
    const show = async (selector: string): Promise<void> => {
      await js(
        wc,
        `(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          const header = document.querySelector(".page-header")?.getBoundingClientRect().bottom ?? 0;
          if (el) window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - header - 8);
          return true;
        })()`,
      );
      await sleep(250);
    };
    const lists = [
      { key: "passwords", tab: "passwords", show: ".pw-list", table: ".pw-list .pt" },
      { key: "keepass", tab: "passwords", show: "#keepass .kp-browser", table: "#keepass .kp-list .pt" },
      { key: "2fa", tab: "2fa", show: ".tf-list", table: ".tf-list .pt" },
    ] as const;
    const audits: Record<string, TableAudit | null> = {};
    const headers: Record<string, HeaderAudit | null> = {};
    for (const lang of ["en", "es"] as const) {
      ctx.settings.update({ appearance: { language: lang } });
      wc.reload();
      await until(() => truthy(wc, `document.documentElement.lang === ${JSON.stringify(lang)} && document.querySelector("#keepass .kp-list") && document.querySelector(".pw-health.danger")`), 15_000);
      // Screenshots at 480, 820 and 1280 px; the layout audit at those and at 1000 and 1600 px.
      for (const width of [480, 820, 1000, 1280, 1600]) {
        tab.view.setBounds({ ...bounds, width });
        await sleep(500);
        const shots = screenshots && (width === 480 || width === 820 || width === 1280);
        for (const theme of shots ? (["light", "dark"] as const) : (["light"] as const)) {
          nativeTheme.themeSource = theme;
          for (const list of lists) {
            await js(wc, `document.getElementById("pw-tab-${list.tab}").click()`);
            if (list.tab === "2fa") await until(() => truthy(wc, `document.querySelector(".tf-row .tf-code:not(.muted)")`), 5000);
            await sleep(300);
            await show(list.show);
            if (shots) {
              // Sites with no icon of their own get their letter after the icon fails to load.
              await sleep(700);
              await capture(`${list.key}-${lang}-${width}-${theme}`, wc);
            }
            if (theme === "light") audits[`${list.key} ${lang} ${width}`] = await js<TableAudit>(wc, TABLE_AUDIT(list.table));
          }
        }
        nativeTheme.themeSource = "system";
      }
      // A KeePass entry with its password shown (it opens under the name), wide.
      tab.view.setBounds({ ...bounds, width: 1280 });
      await js(wc, `document.getElementById("pw-tab-passwords").click(); window.confirm = () => true; true`);
      await sleep(400);
      await js(wc, `[...document.querySelectorAll("#keepass .pt-row")].find((r) => r.innerText.includes("Example Bank"))?.querySelector(".pt-reveal")?.click()`);
      await until(() => truthy(wc, `document.querySelector("#keepass .pt-row .pw-reveal")`), 3000);
      await show("#keepass .kp-browser");
      await capture(`keepass-open-${lang}-1280-light`, wc);
      audits[`keepass ${lang} 1280 revealed`] = await js<TableAudit>(wc, TABLE_AUDIT("#keepass .kp-list .pt"));
      // The page's header, in both tabs (each has its own search text).
      for (const width of [480, 600, 760, 761, 820, 900, 1000, 1100]) {
        tab.view.setBounds({ ...bounds, width });
        for (const which of ["passwords", "2fa"] as const) {
          await js(wc, `window.scrollTo(0, 0); document.getElementById("pw-tab-${which}").click()`);
          await sleep(250);
          headers[`${lang} ${width} ${which}`] = await js<HeaderAudit>(wc, HEADER_AUDIT);
        }
      }
    }
    tab.view.setBounds(bounds);
    const badHeaders = Object.entries(headers).filter(([, a]) => !headerOk(a));
    check("password tables: the page title is never cut or covered, 480 to 1100 px, English and Spanish, both tabs", Object.keys(headers).length === 32 && badHeaders.length === 0, badHeaders.length ? Object.fromEntries(badHeaders.slice(0, 8)) : { checked: Object.keys(headers).length });
    for (const list of lists) {
      const mine = Object.entries(audits).filter(([key]) => key.startsWith(`${list.key} `));
      const bad = mine.filter(([, a]) => !auditOk(a));
      check(
        `password tables (${list.key}): 480 to 1600 px, English and Spanish: nothing overlaps or sticks out, columns line up, cut names show in full on hover, no sideways scroll`,
        mine.length >= 10 && bad.length === 0,
        bad.length ? Object.fromEntries(bad) : { checked: mine.length },
      );
    }
    // One line per row while the list is wide enough, two lines at 480 px.
    const lines = (key: string): boolean | undefined => audits[key]?.oneLine;
    check(
      "password tables: rows keep one line when the list is wide and fold onto two at 480 px",
      lines("passwords en 1280") === true && lines("2fa en 1280") === true && lines("keepass en 1600") === true && lines("passwords en 480") === false && lines("keepass en 480") === false && lines("2fa en 480") === false,
      Object.fromEntries(Object.entries(audits).map(([k, a]) => [k, a?.oneLine])),
    );

    // The automatic sign-in switch, clicked in both lists: it opts in, shows it, and a reload keeps it.
    await js(wc, `document.getElementById("pw-tab-passwords").click()`);
    await until(() => truthy(wc, `document.querySelector("#keepass .pt-row .toggle")`), 5000);
    const rowOf = (id: string): string => `.pt-row[data-id=${JSON.stringify(id)}]`;
    const switchOf = (id: string): string => `document.querySelector(${JSON.stringify(`${rowOf(id)} .pt-option .toggle`)})`;
    const shown = (id: string): Promise<string | null> => js<string | null>(wc, `${switchOf(id)}?.getAttribute("aria-checked") ?? null`);
    const optedIn = (id: string): boolean => [...win.profile.autoSignIn.ids()].includes(id);
    const siteId = vault.all().find((c) => c.origin === "https://site01.example.test")?.id ?? "";
    for (const [list, id] of [["saved logins", siteId], ["KeePass", kpId("Wiki")]] as const) {
      // The page was reloaded for the list before: wait for this row.
      await until(() => truthy(wc, switchOf(id)), 8000);
      const off = (await shown(id)) === "false" && !optedIn(id);
      await js(wc, `${switchOf(id)}?.click()`);
      const on = await until(async () => optedIn(id) && (await shown(id)) === "true", 3000);
      wc.reload();
      await until(() => truthy(wc, `${switchOf(id)}`), 8000);
      const kept = (await until(async () => (await shown(id)) === "true", 3000)) && optedIn(id);
      await js(wc, `${switchOf(id)}?.click()`);
      const back = await until(async () => !optedIn(id) && (await shown(id)) === "false", 3000);
      check(`password tables (${list}): the auto sign-in switch opts in when clicked, shows it, keeps it after a reload, and turns off`, off && on && kept && back, { off, on, kept, back });
    }

    // The AI options of a KeePass entry, through its Edit form: they live in Corvus, never in the file.
    const edit = async (id: string): Promise<boolean> => {
      await js(wc, `document.querySelector(${JSON.stringify(`${rowOf(id)} .pt-edit`)})?.click()`);
      return until(() => truthy(wc, `document.querySelector(".modal-card .kp-field-url")?.value.startsWith("https://")`), 5000);
    };
    const save = async (): Promise<void> => {
      await js(wc, `document.querySelector(".modal-card .modal-foot .btn.primary").click()`);
      await until(() => truthy(wc, `!document.querySelector(".modal-card")`), 8000);
    };
    const entry = (id: string) => kp.entries().find((e) => e.id === id);
    const wikiId = kpId("Wiki");
    const untouched = fileState(files[1]!);
    const opened = await edit(wikiId);
    const noCode = await truthy(wc, `document.querySelector(".modal-card .kp-ai-totp input").disabled`);
    await js(wc, `document.querySelector(".modal-card .kp-ai-signin input").click()`);
    await sleep(200);
    await save();
    const onlyOptions = await until(() => entry(wikiId)?.agentSignIn === true, 3000);
    const chip = await until(() => truthy(wc, `document.querySelector(${JSON.stringify(`${rowOf(wikiId)} .pw-agent`)})`), 3000);
    const after = fileState(files[1]!);
    check(
      "KeePass form: only the AI options changed: they apply, the row shows them, and the database file is not written (same bytes and time, no .bak)",
      opened && noCode && onlyOptions && chip && after.hash === untouched.hash && after.mtime === untouched.mtime && !after.bak,
      { opened, noCode, onlyOptions, chip, sameBytes: after.hash === untouched.hash, sameTime: after.mtime === untouched.mtime, bak: after.bak },
    );
    await edit(wikiId);
    const remembered = await truthy(wc, `document.querySelector(".modal-card .kp-ai-signin input").checked`);
    await js(wc, `document.querySelector(".modal-card .modal-foot .btn:not(.primary)").click()`);
    await until(() => truthy(wc, `!document.querySelector(".modal-card")`), 3000);

    // A file change and the options in one save: the entry is written and the options are saved.
    const intranetId = kpId("Intranet");
    await edit(intranetId);
    await js(
      wc,
      `(() => {
        const input = document.querySelector(".modal-card .kp-field-username");
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "staff-new@example.com");
        input.dispatchEvent(new Event("input", { bubbles: true }));
        document.querySelector(".modal-card .kp-ai-signin input").click();
        document.querySelector(".modal-card .kp-ai-totp input").click();
        return true;
      })()`,
    );
    await sleep(200);
    await save();
    const both = await until(() => entry(intranetId)?.username === "staff-new@example.com" && entry(intranetId)?.agentSignIn === true && entry(intranetId)?.agentTotp === true, 5000);
    const written = fileState(files[1]!);
    check("KeePass form: a changed field and the AI options: the entry is written (after a .bak copy) and the options are saved; the form shows them when it opens again", remembered && both && written.hash !== untouched.hash && written.bak, { remembered, both, bak: written.bak });

    // A file that cannot be written (another app saved it first): the options are saved all the same.
    const forumId = kpId("Forum");
    await edit(forumId);
    await js(
      wc,
      `(() => {
        const input = document.querySelector(".modal-card .kp-field-username");
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "poster-new@example.org");
        input.dispatchEvent(new Event("input", { bubbles: true }));
        document.querySelector(".modal-card .kp-ai-signin input").click();
        return true;
      })()`,
    );
    await sleep(200);
    const stamp = new Date(Date.now() + 5000);
    fs.utimesSync(files[0]!, stamp, stamp);
    await js(wc, `document.querySelector(".modal-card .modal-foot .btn.primary").click()`);
    const failed = await until(() => truthy(wc, `document.querySelector(".modal-card .pw-error")`), 5000);
    const kept = await until(() => entry(forumId)?.agentSignIn === true, 3000);
    await js(wc, `document.querySelector(".modal-card .modal-foot .btn:not(.primary)").click()`);
    await until(() => truthy(wc, `!document.querySelector(".modal-card")`), 3000);
    check("KeePass form: when the file cannot be written the form says so, the entry stays as it was, and the AI options are saved", failed && kept && entry(forumId)?.username === "poster@example.org", { failed, kept, username: entry(forumId)?.username });
  } finally {
    nativeTheme.themeSource = "system";
    ctx.settings.update({ appearance: { language }, passwords: { agentAccess } });
    ctx.passwordCheckup.endpoint = endpoint;
    if (tab) {
      await js(tab.view.webContents, rememberedTab === null ? `localStorage.removeItem("corvus.passwords.tab")` : `localStorage.setItem("corvus.passwords.tab", ${JSON.stringify(rememberedTab)})`);
      win.closeTab(tab.id);
    }
    for (const id of seeded) {
      win.profile.autoSignIn.set(id, false);
      if (vault.get(id)) vault.remove(id);
    }
    const dbIds = new Set(kp.databases().filter((d) => files.includes(d.path)).map((d) => d.id));
    for (const e of kp.entries()) if (dbIds.has(e.dbId)) win.profile.autoSignIn.set(e.id, false);
    for (const source of kp.sources()) if (files.includes(source.path)) kp.removeSource(source.id);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
