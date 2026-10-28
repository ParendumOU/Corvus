import type { WebContents } from "electron";
import type { NetworkInterfaceMap } from "@corvus/shared";
import type { AppContext } from "./context";
import { narrowWindow } from "./smoke-pairing";

type Check = (name: string, ok: boolean, detail?: unknown) => void;
type Capture = (name: string, wc: WebContents) => Promise<void>;
type Window = ReturnType<AppContext["windows"]["target"]>;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function poll(wc: WebContents, expr: string, timeoutMs = 8000): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if ((await wc.executeJavaScript(`Boolean(${expr})`).catch(() => false)) === true) return true;
    await sleep(120);
  }
  return false;
}

/** A desktop with two wired adapters, as on the owner's PC: what "Your other devices reach it at" lists. */
const TWO_ADAPTERS: NetworkInterfaceMap = {
  "Ethernet 4": [{ address: "192.168.1.200", family: "IPv4", internal: false }],
  Ethernet: [{ address: "10.0.10.17", family: "IPv4", internal: false }],
};

/** A window of about 800 px, where the side nav still shows and every setting row is tight. */
const MEDIUM_WIDTH = 800;

/** Seeded calls in the activity log, more than one page of them. */
const SEEDED_CALLS = 12;
const SMOKE_CLIENT = "smoke-settings";

/**
 * What can go wrong with the look of Settings, found in the page: fields without the shared input
 * style, a button pushed under the field it belongs to, controls cut off at a card's edge, and a
 * page wider than its window.
 */
const LAYOUT_AUDIT = `(() => {
  const visible = (el) => el.offsetParent !== null && el.getBoundingClientRect().width > 0;
  const name = (el) => {
    const card = el.closest(".card[id]");
    return (card ? "#" + card.id + " " : "") + el.tagName.toLowerCase() + (el.className ? "." + String(el.className).trim().split(/\\s+/).join(".") : "") + (el.placeholder ? "[" + el.placeholder + "]" : "") + (el.textContent?.trim() ? " " + JSON.stringify(el.textContent.trim().slice(0, 30)) : "");
  };
  const skip = new Set(["checkbox", "radio", "range", "file", "hidden", "color"]);
  const fields = [...document.querySelectorAll(".page-main input, .page-main select, .page-main textarea")].filter(
    (el) => visible(el) && !skip.has(el.type) && !el.closest(".settings-search"),
  );
  const unstyled = fields.filter((el) => !el.classList.contains("input")).map(name);
  const split = [];
  for (const field of fields) {
    const next = field.nextElementSibling;
    if (!next || !next.classList.contains("btn") || !visible(next)) continue;
    const a = field.getBoundingClientRect();
    const b = next.getBoundingClientRect();
    if (b.top >= a.bottom - 1) split.push(name(field) + " / " + name(next));
  }
  const clipped = [];
  for (const card of document.querySelectorAll(".page-main .card")) {
    const edge = card.getBoundingClientRect().right;
    for (const el of card.querySelectorAll("input, select, textarea, button, code, .pill, a.btn")) {
      if (visible(el) && el.getBoundingClientRect().right > edge + 1) clipped.push(name(el));
    }
  }
  const doc = document.scrollingElement;
  return { width: window.innerWidth, overflow: doc.scrollWidth > window.innerWidth + 1, unstyled, split, clipped: clipped.slice(0, 20) };
})()`;

type Audit = { width: number; overflow: boolean; unstyled: string[]; split: string[]; clipped: string[] };

/** Screenshots of every Settings section (slices of the window), for a person to look at. */
async function captureSections(wc: WebContents, prefix: string, capture: Capture): Promise<void> {
  const ids = (await wc.executeJavaScript(`[...document.querySelectorAll(".page-main > .card[id]")].map((c) => c.id)`)) as string[];
  for (const id of ids) {
    await wc.executeJavaScript(`document.getElementById(${JSON.stringify(id)}).scrollIntoView({ block: "start" })`);
    await sleep(150);
    for (let slice = 1; slice <= 6; slice++) {
      await capture(`${prefix}-${id}${slice > 1 ? `-${slice}` : ""}`, wc);
      const more = (await wc.executeJavaScript(`(() => {
        const box = document.getElementById(${JSON.stringify(id)}).getBoundingClientRect();
        if (box.bottom <= window.innerHeight) return false;
        window.scrollBy(0, window.innerHeight - 180);
        return true;
      })()`)) as boolean;
      if (!more) break;
      await sleep(120);
    }
  }
}

async function openSettings(win: Window, hash: string): Promise<{ wc: WebContents; close: () => void }> {
  const tab = win.createTab(`corvus://settings/#${hash}`, { activate: true });
  const wc = tab.view.webContents;
  await poll(wc, `document.querySelector("#${hash}")`);
  await sleep(800);
  return { wc, close: () => win.closeTab(tab.id) };
}

/**
 * Settings, in English and Spanish, wide and at about 800 px: every field has the shared style,
 * no button sits under its field, nothing is cut off. Then the parts people asked about: the
 * addresses the built-in sync server is reached at, one per line; the latest agent calls five at a
 * time with a pager; and the "remembers about you" field with its Add button on one line.
 * CORVUS_SMOKE_SETTINGS_SHOTS=1 also saves every section, for a person to look at.
 */
export async function runSettingsLayoutSmoke(ctx: AppContext, h: { win: Window; check: Check; capture: Capture }): Promise<void> {
  const { win, check, capture } = h;
  const profile = win.profile;
  const shots = process.env.CORVUS_SMOKE_SETTINGS_SHOTS === "1";
  const before = ctx.settings.get();
  const realInterfaces = ctx.sync.networkInterfaces;
  const now = Date.now();
  ctx.mcp.audit.clear();
  for (let i = 0; i < SEEDED_CALLS; i++) {
    ctx.mcp.audit.record({
      at: now - (SEEDED_CALLS - i) * 60_000,
      client: i % 3 === 0 ? `${SMOKE_CLIENT}-desktop` : SMOKE_CLIENT,
      tool: ["navigate", "snapshot", "click", "type"][i % 4]!,
      host: i % 2 ? "example.com" : "docs.example.org",
      outcome: i % 5 === 4 ? "error" : "ok",
      durationMs: 40 + i * 13,
      ...(i % 5 === 4 ? { error: "Element ref e12 is not on the page any more" } : {}),
    });
  }
  profile.userMemory.clear();
  profile.userMemory.add("I live in Bilbao");
  profile.userMemory.add("Usual airport: BIO, economy class");

  try {
    // Every section, both languages, wide and medium.
    for (const language of ["en", "es"] as const) {
      ctx.settings.update({ appearance: { language } });
      const { wc, close } = await openSettings(win, "appearance");
      const wide = (await wc.executeJavaScript(LAYOUT_AUDIT)) as Audit;
      if (shots) await captureSections(wc, `settings-shots/${language}-wide`, capture);
      let medium = wide;
      await narrowWindow(
        win.win,
        async () => {
          medium = (await wc.executeJavaScript(LAYOUT_AUDIT)) as Audit;
          if (shots) await captureSections(wc, `settings-shots/${language}-medium`, capture);
        },
        MEDIUM_WIDTH,
      );
      const clean = (a: Audit): boolean => !a.overflow && a.unstyled.length === 0 && a.split.length === 0 && a.clipped.length === 0;
      check(`settings layout (${language}): every field styled, no button under its field, nothing cut off, wide and at ${MEDIUM_WIDTH} px`, clean(wide) && clean(medium), { wide, medium });
      close();
    }

    // The built-in sync server on a computer with two adapters: one address a line, adapter after it.
    ctx.sync.networkInterfaces = () => TWO_ADAPTERS;
    const on = await ctx.sync.enable(profile, { mode: "local", phrase: await ctx.sync.generatePhrase(), deviceName: "Smoke settings" });
    ctx.settings.update({ appearance: { language: "es", homePage: "custom" }, dictation: { enabled: true }, ai: { provider: "local" } });
    const port = on.localServer?.port;
    {
      const { wc, close } = await openSettings(win, "sync");
      await poll(wc, `document.querySelector(".sync-addresses li")`);
      const addresses = (await wc.executeJavaScript(`[...document.querySelectorAll(".sync-addresses li")].map((li) => ({
        address: li.querySelector("code")?.textContent ?? "",
        adapter: li.querySelector(".muted")?.textContent ?? "",
        mono: getComputedStyle(li.querySelector("code") ?? li).fontFamily.includes("Mono"),
      }))`)) as Array<{ address: string; adapter: string; mono: boolean }>;
      check(
        "settings sync: this computer's addresses, one a line as address:port with the adapter after it",
        addresses.length === 2 && addresses[0]?.address === `192.168.1.200:${port}` && addresses[0].adapter === "Ethernet 4" && addresses[1]?.address === `10.0.10.17:${port}` && addresses[1].adapter === "Ethernet" && addresses.every((a) => a.mono),
        { port, addresses },
      );
      const audit = (await wc.executeJavaScript(LAYOUT_AUDIT)) as Audit;
      if (shots) await captureSections(wc, "settings-shots/es-wide-expanded", capture);
      let medium = audit;
      await narrowWindow(
        win.win,
        async () => {
          await wc.executeJavaScript(`document.getElementById("sync").scrollIntoView({ block: "start" })`);
          await sleep(200);
          medium = (await wc.executeJavaScript(LAYOUT_AUDIT)) as Audit;
          await capture("settings-sync-addresses-medium", wc);
          if (shots) await captureSections(wc, "settings-shots/es-medium-expanded", capture);
        },
        MEDIUM_WIDTH,
      );
      await wc.executeJavaScript(`document.getElementById("sync").scrollIntoView({ block: "start" })`);
      await sleep(200);
      await capture("settings-sync-addresses", wc);
      const clean = (a: Audit): boolean => !a.overflow && a.unstyled.length === 0 && a.split.length === 0 && a.clipped.length === 0;
      check("settings layout (es, sync on, more options shown): every field styled, no button under its field, nothing cut off", clean(audit) && clean(medium), { audit, medium });
      close();
    }
    ctx.settings.update({ appearance: { language: "en" } });

    // Recent agent calls: five at a time, a pager under them; the filters still apply.
    {
      const { wc, close } = await openSettings(win, "agents");
      await poll(wc, `document.querySelector("#agents .agent-calls .list-row")`);
      const page = async (): Promise<{ rows: number; pager: string; first: string }> =>
        (await wc.executeJavaScript(`({
          rows: document.querySelectorAll("#agents .agent-calls .list-row").length,
          pager: document.querySelector("#agents .pager")?.textContent ?? "",
          first: document.querySelector("#agents .agent-calls .list-row")?.textContent ?? "",
        })`)) as { rows: number; pager: string; first: string };
      const first = await page();
      await wc.executeJavaScript(`[...document.querySelectorAll("#agents .pager button")].find((b) => b.textContent.trim() === "Next")?.click()`);
      await poll(wc, `document.querySelector("#agents .pager")?.textContent.includes("6-10")`);
      const second = await page();
      await wc.executeJavaScript(`document.querySelector("#agents .agent-calls")?.scrollIntoView({ block: "center" })`);
      await sleep(200);
      await capture("settings-agent-calls", wc);
      await wc.executeJavaScript(`document.querySelector('#agents .agent-log-filters [role="switch"]')?.click()`);
      await poll(wc, `document.querySelector("#agents .pager")?.textContent.includes("1-2 of 2") || document.querySelectorAll("#agents .agent-calls .list-row").length === 2`);
      const problems = await page();
      check(
        "settings agent calls: the latest 5 with a pager (Next shows 6-10), and Only problems starts again at the first page",
        first.rows === 5 && first.pager.includes(`1-5 of ${SEEDED_CALLS}`) && second.rows === 5 && second.pager.includes(`6-10 of ${SEEDED_CALLS}`) && second.first !== first.first && problems.rows === 2,
        { first, second, problems },
      );
      close();
    }

    // "What the agent remembers about you": the styled field grows, Add stays beside it, Enter adds.
    {
      const { wc, close } = await openSettings(win, "command-agent");
      await poll(wc, `document.querySelector("[data-user-memory] input")`);
      const layout = async (): Promise<{ styled: boolean; sameRow: boolean; wider: boolean }> =>
        (await wc.executeJavaScript(`(() => {
          const input = document.querySelector("[data-user-memory] input");
          const button = input?.nextElementSibling;
          const a = input?.getBoundingClientRect();
          const b = button?.getBoundingClientRect();
          return {
            styled: Boolean(input?.classList.contains("input")),
            sameRow: Boolean(a && b && b.top < a.bottom && b.bottom > a.top && b.left >= a.right),
            wider: Boolean(a && b && a.width > b.width * 2),
          };
        })()`)) as { styled: boolean; sameRow: boolean; wider: boolean };
      const wide = await layout();
      let medium = wide;
      await narrowWindow(
        win.win,
        async () => {
          await wc.executeJavaScript(`document.querySelector("[data-user-memory]")?.scrollIntoView({ block: "center" })`);
          await sleep(200);
          medium = await layout();
          await capture("settings-user-memory-medium", wc);
        },
        MEDIUM_WIDTH,
      );
      await wc.executeJavaScript(`(() => {
        const input = document.querySelector("[data-user-memory] input");
        input.focus();
        document.execCommand("insertText", false, "Window seat");
      })()`);
      wc.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
      wc.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
      const added = await poll(wc, `[...document.querySelectorAll("[data-user-memory] li")].some((li) => li.textContent.includes("Window seat"))`);
      await wc.executeJavaScript(`document.querySelector("[data-user-memory]")?.scrollIntoView({ block: "center" })`);
      await sleep(200);
      await capture("settings-user-memory", wc);
      check("settings user memory: a styled field with Add beside it (wide and medium); Enter adds the note", wide.styled && wide.sameRow && wide.wider && medium.sameRow && added, { wide, medium, added });
      close();
    }
  } catch (err) {
    check("settings layout", false, (err as Error).stack ?? String(err));
  } finally {
    ctx.sync.networkInterfaces = realInterfaces;
    if ((await ctx.sync.status(profile)).enabled) await ctx.sync.disable(profile);
    ctx.mcp.audit.clear();
    profile.userMemory.clear();
    ctx.settings.update({
      appearance: { language: before.appearance.language, homePage: before.appearance.homePage },
      dictation: { enabled: before.dictation.enabled },
      ai: { provider: before.ai.provider },
    });
  }
}
