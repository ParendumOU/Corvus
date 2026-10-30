import crypto from "node:crypto";
import path from "node:path";
import { clipboard } from "electron";
import type { ProfileId } from "@corvus/shared";
import { downloadAiTask } from "../shared/download-ai";
import { buildPackages, downloadLinksIn, mergePackages, type GrabbedPackage } from "../shared/link-grabber";
import type { AppContext } from "./context";
import { JsonFile } from "./json-file";
import type { ProfileRuntime } from "./profiles";
import { pageOf } from "./tab-page";
import type { BrowserWindowCtl } from "./window";

const CLIPBOARD_POLL_MS = 1500;
const MAX_PACKAGES = 500;
const MAX_LINKS_PER_GRAB = 2000;

/** Runs in the page (isolated world): the links and text of the selection. */
const COLLECT_SELECTION = `(() => {
  const sel = getSelection();
  if (!sel || sel.rangeCount === 0) return { links: [], text: '' };
  const links = [];
  for (let i = 0; i < sel.rangeCount; i++) {
    const range = sel.getRangeAt(i);
    const root = range.commonAncestorContainer.nodeType === 1 ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement;
    const own = root && root.closest ? root.closest('a[href]') : null;
    if (own) links.push(own.href);
    if (root) for (const a of root.querySelectorAll('a[href]')) if (sel.containsNode(a, true)) links.push(a.href);
  }
  return { links: links.filter((h) => /^https?:/i.test(h)).slice(0, ${MAX_LINKS_PER_GRAB}), text: String(sel).slice(0, 200000) };
})()`;

/** Runs in the page (isolated world): every link's address, and the page text for passwords. */
const COLLECT_LINKS = `(() => {
  const links = Array.from(document.querySelectorAll('a[href]'), (a) => a.href).filter((h) => /^https?:/i.test(h)).slice(0, ${MAX_LINKS_PER_GRAB});
  return { links, text: (document.body ? document.body.innerText : '').slice(0, 200000) };
})()`;

function revive(raw: unknown): GrabbedPackage[] {
  return Array.isArray(raw) ? (raw.filter((p) => p && typeof p === "object" && Array.isArray((p as GrabbedPackage).links)) as GrabbedPackage[]) : [];
}

/**
 * The link grabber of each profile: packages of download links collected from pages and copied
 * text, waiting for the user to pick what to download. With the setting on, it also watches the
 * clipboard and offers the download links of copied text in a toolbar chip.
 */
export class LinkGrabber {
  private readonly files = new Map<ProfileId, JsonFile<GrabbedPackage[]>>();
  private timer: NodeJS.Timeout | null = null;
  private lastClip: string | null = null;
  /** Download links in what was last copied, until they are grabbed or dismissed. */
  private copied: { text: string; links: string[] } | null = null;

  constructor(private readonly ctx: AppContext) {}

  private file(runtime: ProfileRuntime): JsonFile<GrabbedPackage[]> {
    let file = this.files.get(runtime.profile.id);
    if (!file) {
      file = JsonFile.load(path.join(runtime.dataDir, "link-grabber.json"), () => [], revive, 500);
      this.files.set(runtime.profile.id, file);
    }
    return file;
  }

  list(runtime: ProfileRuntime): GrabbedPackage[] {
    return this.file(runtime).get();
  }

  private add(runtime: ProfileRuntime, urls: string[], source: string, text: string, name = ""): number {
    const file = this.file(runtime);
    const before = file.get();
    const built = buildPackages(urls, { source, text, now: Date.now(), newId: () => crypto.randomUUID() });
    // A name the person gave: all the links go in one package of that name (its folder).
    const named = name.replace(/\s+/g, " ").trim().slice(0, 120);
    const added =
      named && built.length > 0
        ? [{ ...built[0]!, name: named, links: built.flatMap((p) => p.links), passwords: [...new Set(built.flatMap((p) => p.passwords))] }]
        : built;
    const next = mergePackages(before, added).slice(-MAX_PACKAGES);
    const count = next.reduce((n, p) => n + p.links.length, 0) - before.reduce((n, p) => n + p.links.length, 0);
    if (count > 0) {
      file.set(next);
      this.changed(runtime);
    }
    return count;
  }

  /** Grabs the download links of a tab's page; returns how many new links were added. */
  async grabTab(win: BrowserWindowCtl, tabId?: string): Promise<number> {
    const tab = tabId ? win.getTab(tabId) : win.activeTab();
    const wc = pageOf(tab?.view);
    if (!tab || !wc || !/^https?:/i.test(tab.url)) return 0;
    // Null when the tab closes meanwhile.
    const page = (await wc.executeJavaScriptInIsolatedWorld(990, [{ code: COLLECT_LINKS }]).catch(() => null)) as { links?: unknown; text?: unknown } | null;
    const links = Array.isArray(page?.links) ? page.links.filter((l): l is string => typeof l === "string") : [];
    return this.add(win.profile, links, tab.url, typeof page?.text === "string" ? page.text : "");
  }

  /**
   * The download links in the page's selection (links and addresses written in it) go to the
   * grabber; returns how many new links were added.
   */
  async grabSelection(win: BrowserWindowCtl, tabId: string): Promise<number> {
    const tab = win.getTab(tabId);
    const wc = pageOf(tab?.view);
    if (!tab || !wc) return 0;
    const picked = (await wc.executeJavaScriptInIsolatedWorld(990, [{ code: COLLECT_SELECTION }]).catch(() => null)) as { links?: unknown; text?: unknown } | null;
    const text = typeof picked?.text === "string" ? picked.text : "";
    const links = Array.isArray(picked?.links) ? picked.links.filter((l): l is string => typeof l === "string") : [];
    return this.add(win.profile, [...links, ...downloadLinksIn(text)], tab.url, text);
  }

  /**
   * Links the person picked (a link's menu, the toolbar offer): straight to the download queue,
   * which finds the file behind a file host's page (or any page) in the background.
   */
  queueLinks(win: BrowserWindowCtl, urls: readonly string[], source: string, text = ""): number {
    const packages = buildPackages(urls, { source, text, now: Date.now(), newId: () => crypto.randomUUID(), all: true });
    return this.ctx.queue.addGrabbed(win.profile, packages);
  }

  /** Grabs the download links of pasted or copied text; with a name, as one package of that name. */
  addText(runtime: ProfileRuntime, text: string, source = "clipboard", name = ""): number {
    return this.add(runtime, downloadLinksIn(text), source, text, name);
  }

  /** Renames a package before it is downloaded (the name of its folder). */
  rename(runtime: ProfileRuntime, id: string, name: string): void {
    const clean = name.replace(/\s+/g, " ").trim().slice(0, 120);
    if (!clean) return;
    const file = this.file(runtime);
    file.set(file.get().map((p) => (p.id === id ? { ...p, name: clean } : p)));
    this.changed(runtime);
  }

  /** Removes packages or single links by id. */
  remove(runtime: ProfileRuntime, ids: readonly string[]): void {
    const drop = new Set(ids);
    const file = this.file(runtime);
    const next = file
      .get()
      .filter((p) => !drop.has(p.id))
      .map((p) => ({ ...p, links: p.links.filter((l) => !drop.has(l.id)) }))
      .filter((p) => p.links.length > 0);
    file.set(next);
    this.changed(runtime);
  }

  clear(runtime: ProfileRuntime): void {
    this.file(runtime).set([]);
    this.changed(runtime);
  }

  /**
   * Starts the chosen packages or links and takes them out of the grabber: all of them go to the
   * download queue, which finds the file behind each file host's page in the background.
   */
  download(win: BrowserWindowCtl, ids: readonly string[]): number {
    const pick = new Set(ids);
    const chosen: GrabbedPackage[] = [];
    for (const pkg of this.list(win.profile)) {
      const links = pkg.links.filter((l) => pick.has(pkg.id) || pick.has(l.id));
      if (links.length > 0) chosen.push({ ...pkg, links });
    }
    const started = this.ctx.queue.addGrabbed(win.profile, chosen);
    if (chosen.length > 0) this.remove(win.profile, ids);
    return started;
  }

  /**
   * "Download with AI": Corvus's agent goes through these packages' or links' pages (file hosts,
   * mirrors), finds the real files and queues them after the person approves the list. They leave
   * the grabber once the run starts. Without a model set up, the Command Bar says why and nothing
   * is taken out.
   */
  downloadWithAi(win: BrowserWindowCtl, ids: readonly string[]): boolean {
    const pick = new Set(ids);
    const chosen = this.list(win.profile)
      .map((pkg) => ({ pkg, links: pkg.links.filter((l) => pick.has(pkg.id) || pick.has(l.id)) }))
      .filter((c) => c.links.length > 0);
    if (chosen.length === 0) return false;
    const task = downloadAiTask({
      links: chosen.flatMap((c) => c.links.map((l) => l.url)),
      passwords: [...new Set(chosen.flatMap((c) => c.pkg.passwords))],
      ...(chosen.length === 1 ? { packageName: chosen[0]!.pkg.name } : {}),
    });
    return this.startAi(win, task, () => this.remove(win.profile, ids));
  }

  /** "Download with AI" on the copied-links chip. */
  downloadCopiedWithAi(win: BrowserWindowCtl): boolean {
    const copied = this.copied;
    if (!copied) return false;
    return this.startAi(win, downloadAiTask({ text: copied.text }), () => {
      this.copied = null;
      this.pushChrome();
    });
  }

  /** "Download with AI" on a tab: the agent works out what the page offers. */
  downloadPageWithAi(win: BrowserWindowCtl, tabId: string): boolean {
    const tab = win.getTab(tabId);
    if (!tab || !/^https?:/i.test(tab.url)) return false;
    return this.startAi(win, downloadAiTask({ pageUrl: tab.url }), () => undefined);
  }

  private startAi(win: BrowserWindowCtl, task: string, started: () => void): boolean {
    const ready = this.ctx.agentRunner.unavailableReason() === null;
    this.ctx.agentRunner.startVisible(win, task);
    if (ready) started();
    return ready;
  }

  /** How many download links the copied text has (the toolbar chip), 0 when none. */
  copiedLinks(): number {
    return this.copied?.links.length ?? 0;
  }

  /** "Download" on the chip: the copied links go straight to the queue. */
  queueCopied(win: BrowserWindowCtl): number {
    const copied = this.copied;
    this.copied = null;
    this.pushChrome();
    if (!copied) return 0;
    const count = this.queueLinks(win, copied.links, "clipboard", copied.text);
    win.openSingleton("corvus://downloads/");
    return count;
  }

  /** The chip was clicked: the copied links go to the grabber, which opens. */
  grabCopied(win: BrowserWindowCtl): number {
    const copied = this.copied;
    this.copied = null;
    this.pushChrome();
    const count = copied ? this.add(win.profile, copied.links, "clipboard", copied.text) : 0;
    win.openSingleton("corvus://downloads/#grabber");
    return count;
  }

  dismissCopied(): void {
    this.copied = null;
    this.pushChrome();
  }

  /** Watch the clipboard while the setting is on (and follow the setting). */
  start(): void {
    const apply = (): void => {
      const on = this.ctx.settings.get().downloads.watchClipboard;
      if (on && !this.timer) {
        this.timer = setInterval(() => void this.pollClipboard(), CLIPBOARD_POLL_MS);
        this.timer.unref();
      } else if (!on && this.timer) {
        clearInterval(this.timer);
        this.timer = null;
        this.lastClip = null;
        this.dismissCopied();
      }
    };
    apply();
    this.ctx.settings.onChange(apply);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const file of this.files.values()) file.flush();
  }

  /** One look at the clipboard; only text copied after watching started counts. */
  async pollClipboard(): Promise<void> {
    const text = String(await clipboard.readText()).slice(0, 100_000);
    if (this.lastClip === null) {
      this.lastClip = text;
      return;
    }
    if (text === this.lastClip) return;
    this.lastClip = text;
    const links = downloadLinksIn(text);
    this.copied = links.length > 0 ? { text, links } : null;
    this.pushChrome();
  }

  private pushChrome(): void {
    for (const w of this.ctx.windows.all()) w.pushState();
  }

  private changed(runtime: ProfileRuntime): void {
    for (const w of this.ctx.windows.forProfile(runtime.profile.id)) w.notifyInternalPages({ type: "downloads-changed" }, ["downloads"]);
  }

  flush(): void {
    for (const file of this.files.values()) file.flush();
  }
}
