import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  ActionTarget,
  AgentInput,
  Bookmark,
  Capture,
  CaptureOptions,
  BrowserController,
  ConsoleEntry,
  CookieInfo,
  CredentialFillResult,
  DialogInfo,
  DownloadEntry,
  ElementAction,
  ExtractOptions,
  ExtractResult,
  FieldValue,
  FindQuery,
  GroupColor,
  GroupId,
  HistoryEntry,
  NetworkEntry,
  PageSnapshot,
  SnapshotElement,
  SnapshotOptions,
  Point,
  PointTarget,
  SpendApprovalRequest,
  Tab,
  TabGroup,
  TabId,
  UserActionRequest,
  UserActionResult,
  ViewportOverride,
  WaitCondition,
  WaitResult,
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
  describeFocusedScript,
  describePointScript,
  describeTargetScript,
  focusForTypingScript,
  locateScript,
  scrollScript,
  setValueScript,
  snapshotScript,
  type RawSnapshot,
} from "./page-scripts";
import { checkScript, fillScript, focusScript, selectScript } from "./element-scripts";
import { PageDialogs } from "./page-dialogs";
import { extractScript, findScript, htmlScript, textScript, waitProbeScript } from "./read-scripts";
import { TabLogs } from "./tab-logs";
import { captureTab, dragBetween, hoverAt, mouseClickAt, pressKeys, scrollAt, typeTextPaced } from "./visual-input";
import type { BrowserWindowCtl, TabRuntime } from "./window";

const LOAD_TIMEOUT_MS = 15_000;
const WAIT_POLL_MS = 250;
const WAIT_MAX_MS = 120_000;
/** wait_for networkIdle: no request in flight for this long. */
const NETWORK_IDLE_MS = 500;
const EVALUATE_TIMEOUT_MS = 10_000;
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 5;
/** upload_file: the most files and bytes an agent may put on one file input. */
const UPLOAD_MAX_FILES = 20;
const UPLOAD_MAX_BYTES = 200 * 1024 * 1024;
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

/** wait_for url: contains the text, or matches it as a glob when it has "*". */
function urlMatches(url: string, pattern: string): boolean {
  if (!pattern.includes("*")) return url.includes(pattern);
  const re = new RegExp("^" + pattern.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
  return re.test(url);
}

/** A page script's own refusal ({ error }) as an AgentError; anything else passes through. */
function scriptResult<T>(value: T | { error: string }): T {
  if (value && typeof value === "object" && "error" in value && typeof (value as { error: unknown }).error === "string") throw new AgentError((value as { error: string }).error);
  return value as T;
}

/** Scripts and input wait behind an open alert/confirm: the agent reads it in page_snapshot first. */
function dialogBlocked(dialog: DialogInfo): AgentError {
  return new AgentError(`The page has a ${dialog.type} dialog open and waits for an answer; read it with page_snapshot, then call handle_dialog.`);
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
  private readonly logs = new TabLogs({
    sensitiveRequest: (wc, request) => this.ctx.secretFills.isSensitiveRequest(this.ctx.windows.byTabWebContents(wc)?.tab.id ?? null, request),
    sensitiveText: (text) => this.ctx.secretFills.containsFilledValue(text),
  });
  private readonly dialogs = new PageDialogs();

  constructor(private readonly ctx: AppContext) {}

  private locate(id: TabId): { window: BrowserWindowCtl; tab: TabRuntime } {
    const found = this.ctx.windows.findTab(id);
    // Private windows are out of agents' reach.
    if (!found || found.window.isPrivate) throw new AgentError(`Unknown tab ${id}`);
    return found;
  }

  private agentUrl(input: string): string {
    const url = intentToUrl(classifyOmnibox(input));
    if (!isAgentAllowedUrl(url)) throw new AgentError(`Agents may not open ${url}`);
    return url;
  }

  /** The tab's page, when agents may use it; "block" refuses while the page waits on a dialog. */
  private readable(id: TabId, dialogs: "block" | "allow" = "block"): { window: BrowserWindowCtl; tab: TabRuntime; wc: WebContents } {
    const found = this.locate(id);
    const wc = found.tab.view.webContents;
    if (wc.isDestroyed()) throw new AgentError(`Tab ${id} is closed`);
    if (!isAgentAllowedUrl(wc.getURL() || found.tab.url)) throw new AgentError("Agents cannot access this page");
    const dialog = dialogs === "block" ? this.dialogs.pending(wc) : null;
    if (dialog) throw dialogBlocked(dialog);
    return { ...found, wc };
  }

  private touch(window: BrowserWindowCtl, id: TabId): void {
    window.markAgent(id);
    const tab = window.getTab(id);
    if (tab) {
      this.logs.watch(tab.view.webContents);
      this.dialogs.watch(tab.view.webContents);
    }
  }

  /** Runs a page script; ends early when the page opens a dialog (the script waits behind it). */
  private exec<T>(wc: WebContents, code: string): Promise<T> {
    const dialog = this.dialogs.pending(wc);
    if (dialog) return Promise.reject(dialogBlocked(dialog));
    const run = timeout(wc.executeJavaScriptInIsolatedWorld(AGENT_WORLD_ID, [{ code }]) as Promise<T>, EVALUATE_TIMEOUT_MS, "Page script timed out");
    return this.dialogs.race(wc, run, dialogBlocked);
  }

  private isForeground(window: BrowserWindowCtl, id: TabId): boolean {
    return window.activeTab()?.id === id && window.win.isVisible() && !window.win.isMinimized();
  }

  private validRef(ref: string): string {
    if (!REF_RE.test(ref)) throw new AgentError(`Invalid element ref "${ref}"; use refs from page_snapshot`);
    return ref;
  }

  async listTabs(): Promise<Tab[]> {
    return this.ctx.windows.regular().flatMap((w) => w.listTabs());
  }

  async listGroups(): Promise<TabGroup[]> {
    return this.ctx.windows.regular().flatMap((w) => w.listGroups());
  }

  async openTab(url: string, opts: { background?: boolean; groupId?: GroupId; agent?: boolean } = {}): Promise<Tab> {
    const target = this.agentUrl(url);
    const window = (opts.groupId ? this.ctx.windows.regular().find((w) => w.hasGroup(opts.groupId as GroupId)) : undefined) ?? this.ctx.windows.target();
    const groupId = opts.groupId && window.hasGroup(opts.groupId) ? opts.groupId : undefined;
    const tab = window.createTab(target, { activate: opts.background !== true, agent: opts.agent ?? true, ...(groupId ? { groupId } : {}) });
    this.logs.watch(tab.view.webContents);
    this.dialogs.watch(tab.view.webContents);
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
    for (const window of this.ctx.windows.regular()) {
      const ids = tabIds.filter((id) => window.hasTab(id));
      if (ids.length > 0) window.ungroupTabs(ids);
    }
  }

  async snapshot(id: TabId, opts: SnapshotOptions = {}): Promise<PageSnapshot> {
    const { window, wc } = this.readable(id, "allow");
    this.touch(window, id);
    // The page is frozen behind its dialog: report the dialog alone.
    const dialog = this.dialogs.pending(wc);
    if (dialog) return { tabId: id, url: wc.getURL(), title: wc.getTitle(), text: "", elements: [], truncated: false, dialog };
    await this.ctx.agents.beforeAction(window, id, wc, { kind: "read" });
    const raw = await this.exec<RawSnapshot>(
      wc,
      snapshotScript(opts.maxChars ?? DEFAULT_SNAPSHOT_CHARS, {
        ...(opts.boxes !== undefined ? { boxes: opts.boxes } : {}),
        ...(opts.viewportOnly !== undefined ? { viewportOnly: opts.viewportOnly } : {}),
        ...(opts.maxElements !== undefined ? { maxElements: opts.maxElements } : {}),
        ...(opts.text !== undefined ? { text: opts.text } : {}),
      }),
    );
    const viewport = raw.viewport ? { ...raw.viewport, zoom: wc.getZoomFactor() } : undefined;
    return { tabId: id, url: raw.url, title: raw.title, text: raw.text, elements: raw.elements, truncated: raw.truncated, ...(viewport ? { viewport } : {}) };
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

  /** Screenshot of the viewport, one element or the whole page, sized for the *_at tools. */
  async capture(id: TabId, opts: CaptureOptions = {}): Promise<Capture> {
    this.readable(id);
    return captureTab(this.ctx, id, opts);
  }

  /** What is at a viewport point (CSS px), for the spend gate and the overlay label. Read-only. */
  async describePoint(id: TabId, point: Point): Promise<PointTarget | null> {
    const { wc } = this.readable(id);
    return this.exec<PointTarget | null>(wc, describePointScript(point.x, point.y)).catch(() => null);
  }

  /** The focused element (none when nothing has focus), for the spend gate. Read-only. */
  async describeFocused(id: TabId): Promise<PointTarget | null> {
    const { wc } = this.readable(id);
    return this.exec<PointTarget | null>(wc, describeFocusedScript()).catch(() => null);
  }

  /**
   * Coordinate and keyboard input with real input events (synthetic ones in a background tab). The
   * MCP server checks clicks, Enter and Space with the spend gate before it calls this.
   */
  async input(id: TabId, action: AgentInput): Promise<void> {
    const { window } = this.readable(id);
    this.touch(window, id);
    const label = async (p: Point): Promise<string> => {
      const hit = await this.describePoint(id, p);
      return hit?.name || hit?.text || "";
    };
    switch (action.type) {
      case "click":
        return mouseClickAt(this.ctx, id, action, { ...(action.button ? { button: action.button } : {}), ...(action.clickCount ? { clickCount: action.clickCount } : {}), ...(action.modifiers ? { modifiers: action.modifiers } : {}) }, await label(action));
      case "move":
        return hoverAt(this.ctx, id, action, await label(action));
      case "drag":
        return dragBetween(this.ctx, id, action.from, action.to, action.steps ?? 10, await label(action.from));
      case "wheel":
        await scrollAt(this.ctx, id, action, { deltaX: action.deltaX, deltaY: action.deltaY }, await label(action));
        return;
      case "keys":
        return pressKeys(this.ctx, id, action.keys);
      case "text":
        return typeTextPaced(this.ctx, id, action.text, action.delayMs ?? 0);
    }
  }

  /** Hover (a real mouse move to its centre), focus, check / uncheck, or select options of an element. */
  async elementAction(id: TabId, ref: string, action: ElementAction): Promise<void> {
    const { window, wc } = this.readable(id);
    this.validRef(ref);
    this.touch(window, id);
    if (action.type === "hover") {
      const point = await this.exec<{ x: number; y: number } | null>(wc, locateScript(ref));
      if (!point) throw new AgentError(`Element ${ref} not found; take a new page_snapshot`);
      const target = await this.describeTarget(id, ref).catch(() => null);
      await hoverAt(this.ctx, id, { x: point.x, y: point.y }, target?.name ?? "");
      return;
    }
    await this.ctx.agents.beforeAction(window, id, wc, action.type === "focus" ? { kind: "read" } : { kind: "click", ref });
    const script = action.type === "focus" ? focusScript(ref) : action.type === "check" ? checkScript(ref, action.checked) : selectScript(ref, action.values);
    scriptResult(await this.exec<{ ok: true } | { error: string }>(wc, script));
  }

  /** fill_form / fill_fields: a text field's text, a checkbox's state, or a select's option(s). */
  async fill(id: TabId, ref: string, value: FieldValue): Promise<void> {
    const { window, wc } = this.readable(id);
    this.validRef(ref);
    this.touch(window, id);
    await this.ctx.agents.beforeAction(window, id, wc, { kind: "type", ref, text: typeof value === "string" ? value : JSON.stringify(value) });
    scriptResult(await this.exec<{ ok: true } | { error: string }>(wc, fillScript(ref, value)));
  }

  /**
   * request_user_action: brings the tab to the front and asks the person, in a dialog that leaves
   * the page usable, to do the step the client describes; Done, Cancel, or timeout.
   */
  async requestUserAction(id: TabId, request: UserActionRequest, signal?: AbortSignal): Promise<UserActionResult> {
    const { window, tab } = this.locate(id);
    this.touch(window, id);
    window.activate(id);
    if (window.win.isMinimized()) window.win.restore();
    window.win.show();
    window.win.focus();
    let host = "";
    try {
      host = new URL(tab.view.webContents.getURL() || tab.url).host;
    } catch {
      host = "";
    }
    return this.ctx.userActions.ask({ client: this.ctx.agents.currentClient, message: request.message, host }, request.timeoutMs, signal);
  }

  /** Page zoom for the tab only (the site's remembered zoom is left as the person set it). */
  async setZoom(id: TabId, factor: number): Promise<number> {
    const { window, wc } = this.readable(id, "allow");
    this.touch(window, id);
    wc.setZoomFactor(Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, factor)));
    return Math.round(wc.getZoomFactor() * 100) / 100;
  }

  /** Emulates a viewport size (and a phone, with mobile), or removes the emulation (null). */
  async setViewport(id: TabId, viewport: ViewportOverride | null): Promise<void> {
    const { window, wc } = this.readable(id);
    this.touch(window, id);
    if (!viewport) {
      wc.disableDeviceEmulation();
      return;
    }
    const size = { width: Math.round(viewport.width), height: Math.round(viewport.height) };
    wc.enableDeviceEmulation({
      screenPosition: viewport.mobile ? "mobile" : "desktop",
      screenSize: size,
      viewSize: size,
      viewPosition: { x: 0, y: 0 },
      deviceScaleFactor: viewport.deviceScaleFactor ?? 0,
      scale: 1,
    });
  }

  /** Prints the page to a PDF in the downloads folder (full access only, by the MCP server). */
  async pdf(id: TabId, opts: { landscape?: boolean; printBackground?: boolean } = {}): Promise<{ path: string; bytes: number }> {
    const { window, wc } = this.readable(id);
    this.touch(window, id);
    await this.ctx.agents.beforeAction(window, id, wc, { kind: "read" });
    const data = await wc.printToPDF({ landscape: opts.landscape === true, printBackground: opts.printBackground === true });
    const dir = this.ctx.downloads.directory();
    fs.mkdirSync(dir, { recursive: true });
    const base = (wc.getTitle() || "page").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").trim().slice(0, 80) || "page";
    const name = uniqueFilename(`${base}.pdf`, (candidate) => fs.existsSync(path.join(dir, candidate)));
    const savePath = path.join(dir, name);
    await fs.promises.writeFile(savePath, data);
    return { path: savePath, bytes: data.length };
  }

  /** The profile's recent downloads, newest first (full access only, by the MCP server). */
  async listDownloads(limit = 20): Promise<DownloadEntry[]> {
    const runtime = this.ctx.windows.target().profile;
    return this.ctx.downloads
      .list(runtime)
      .slice()
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, Math.max(1, Math.min(200, limit)))
      .map((d) => ({ id: d.id, url: d.url, filename: d.filename, path: d.savePath, state: d.state, receivedBytes: d.receivedBytes, totalBytes: d.totalBytes, startedAt: d.startedAt }));
  }

  /**
   * Puts local files on an <input type=file> through the tab's DevTools protocol (full access only,
   * by the MCP server). The files must exist; programs are refused, like downloads for agents.
   */
  async uploadFiles(id: TabId, ref: string, paths: string[]): Promise<{ files: number }> {
    const { window, wc } = this.readable(id);
    this.validRef(ref);
    if (paths.length === 0 || paths.length > UPLOAD_MAX_FILES) throw new AgentError(`Pass 1 to ${UPLOAD_MAX_FILES} files`);
    let total = 0;
    for (const p of paths) {
      if (!path.isAbsolute(p)) throw new AgentError(`Not an absolute path: ${p}`);
      const stat = await fs.promises.stat(p).catch(() => null);
      if (!stat?.isFile()) throw new AgentError(`No such file: ${p}`);
      if (isExecutableFilename(path.basename(p))) throw new AgentError(`Refusing to upload a program for an agent: ${path.basename(p)}`);
      total += stat.size;
    }
    if (total > UPLOAD_MAX_BYTES) throw new AgentError(`The files add up to ${total} bytes, over the ${UPLOAD_MAX_BYTES} byte cap`);
    this.touch(window, id);
    await this.ctx.agents.beforeAction(window, id, wc, { kind: "click", ref });
    const dbg = wc.debugger;
    if (!dbg.isAttached()) dbg.attach("1.3");
    const found = (await dbg.sendCommand("Runtime.evaluate", {
      expression: `document.querySelector('[data-corvus-ref="${ref}"]')`,
    })) as { result?: { objectId?: string; subtype?: string } };
    const objectId = found.result?.objectId;
    if (!objectId || found.result?.subtype === "null") throw new AgentError(`Element ${ref} not found; take a new page_snapshot`);
    const kind = (await dbg.sendCommand("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: "function () { return this.tagName === 'INPUT' && (this.type || '').toLowerCase() === 'file' ? (this.multiple ? 'multiple' : 'single') : 'other'; }",
      returnByValue: true,
    })) as { result?: { value?: string } };
    if (kind.result?.value === "other") throw new AgentError(`Element ${ref} is not a file input`);
    if (kind.result?.value === "single" && paths.length > 1) throw new AgentError(`Element ${ref} takes one file`);
    await dbg.sendCommand("DOM.setFileInputFiles", { files: paths, objectId });
    return { files: paths.length };
  }

  /** Waits until the tab finishes loading (or the timeout passes), then returns it. */
  async waitForLoad(id: TabId, timeoutMs = LOAD_TIMEOUT_MS): Promise<Tab> {
    const { window, tab } = this.locate(id);
    await waitForLoad(tab.view.webContents, Math.max(100, Math.min(WAIT_MAX_MS, timeoutMs)));
    return window.toTab(tab);
  }

  /** Elements by visible text, CSS selector and/or role, with refs and boxes. */
  async find(id: TabId, query: FindQuery): Promise<SnapshotElement[]> {
    const { window, wc } = this.readable(id);
    this.touch(window, id);
    await this.ctx.agents.beforeAction(window, id, wc, { kind: "read" });
    return scriptResult(await this.exec<SnapshotElement[] | { error: string }>(wc, findScript(query)));
  }

  /** Plain text of an element or of the page's main content. */
  async getText(id: TabId, opts: { ref?: string; maxChars?: number } = {}): Promise<{ text: string; truncated: boolean }> {
    const { window, wc } = this.readable(id);
    if (opts.ref) this.validRef(opts.ref);
    this.touch(window, id);
    await this.ctx.agents.beforeAction(window, id, wc, { kind: "read" });
    const res = await this.exec<{ text: string; truncated: boolean } | null>(wc, textScript(opts.ref, opts.maxChars ?? 4000));
    if (!res) throw new AgentError(`Element ${opts.ref} not found; take a new page_snapshot`);
    return res;
  }

  /** Markdown, tables, links or metadata of the page or an element. */
  async extract(id: TabId, opts: ExtractOptions): Promise<ExtractResult> {
    const { window, wc } = this.readable(id);
    if (opts.ref) this.validRef(opts.ref);
    this.touch(window, id);
    await this.ctx.agents.beforeAction(window, id, wc, { kind: "read" });
    const res = await this.exec<ExtractResult | null>(wc, extractScript(opts.kind, opts.ref, opts.maxChars ?? 8000, opts.limit ?? 30));
    if (!res) throw new AgentError(opts.ref ? `Element ${opts.ref} not found; take a new page_snapshot` : "The page has no content to extract");
    return res;
  }

  /** Trimmed outerHTML of an element (ref or selector) or of the body. */
  async getHtml(id: TabId, opts: { ref?: string; selector?: string; maxChars?: number } = {}): Promise<{ html: string; truncated: boolean }> {
    const { window, wc } = this.readable(id);
    if (opts.ref) this.validRef(opts.ref);
    this.touch(window, id);
    await this.ctx.agents.beforeAction(window, id, wc, { kind: "read" });
    const res = scriptResult(await this.exec<{ html: string; truncated: boolean } | { error: string } | null>(wc, htmlScript(opts.ref, opts.selector, opts.maxChars ?? 4000)));
    if (!res) throw new AgentError("No element matches; take a new page_snapshot");
    return res;
  }

  /**
   * Polls until every part of the condition holds (text, an element's state, the URL, the load, or
   * no network request in flight for 500 ms) or the timeout passes.
   */
  async waitFor(id: TabId, condition: WaitCondition, signal?: AbortSignal): Promise<WaitResult> {
    const { window, wc } = this.readable(id);
    if (condition.ref) this.validRef(condition.ref);
    this.touch(window, id);
    const started = Date.now();
    const limit = Math.max(100, Math.min(WAIT_MAX_MS, condition.timeoutMs ?? 10_000));
    const dom = condition.text || condition.textGone || condition.ref || condition.selector;
    let idleSince: number | null = null;
    let detail = "";
    for (;;) {
      if (wc.isDestroyed()) throw new AgentError(`Tab ${id} is closed`);
      const url = wc.getURL();
      const missing: string[] = [];
      if (condition.url && !urlMatches(url, condition.url)) missing.push("url");
      if (condition.load && wc.isLoading()) missing.push("load");
      if (condition.networkIdle) {
        const inFlight = this.logs.inFlight(wc);
        if (inFlight === null || inFlight > 0) idleSince = null;
        else idleSince ??= Date.now();
        if (inFlight === null) missing.push("networkIdle (network is not recorded yet)");
        else if (idleSince === null || Date.now() - idleSince < NETWORK_IDLE_MS) missing.push("networkIdle");
      }
      if (dom && !wc.isLoading()) {
        const probe = scriptResult(await this.exec<Record<string, boolean> | { error: string }>(wc, waitProbeScript(condition)).catch(() => ({}) as Record<string, boolean>));
        for (const [k, ok] of Object.entries(probe)) if (!ok) missing.push(k);
      } else if (dom) {
        missing.push("page loading");
      }
      const elapsedMs = Date.now() - started;
      if (missing.length === 0) return { matched: true, elapsedMs, url };
      detail = `waiting for ${missing.join(", ")}`;
      if (elapsedMs >= limit || signal?.aborted) return { matched: false, elapsedMs, url, detail };
      await new Promise((r) => setTimeout(r, WAIT_POLL_MS));
    }
  }

  /** Console messages since an agent first acted in the tab (recording starts then). */
  async consoleMessages(id: TabId, opts: { level?: string; limit?: number; clear?: boolean } = {}): Promise<ConsoleEntry[]> {
    const { window, wc } = this.readable(id, "allow");
    this.touch(window, id);
    await this.ctx.agents.beforeAction(window, id, wc, { kind: "read" });
    return this.logs.consoleMessages(wc, opts);
  }

  /** Network requests since an agent first acted in the tab (recording starts then). */
  async networkRequests(id: TabId, opts: { filter?: string; failedOnly?: boolean; limit?: number; clear?: boolean } = {}): Promise<NetworkEntry[]> {
    const { window, wc } = this.readable(id, "allow");
    this.touch(window, id);
    await this.ctx.agents.beforeAction(window, id, wc, { kind: "read" });
    return this.logs.networkRequests(wc, opts);
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
    return this.dialogs.race(wc, timeout(wc.executeJavaScript(expression, true), EVALUATE_TIMEOUT_MS, "Evaluation timed out"), dialogBlocked);
  }

  /** The alert or confirm the page waits on, when an agent's tab has one open. */
  async pendingDialog(id: TabId): Promise<DialogInfo | null> {
    const { wc } = this.readable(id, "allow");
    return this.dialogs.pending(wc);
  }

  /**
   * Answers the page's alert or confirm and closes the native box the person sees. The MCP server
   * asks the person first when accepting it spends money. prompt() never stays open (Electron answers
   * it with null), so promptText has nothing to reach.
   */
  async handleDialog(id: TabId, opts: { accept: boolean; promptText?: string }): Promise<DialogInfo> {
    const { window, wc } = this.readable(id, "allow");
    this.touch(window, id);
    const dialog = this.dialogs.answer(wc, opts.accept, opts.promptText);
    if (!dialog) throw new AgentError("No dialog is open on this tab");
    return dialog;
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

  async newtab(request: Record<string, unknown>, client: string): Promise<string> {
    return this.ctx.newtab.agent(this.ctx.windows.target().profile, request, client);
  }

  async downloadQueue(request: Record<string, unknown>, client: string): Promise<string> {
    return this.ctx.queue.agent(this.ctx.windows.target().profile, request, client);
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

  /** Role, name, page and form of one element, read live for the spend gate. Never acts on the page. */
  async describeTarget(id: TabId, ref: string): Promise<ActionTarget | null> {
    if (!REF_RE.test(ref)) return null;
    const { wc } = this.readable(id);
    return this.exec<ActionTarget | null>(wc, describeTargetScript(ref));
  }

  /** MCP spend gate: the native "Allow once / Deny" dialog for one action that spends money. */
  async confirmSpend(id: TabId, request: SpendApprovalRequest): Promise<boolean> {
    this.locate(id);
    return this.ctx.spendApprovals.confirm({ client: this.ctx.agents.currentClient, action: request.action, host: request.host });
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
