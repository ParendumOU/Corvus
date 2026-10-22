import type { WebContents } from "electron";
import { originKeyOf } from "../shared/credentials";
import type { AppContext } from "./context";
import type { BrowserWindowCtl } from "./window";

interface SmokeCtx {
  url: string;
  win: BrowserWindowCtl;
  check: (name: string, ok: boolean, detail?: unknown) => void;
  capture: (name: string, wc: WebContents) => Promise<void>;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function poll(fn: () => boolean, tries = 40): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    if (fn()) return true;
    await delay(150);
  }
  return fn();
}

/**
 * Drives the password manager end to end headlessly: a seeded login is detected and filled on a login
 * page, then a changed password submitted through the form is captured and saved on the vault.
 */
export async function runCredentialsSmoke(ctx: AppContext, { url, win, check, capture }: SmokeCtx): Promise<void> {
  const base = url.replace(/\/$/, "");
  const origin = originKeyOf(base);
  const vault = win.profile.credentials;
  const seeded = vault.add({ origin, username: "alice", password: "s3cret-pw" });
  check("vault add", vault.get(seeded.id)?.password === "s3cret-pw");

  const tab = win.createTab(`${base}/login`);
  const wc = tab.view.webContents;
  await poll(() => !wc.isDestroyed() && wc.getURL().includes("/login") && !tab.loading);
  await delay(200);

  const detected = await poll(() => ctx.autofill.stateFor(win).available);
  check("autofill detects login form with a saved match", detected, ctx.autofill.stateFor(win));

  await ctx.autofill.fill(win, seeded.id);
  await delay(150);
  const filled = await wc.executeJavaScript(`document.getElementById("u").value + "/" + document.getElementById("p").value`);
  check("autofill fills username and password", filled === "alice/s3cret-pw", filled);
  await capture("passwords-login", wc);

  // Type a new password and submit the form (GET navigation) so it is captured for saving.
  await wc.executeJavaScript(`(() => {
    const p = document.getElementById("p");
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    set.call(p, "rotated-pw");
    p.dispatchEvent(new Event("input", { bubbles: true }));
    document.querySelector("form").requestSubmit();
    return true;
  })()`);

  const canSave = await poll(() => ctx.autofill.stateFor(win).canSave);
  check("autofill offers to save a submitted login", canSave, ctx.autofill.stateFor(win));

  ctx.autofill.acceptSave(win);
  const saved = await poll(() => vault.get(seeded.id)?.password === "rotated-pw");
  check("autofill save updates the stored password", saved, vault.get(seeded.id)?.password);

  // Management page renders and lists the login.
  const page = win.createTab("corvus://passwords");
  await delay(1200);
  const shown = await page.view.webContents.executeJavaScript(
    `Boolean(window.corvusInternal) && document.querySelector(".list-row") && document.body.innerText.includes("alice")`,
  );
  check("corvus://passwords lists saved logins", shown === true, shown);
  await capture("passwords", page.view.webContents);
}
