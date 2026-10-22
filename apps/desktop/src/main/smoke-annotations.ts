import type { WebContents } from "electron";
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

async function poll(fn: () => boolean | Promise<boolean>, tries = 40): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    if (await fn()) return true;
    await delay(150);
  }
  return fn();
}

/**
 * Drives page annotations headlessly: a seeded highlight (anchored to text that exists on the page)
 * is re-anchored and rendered on revisit while an orphaned one is skipped; the manager page lists it
 * grouped by page; deleting it live-clears the in-page highlight.
 */
export async function runAnnotationsSmoke(ctx: AppContext, { url, win, check, capture }: SmokeCtx): Promise<void> {
  const store = win.profile.annotations;
  const matching = store.add({
    url,
    pageTitle: "Smoke",
    color: "yellow",
    note: "a highlighted phrase",
    anchor: { quote: "Hello from the smoke test.", prefix: "", suffix: "" },
  });
  const orphan = store.add({
    url,
    pageTitle: "Smoke",
    color: "green",
    note: "",
    anchor: { quote: "this text is not on the page at all", prefix: "", suffix: "" },
  });
  check("annotation store add", Boolean(matching && orphan) && store.forUrl(url).length === 2, store.forUrl(url).length);

  const tab = win.createTab(url);
  const wc = tab.view.webContents;
  await poll(() => !wc.isDestroyed() && wc.getURL().startsWith(url.replace(/\/$/, "")) && !tab.loading);
  await delay(300);

  const applied = await poll(async () => (await wc.executeJavaScript("document.documentElement.getAttribute('data-corvus-annotated')")) === "1");
  const appliedCount = await wc.executeJavaScript("document.documentElement.getAttribute('data-corvus-annotated')");
  check("saved highlight re-anchors on revisit, orphan skipped", applied && appliedCount === "1", appliedCount);
  await capture("annotations-page", wc);

  const manager = win.createTab("corvus://annotations");
  await delay(1200);
  const listed = await manager.view.webContents.executeJavaScript(
    `Boolean(window.corvusInternal) && Boolean(document.querySelector(".anno-quote")) && document.body.innerText.includes("Hello from the smoke test")`,
  );
  check("corvus://annotations lists the highlight", listed === true, listed);
  await capture("annotations", manager.view.webContents);

  store.remove(matching!.id);
  const cleared = await poll(async () => (await wc.executeJavaScript("document.documentElement.getAttribute('data-corvus-annotated')")) === "0");
  check("deleting an annotation live-clears its highlight", cleared, await wc.executeJavaScript("document.documentElement.getAttribute('data-corvus-annotated')"));

  store.remove(orphan!.id);
}
