import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  Bookmark,
  BrowserController,
  CookieInfo,
  CredentialFillResult,
  DownloadEntry,
  GroupColor,
  GroupId,
  HistoryEntry,
  PageSnapshot,
  Tab,
  TabGroup,
  TabId,
} from "@corvus/shared";
import type { WebContents } from "electron";
import { OTHER_FOLDER_ID } from "../shared/bookmark-tree";
import { isExecutableFilename, uniqueFilename } from "../shared/downloads";
import { isAgentAllowedUrl } from "../shared/internal-urls";
import { classifyOmnibox, intentToUrl } from "../shared/omnibox";
import { GROUP_COLORS } from "../shared/tab-strip";
import type { AppContext } from "./context";
import {
  AGENT_WORLD_ID,
  clickScript,
  focusForTypingScript,
  locateScript,
  scrollScript,
  setValueScript,
  snapshotScript,
  type RawSnapshot,
} from "./page-scripts";
import type { BrowserWindowCtl, TabRuntime } from "./window";

const LOAD_TIMEOUT_MS = 15_000;
const EVALUATE_TIMEOUT_MS = 10_000;
const DEFAULT_SNAPSHOT_CHARS = 8_000;
const REF_RE = /^e\d{1,7}$/;
const COOKIE_LIMIT = 500;
const DOWNLOAD_MAX_BYTES = 50 * 1024 * 1024;
const DOWNLOAD_HARD_MAX = 500 * 1024 * 1024;

export class AgentError extends Error {}

/** Best-effort file name for a fetched download: Content-Disposition, then the URL path, then a default. */
function downloadFilename(url: string, disposition: string | null): string {
  const match = disposition ? /filename\*?=(?:UTF-8''|")?([^";]+)/i.exec(disposition) : null;
  if (match?.[1]) {
    const raw = match[1].trim().replace(/"$/, "");
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  try {
    const last = new URL(url).pathname.split("/").filter(Boolean).pop();
    if (last) return last;
  } catch {
    // fall through
  }
  return "download";
}

function waitForLoad(wc: WebContents, timeoutMs = LOAD_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve) => {
    if (wc.isDestroyed()) return resolve();
    let started = wc.isLoading();
    const done = (): void => {
      clearTimeout(timer);
      wc.off("did-start-loading", onStart);
      wc.off("did-stop-loading", onStop);
      wc.off("destroyed", done);
      resolve();
    };
    const onStart = (): void => {
      started = true;
    };
    const onStop = (): void => {
      if (started) done();
    };
    const timer = setTimeout(done, timeoutMs);
    wc.on("did-start-loading", onStart);
    wc.on("did-stop-loading", onStop);
    wc.once("destroyed", done);
    // Navigation already finished (or never started) by the time we got here.
    setTimeout(() => {
      if (!wc.isDestroyed() && !wc.isLoading()) done();
    }, 250);
  });
}

function timeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new AgentError(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new AgentError(String(err)));
      },
    );
  });
}

/** BrowserController for MCP agents. Every tab an agent touches is flagged agentControlled. */
export class Controller implements BrowserController {
  constructor(private readonly ctx: AppContext) {}

  private locate(id: TabId): { window: BrowserWindowCtl; tab: TabRuntime } {
    const found = this.ctx.windows.findTab(id);
    if (!found) throw new AgentError(`Unknown tab ${id}`);
    return found;
  }

  private agentUrl(input: string): string {
    const url = intentToUrl(classifyOmnibox(input));
    if (!isAgentAllowedUrl(url)) throw new AgentError(`Agents may not open ${url}`);
    return url;
  }

  private readable(id: TabId): { window: BrowserWindowCtl; tab: TabRuntime; wc: WebContents } {
    const found = this.locate(id);
    const wc = found.tab.view.webContents;
    if (wc.isDestroyed()) throw new AgentError(`Tab ${id} is closed`);
    if (!isAgentAllowedUrl(wc.getURL() || found.tab.url)) throw new AgentError("Agents cannot access this page");
    return { ...found, wc };
  }

  private touch(window: BrowserWindowCtl, id: TabId): void {
    window.markAgent(id);
  }

  private exec<T>(wc: WebContents, code: string): Promise<T> {
    return timeout(wc.executeJavaScriptInIsolatedWorld(AGENT_WORLD_ID, [{ code }]) as Promise<T>, EVALUATE_TIMEOUT_MS, "Page script timed out");
  }

  private isForeground(window: BrowserWindowCtl, id: TabId): boolean {
    return window.activeTab()?.id === id && window.win.isVisible() && !window.win.isMinimized();
  }

  private validRef(ref: string): string {
    if (!REF_RE.test(ref)) throw new AgentError(`Invalid element ref "${ref}"; use refs from page_snapshot`);
    return ref;
  }

  async listTabs(): Promise<Tab[]> {
    return this.ctx.windows.all().flatMap((w) => w.listTabs());
  }

  async listGroups(): Promise<TabGroup[]> {
    return this.ctx.windows.all().flatMap((w) => w.listGroups());
  }

  async openTab(url: string, opts: { background?: boolean; groupId?: GroupId; agent?: boolean } = {}): Promise<Tab> {
    const target = this.agentUrl(url);
    const window = (opts.groupId ? this.ctx.windows.all().find((w) => w.hasGroup(opts.groupId as GroupId)) : undefined) ?? this.ctx.windows.target();
    const groupId = opts.groupId && window.hasGroup(opts.groupId) ? opts.groupId : undefined;
    const tab = window.createTab(target, { activate: opts.background !== true, agent: opts.agent ?? true, ...(groupId ? { groupId } : {}) });
    await waitForLoad(tab.view.webContents);
    return window.toTab(tab);
  }

  async closeTab(id: TabId): Promise<void> {
    const { window } = this.locate(id);
    window.closeTab(id);
  }

  async activateTab(id: TabId): Promise<void> {
    const { window } = this.locate(id);
    window.activate(id);
  }

  async navigate(id: TabId, url: string): Promise<Tab> {
    const target = this.agentUrl(url);
    const { window, tab } = this.locate(id);
    this.touch(window, id);
    await this.ctx.agents.beforeAction(window, id, tab.view.webContents, { kind: "navigate", url: target });
    window.loadUrl(id, target);
    await waitForLoad(tab.view.webContents);
    return window.toTab(tab);
  }

  async goBack(id: TabId): Promise<void> {
    const { window, tab } = this.locate(id);
    this.touch(window, id);
    window.goBack(id);
    await waitForLoad(tab.view.webContents);
  }

  async goForward(id: TabId): Promise<void> {
    const { window, tab } = this.locate(id);
    this.touch(window, id);
    window.goForward(id);
    await waitForLoad(tab.view.webContents);
  }

  async reload(id: TabId): Promise<void> {
    const { window, tab } = this.locate(id);
    this.touch(window, id);
    window.reload(id);
    await waitForLoad(tab.view.webContents);
  }

  async createGroup(tabIds: TabId[], opts: { title?: string; color?: GroupColor } = {}): Promise<TabGroup> {
    const first = tabIds[0];
    if (!first) throw new AgentError("createGroup needs at least one tab");
    const { window } = this.locate(first);
    const ids = tabIds.filter((id) => window.hasTab(id));
    const color = opts.color && GROUP_COLORS.includes(opts.color) ? opts.color : undefined;
    const group = window.createGroup(ids, { ...(opts.title !== undefined ? { title: opts.title } : {}), ...(color ? { color } : {}) });
    if (!group) throw new AgentError("Could not create the group");
    return group;
  }

  async ungroup(tabIds: TabId[]): Promise<void> {
    for (const window of this.ctx.windows.all()) {
      const ids = tabIds.filter((id) => window.hasTab(id));
      if (ids.length > 0) window.ungroupTabs(ids);
    }
  }

  async snapshot(id: TabId, opts: { maxChars?: number } = {}): Promise<PageSnapshot> {
    const { window, wc } = this.readable(id);
    this.touch(window, id);
    await this.ctx.agents.beforeAction(window, id, wc, { kind: "read" });
    const raw = await this.exec<RawSnapshot>(wc, snapshotScript(opts.maxChars ?? DEFAULT_SNAPSHOT_CHARS));
    return { tabId: id, url: raw.url, title: raw.title, text: raw.text, elements: raw.elements, truncated: raw.truncated };
  }

  async click(id: TabId, ref: string): Promise<void> {
    const { window, wc } = this.readable(id);
    this.validRef(ref);
    this.touch(window, id);
    await this.ctx.agents.beforeAction(window, id, wc, { kind: "click", ref });
    if (this.isForeground(window, id)) {
      const point = await this.exec<{ x: number; y: number; w: number; h: number } | null>(wc, locateScript(ref));
      if (!point) throw new AgentError(`Element ${ref} not found; take a new page_snapshot`);
      if (point.x >= 0 && point.y >= 0 && point.x <= point.w && point.y <= point.h) {
        const zoom = wc.getZoomFactor();
        const x = Math.round(point.x * zoom);
        const y = Math.round(point.y * zoom);
        wc.sendInputEvent({ type: "mouseMove", x, y });
        wc.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
        wc.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
        return;
      }
    }
    const clicked = await this.exec<boolean>(wc, clickScript(ref));
    if (!clicked) throw new AgentError(`Element ${ref} not found; take a new page_snapshot`);
  }

  async type(id: TabId, ref: string, text: string, opts: { submit?: boolean } = {}): Promise<void> {
    const { window, wc } = this.readable(id);
    this.validRef(ref);
    this.touch(window, id);
    await this.ctx.agents.beforeAction(window, id, wc, { kind: "type", ref, text });
    const submit = opts.submit === true;
    if (this.isForeground(window, id)) {
      const mode = await this.exec<string | null>(wc, focusForTypingScript(ref));
      if (mode === null) throw new AgentError(`Element ${ref} not found; take a new page_snapshot`);
      if (mode === "input" || mode === "editable") {
        await wc.insertText(text);
        if (submit) {
          wc.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
          wc.sendInputEvent({ type: "char", keyCode: "\r" });
          wc.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
        }
        return;
      }
    }
    const ok = await this.exec<boolean>(wc, setValueScript(ref, text, submit));
    if (!ok) throw new AgentError(`Element ${ref} is not a text field`);
  }

  async scroll(id: TabId, direction: "up" | "down", amount?: number): Promise<void> {
    const { window, wc } = this.readable(id);
    this.touch(window, id);
    await this.ctx.agents.beforeAction(window, id, wc, { kind: "scroll", direction: direction === "up" ? "up" : "down" });
    await this.exec(wc, scrollScript(direction === "up" ? "up" : "down", amount));
  }

  async screenshot(id: TabId): Promise<{ mimeType: "image/png"; base64: string }> {
    const { window, wc } = this.readable(id);
    this.touch(window, id);
    await this.ctx.agents.beforeAction(window, id, wc, { kind: "screenshot" });
    const image = await wc.capturePage(undefined, { stayHidden: true });
    if (image.isEmpty()) throw new AgentError("The tab has not been painted yet; activate it and retry");
    return { mimeType: "image/png", base64: image.toPNG().toString("base64") };
  }

  /** Script access is refused on a tab where Corvus filled a saved secret, until it navigates. */
  async secretFillLock(id: TabId): Promise<string | null> {
    return this.ctx.secretFills.check(id);
  }

  async evaluate(id: TabId, expression: string): Promise<unknown> {
    const locked = this.ctx.secretFills.check(id);
    if (locked) throw new AgentError(locked);
    if (!this.ctx.settings.get().mcp.allowEvaluate) throw new AgentError("JavaScript evaluation is disabled in Corvus settings");
    const { window, wc } = this.readable(id);
    this.touch(window, id);
    return timeout(wc.executeJavaScript(expression, true), EVALUATE_TIMEOUT_MS, "Evaluation timed out");
  }

  async listBookmarks(): Promise<Bookmark[]> {
    return this.ctx.windows.target().profile.bookmarks.list();
  }

  async addBookmark(b: Pick<Bookmark, "title" | "url" | "parentId">): Promise<Bookmark> {
    const url = b.url ? intentToUrl(classifyOmnibox(b.url)) : "";
    if (!/^https?:\/\//.test(url)) throw new AgentError("Bookmarks need an http(s) URL");
    const store = this.ctx.windows.target().profile.bookmarks;
    const parent = b.parentId && store.get(b.parentId)?.kind === "folder" ? b.parentId : OTHER_FOLDER_ID;
    return store.create({ parentId: parent, kind: "bookmark", title: b.title || url, url });
  }

  async searchHistory(query: string, limit = 20): Promise<HistoryEntry[]> {
    const capped = Math.max(1, Math.min(200, Math.floor(limit)));
    return this.ctx.windows
      .target()
      .profile.history.query(query, 0, capped)
      .entries.map(({ id, url, title, visitedAt, visitCount }) => ({ id, url, title, visitedAt, visitCount }));
  }

  async cookies(id: TabId): Promise<CookieInfo[]> {
    const { wc } = this.readable(id);
    const url = wc.getURL();
    const list = await wc.session.cookies.get({ url });
    return list.slice(0, COOKIE_LIMIT).map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain ?? "",
      path: c.path ?? "/",
      secure: c.secure === true,
      httpOnly: c.httpOnly === true,
      session: c.session === true,
      ...(typeof c.expirationDate === "number" ? { expiresAt: Math.round(c.expirationDate) } : {}),
      ...(c.sameSite ? { sameSite: c.sameSite } : {}),
    }));
  }

  async clearCookie(id: TabId, name: string): Promise<{ removed: number }> {
    const { wc } = this.readable(id);
    const url = wc.getURL();
    const matches = await wc.session.cookies.get({ url, name });
    for (const c of matches) {
      const host = (c.domain ?? "").replace(/^\./, "");
      if (!host) continue;
      await wc.session.cookies.remove(`${c.secure ? "https" : "http"}://${host}${c.path ?? "/"}`, c.name);
    }
    return { removed: matches.length };
  }

  /** MCP fill_totp: opt-in and approval gated (native dialog); never returns the code. */
  async fillTotp(id: TabId, ref: string, opts: { username?: string } = {}): Promise<CredentialFillResult> {
    this.locate(id);
    return this.ctx.agentCredentials.fillTotp(id, ref, this.credentialOptions(opts.username));
  }

  /** MCP fill_login: opt-in and approval gated (native dialog); never returns the password. */
  async fillLogin(id: TabId, opts: { ref?: string; username?: string } = {}): Promise<CredentialFillResult> {
    this.locate(id);
    return this.ctx.agentCredentials.fillLogin(id, opts.ref ?? null, this.credentialOptions(opts.username));
  }

  private credentialOptions(username: string | undefined) {
    return {
      approve: this.ctx.agentCredentials.dialogApprover(),
      client: this.ctx.agents.currentClient,
      handoffHint: "Call request_user_action so the user can do this step.",
      ...(username ? { username } : {}),
    };
  }

  async download(id: TabId, url: string, opts: { maxBytes?: number } = {}): Promise<DownloadEntry> {
    const { window, wc } = this.readable(id);
    if (!/^https?:\/\//i.test(url)) throw new AgentError("Downloads need an http(s) URL");
    this.touch(window, id);
    const maxBytes = Math.max(1, Math.min(opts.maxBytes ?? DOWNLOAD_MAX_BYTES, DOWNLOAD_HARD_MAX));
    const startedAt = Date.now();
    const res = await wc.session.fetch(url);
    if (!res.ok) throw new AgentError(`Download failed: HTTP ${res.status}`);
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > maxBytes) throw new AgentError(`Download is ${declared} bytes, over the ${maxBytes} byte cap`);
    const filename = downloadFilename(url, res.headers.get("content-disposition"));
    if (isExecutableFilename(filename)) throw new AgentError("Refusing to download an executable file for an agent");
    const body = res.body;
    if (!body) throw new AgentError("Download produced no content");

    const dir = this.ctx.downloads.directory();
    fs.mkdirSync(dir, { recursive: true });
    const name = uniqueFilename(filename, (candidate) => fs.existsSync(path.join(dir, candidate)));
    const savePath = path.join(dir, name);
    const reader = (body as ReadableStream<Uint8Array>).getReader();
    const handle = await fs.promises.open(savePath, "w");
    let received = 0;
    let overflow = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > maxBytes) {
          overflow = true;
          await reader.cancel().catch(() => undefined);
          break;
        }
        await handle.write(value);
      }
    } finally {
      await handle.close().catch(() => undefined);
    }
    if (overflow) {
      await fs.promises.rm(savePath, { force: true }).catch(() => undefined);
      throw new AgentError(`Download exceeded the ${maxBytes} byte cap`);
    }
    return { id: crypto.randomUUID(), url, filename: name, path: savePath, state: "completed", receivedBytes: received, totalBytes: declared || received, startedAt };
  }
}
