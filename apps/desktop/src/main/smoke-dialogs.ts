import type { WebContents } from "electron";
import type { AppContext } from "./context";
import type { BrowserWindowCtl } from "./window";

interface DialogsSmokeHelpers {
  url: string;
  win: BrowserWindowCtl;
  check: (name: string, ok: boolean, detail?: unknown) => void;
  capture: (name: string, wc: WebContents) => Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function poll(wc: WebContents, expr: string, timeoutMs = 6000): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if ((await wc.executeJavaScript(`Boolean(${expr})`).catch(() => false)) === true) return true;
    await sleep(100);
  }
  return false;
}

/**
 * Corvus's own dialogs: a page's confirm() shows as Corvus's modal in the window (named
 * after the page) and the answer goes back to the page; a question from Corvus itself (here, from
 * the main process) shows the same way, and Escape picks its cancel button.
 */
export async function runDialogsSmoke(ctx: AppContext, h: DialogsSmokeHelpers): Promise<void> {
  const { url, win, check, capture } = h;
  const chrome = win.chrome.webContents;
  const tab = win.createTab(`${url}ux-plain?dialogs`, { activate: true });
  const page = tab.view.webContents;
  try {
    await poll(page, "document.readyState === 'complete'");

    // confirm(): the modal, then OK.
    await page.executeJavaScript("setTimeout(() => { window.__answer = confirm('Delete this note?'); }, 0); true");
    const shown = await poll(chrome, "document.querySelector('.dialog-card') && document.querySelector('.dialog-card').innerText.includes('Delete this note?')");
    const origin = (await chrome.executeJavaScript("document.querySelector('.dialog-origin')?.innerText ?? ''")) as string;
    check("dialogs: a page's confirm() shows as Corvus's modal, named after the page", shown && (origin.includes("corvus-smoke.test") || origin.includes("127.0.0.1")), { shown, origin, state: win.state().dialog });
    await capture("dialog-confirm", chrome);
    await chrome.executeJavaScript("document.querySelector('[data-dialog-button=\"1\"]')?.click()");
    const accepted = await poll(page, "window.__answer === true");
    check("dialogs: OK in the modal answers the page's confirm()", accepted && win.state().dialog === null);

    // A question from Corvus itself; Escape cancels it.
    const asked = ctx.dialogs.ask({ tone: "danger", title: "Delete it?", message: "Delete it?", buttons: ["Cancel", "Delete"], defaultId: 0, cancelId: 0, dangerId: 1 }, win);
    await poll(chrome, "document.querySelector('.dialog-card .btn.danger-solid')");
    await chrome.executeJavaScript("document.querySelector('.dialog-card').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
    const answer = await Promise.race([asked, sleep(4000).then(() => null)]);
    check("dialogs: Corvus's own question shows the same modal and Escape picks Cancel", answer?.button === 0, answer);

    // History: Clear history… asks in a modal with a time range and a site, and counts first.
    const history = win.createTab("corvus://history/", { activate: true });
    const hw = history.view.webContents;
    try {
      await poll(hw, "[...document.querySelectorAll('button')].some((b) => b.innerText.includes('Clear history'))");
      await hw.executeJavaScript("[...document.querySelectorAll('button')].find((b) => b.innerText.includes('Clear history'))?.click()");
      const modal = await poll(hw, "document.querySelector('.modal-card .history-ranges button.on')");
      await hw.executeJavaScript("(() => { const el = document.querySelector('.modal-card input.input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, 'nothing.invalid'); el.dispatchEvent(new Event('input', { bubbles: true })); })()");
      const counted = await poll(hw, "document.querySelector('.modal-foot .muted')?.innerText.startsWith('0 ') && document.querySelector('.modal-foot .btn.danger-solid')?.disabled === true");
      await capture("history-clear", hw);
      await hw.executeJavaScript("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))");
      const closed = await poll(hw, "!document.querySelector('.modal-card')");
      check("history: Clear history… asks for a range and a site, counts the pages first, and Escape closes it", modal && counted && closed, { modal, counted, closed });
    } finally {
      win.closeTab(history.id);
    }
  } finally {
    win.closeTab(tab.id);
  }
}
