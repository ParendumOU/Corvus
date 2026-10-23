/**
 * "page" data sources of custom New Tab widgets: a page loaded with the person's session (they
 * allowed that host for that widget), read for its title, the unread count sites put in it, and
 * optionally the text of a CSS selector. One hidden, muted view at a time; it never opens popups,
 * and each read is cached for the source's interval (at least MIN_PAGE_MINUTES).
 */
import { WebContentsView, type Session } from "electron";
import { MIN_PAGE_MINUTES } from "../shared/newtab";
import type { PageSnapshot } from "../shared/newtab-ipc";

const LOAD_TIMEOUT_MS = 25_000;
/** Single-page apps fill in their title and counters a moment after the load event. */
const SETTLE_MS = 3_500;
const MAX_TEXT = 4_000;

/** The unread count in a page title: "(3) Home / X", "Inbox (12) - me@mail", "(99+) Instagram". */
export function titleCount(title: string): number | null {
  const m = /^\s*\((\d{1,6})\+?\)/.exec(title) ?? /\((\d{1,6})\+?\)/.exec(title);
  return m ? Number(m[1]) : null;
}

interface Pending {
  session: Session;
  url: string;
  select: string;
  resolve: (snap: PageSnapshot) => void;
  reject: (err: Error) => void;
}

export class PageSourceReader {
  private readonly cache = new Map<string, PageSnapshot>();
  private readonly queue: Pending[] = [];
  private busy = false;

  /** A fresh-enough snapshot from the cache, or a new read queued behind the others. */
  read(session: Session, url: string, select: string, everyMinutes: number, key: string): Promise<PageSnapshot> {
    const id = `${key}|${url}|${select}`;
    const hit = this.cache.get(id);
    if (hit && Date.now() - hit.checkedAt < Math.max(MIN_PAGE_MINUTES, everyMinutes) * 60_000) return Promise.resolve(hit);
    return new Promise<PageSnapshot>((resolve, reject) => {
      this.queue.push({ session, url, select, resolve, reject });
      void this.pump();
    }).then((snap) => {
      this.cache.set(id, snap);
      if (this.cache.size > 200) this.cache.delete(this.cache.keys().next().value!);
      return snap;
    });
  }

  private async pump(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      for (let job = this.queue.shift(); job; job = this.queue.shift()) {
        try {
          job.resolve(await this.load(job.session, job.url, job.select));
        } catch (err) {
          job.reject(err instanceof Error ? err : new Error(String(err)));
        }
      }
    } finally {
      this.busy = false;
    }
  }

  private async load(session: Session, url: string, select: string): Promise<PageSnapshot> {
    const view = new WebContentsView({
      webPreferences: { session, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, disableDialogs: true },
    });
    const wc = view.webContents;
    wc.setAudioMuted(true);
    wc.setWindowOpenHandler(() => ({ action: "deny" }));
    try {
      await Promise.race([
        wc.loadURL(url),
        new Promise((_, reject) => setTimeout(() => reject(new Error("The page took too long to load.")), LOAD_TIMEOUT_MS)),
      ]);
      await new Promise((r) => setTimeout(r, SETTLE_MS));
      // An isolated world, so the page's own scripts cannot change what Corvus reads.
      const read = (await wc.executeJavaScriptInIsolatedWorld(999, [
        {
          code: `(() => {
            const sel = ${JSON.stringify(select)};
            let text = "";
            if (sel) {
              try { text = [...document.querySelectorAll(sel)].map((el) => el.innerText.trim()).filter(Boolean).join("\\n"); } catch { text = ""; }
            }
            return { title: document.title, text: text.slice(0, ${MAX_TEXT}) };
          })()`,
        },
      ])) as { title: string; text: string };
      const title = String(read.title ?? "").slice(0, 300);
      return { url: wc.getURL() || url, title, count: titleCount(title), text: String(read.text ?? ""), checkedAt: Date.now() };
    } finally {
      wc.close();
    }
  }
}
