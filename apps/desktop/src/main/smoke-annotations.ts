import type http from "node:http";
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

/** Polls every 150 ms, up to about 15 s by default: a busy machine is slow, and a check that holds returns at once. */
async function poll(fn: () => boolean | Promise<boolean>, tries = 100): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    if (await fn()) return true;
    await delay(150);
  }
  return fn();
}

/** The first value of `fn` that is not null, polled like poll(); null when none came. */
async function pollValue<T>(fn: () => Promise<T | null>, tries = 100): Promise<T | null> {
  for (let i = 0; i < tries; i++) {
    const value = await fn();
    if (value !== null) return value;
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
  const listed = await poll(async () =>
    manager.view.webContents
      .executeJavaScript(`Boolean(window.corvusInternal) && Boolean(document.querySelector(".anno-quote")) && document.body.innerText.includes("Hello from the smoke test")`)
      .then((v) => v === true, () => false),
  );
  check("corvus://annotations lists the highlight", listed, listed);
  await capture("annotations", manager.view.webContents);

  store.remove(matching!.id);
  const cleared = await poll(async () => (await wc.executeJavaScript("document.documentElement.getAttribute('data-corvus-annotated')")) === "0");
  check("deleting an annotation live-clears its highlight", cleared, await wc.executeJavaScript("document.documentElement.getAttribute('data-corvus-annotated')"));

  store.remove(orphan!.id);

  await runToolbarSmoke(url, win, check, capture);
}

/** A page whose Content-Security-Policy refuses style elements, as many sites and local tools do. */
const CSP_PAGE = `<!doctype html><html><head><title>Strict page</title></head><body>
<p style="margin:260px 40px 0;font:20px sans-serif" id="quote">Ravens solve puzzles and remember faces.</p>
</body></html>`;

export function serveAnnotationsSmokeRoute(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  if ((req.url ?? "/").split("?")[0] !== "/annotations-csp") return false;
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": "default-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'",
  });
  res.end(CSP_PAGE);
  return true;
}

/** Where the yellow swatch's pixels are on the page (CSS px), or null when there are none. */
async function yellowBox(wc: WebContents): Promise<{ top: number; bottom: number; count: number } | null> {
  const image = await wc.capturePage();
  const { width, height } = image.getSize();
  const scale = width / Math.max(1, (await wc.executeJavaScript("innerWidth")) as number);
  const bitmap = image.toBitmap();
  const [r, g, b] = [0xff, 0xf1, 0x8c];
  let top = Infinity;
  let bottom = -1;
  let count = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (Math.abs((bitmap[i + 2] ?? 0) - r) < 6 && Math.abs((bitmap[i + 1] ?? 0) - g) < 6 && Math.abs((bitmap[i] ?? 0) - b) < 6) {
        count++;
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
    }
  }
  return count > 0 ? { top: top / scale, bottom: bottom / scale, count } : null;
}

/** Selects the page's quote with the mouse, as a person does (press, drag, release). */
async function dragSelect(wc: WebContents): Promise<{ top: number }> {
  const rect = (await wc.executeJavaScript(
    "(() => { const r = document.getElementById('quote').firstChild; const range = document.createRange(); range.selectNodeContents(r); const b = range.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, mid: b.top + b.height / 2 }; })()",
  )) as { left: number; right: number; top: number; mid: number };
  const y = Math.round(rect.mid);
  wc.sendInputEvent({ type: "mouseMove", x: Math.round(rect.left) + 1, y });
  wc.sendInputEvent({ type: "mouseDown", x: Math.round(rect.left) + 1, y, button: "left", clickCount: 1 });
  for (let x = Math.round(rect.left) + 20; x < rect.right; x += 40) wc.sendInputEvent({ type: "mouseMove", x, y, button: "left" });
  wc.sendInputEvent({ type: "mouseMove", x: Math.round(rect.right) - 1, y, button: "left" });
  wc.sendInputEvent({ type: "mouseUp", x: Math.round(rect.right) - 1, y, button: "left", clickCount: 1 });
  return { top: rect.top };
}

/**
 * The selection toolbar on a page whose CSP refuses style elements: styled and placed just above the
 * selection (it showed unstyled in the top-left corner), and not opened by an AI agent's selection.
 */
async function runToolbarSmoke(url: string, win: BrowserWindowCtl, check: SmokeCtx["check"], capture: SmokeCtx["capture"]): Promise<void> {
  const tab = win.createTab(`${url}annotations-csp`);
  const wc = tab.view.webContents;
  try {
    await poll(() => !wc.isDestroyed() && wc.getURL().endsWith("/annotations-csp") && !tab.loading);
    await delay(500);
    const { top } = await dragSelect(wc);
    const shown = await pollValue(() => yellowBox(wc));
    check(
      "selection toolbar styled under a strict CSP, just above the selection",
      shown !== null && shown.bottom < top && shown.top > top - 70 && shown.bottom - shown.top <= 24,
      { shown, selectionTop: top },
    );
    await capture("annotations-toolbar", wc);

    await wc.executeJavaScript("getSelection().removeAllRanges()");
    wc.sendInputEvent({ type: "mouseDown", x: 5, y: 5, button: "left", clickCount: 1 });
    wc.sendInputEvent({ type: "mouseUp", x: 5, y: 5, button: "left", clickCount: 1 });
    await delay(300);
    win.markAgent(tab.id);
    await delay(100);
    await dragSelect(wc);
    await delay(500);
    const forAgent = await yellowBox(wc);
    check("an AI agent's selection opens no toolbar", forAgent === null, forAgent);
  } finally {
    win.closeTab(tab.id);
  }
}
