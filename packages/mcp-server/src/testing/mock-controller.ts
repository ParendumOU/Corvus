import type {
  ActionTarget,
  AgentInput,
  Bookmark,
  Capture,
  CaptureOptions,
  ChallengeInfo,
  ConsoleEntry,
  CookieInfo,
  CredentialFillResult,
  DialogInfo,
  DownloadEntry,
  ElementAction,
  ExtractOptions,
  ExtractResult,
  ExtractedTable,
  FieldValue,
  FindQuery,
  NetworkEntry,
  SnapshotElement,
  SnapshotOptions,
  UserActionRequest,
  UserActionResult,
  ViewportOverride,
  WaitCondition,
  WaitResult,
  BrowserController,
  GroupColor,
  GroupId,
  HistoryEntry,
  PageSnapshot,
  SpendApprovalRequest,
  Tab,
  TabGroup,
  TabId,
} from "@corvus/shared";

export interface MockPage {
  title: string;
  text: string;
  elements?: SnapshotElement[];
  html?: string;
  tables?: ExtractedTable[];
  links?: Array<{ text: string; href: string }>;
  metadata?: Record<string, string>;
  challenge?: ChallengeInfo;
  dialog?: Omit<DialogInfo, "url" | "at">;
  console?: ConsoleEntry[];
  network?: NetworkEntry[];
  /** Form of an element, by ref (action URL and default submit button), for the spend gate. */
  forms?: Record<string, { action?: string; submitName?: string; submitRole?: string }>;
}

export interface PendingUserAction {
  tabId: TabId;
  request: UserActionRequest;
  answer(outcome: "done" | "cancelled"): void;
}

export interface MockCall {
  method: string;
  args: unknown[];
}

export type MockBookmarkSeed = Pick<Bookmark, "title" | "url" | "parentId"> & { id?: string; kind?: Bookmark["kind"] };

export interface MockBrowserControllerOptions {
  /** Page content by URL; unknown URLs get a generated placeholder page. */
  pages?: Record<string, MockPage>;
  /** URLs opened as tabs at construction; the first one is active. */
  initialTabs?: string[];
  bookmarks?: MockBookmarkSeed[];
  /** Implementation used by evaluate(); omit to leave evaluate undefined. */
  evaluate?: (tabId: TabId, expression: string, opts?: { world?: "main" | "isolated"; timeoutMs?: number }) => unknown;
  downloads?: DownloadEntry[];
  /** Cookies readable per host, keyed by the tab URL's host. */
  cookies?: Record<string, CookieInfo[]>;
  /** Outcome of fill_totp / fill_login. Default: a handoff, as when the user has not opted in. */
  credentialFill?: (kind: "totp" | "login", tabId: TabId, opts: { ref?: string; username?: string }) => CredentialFillResult;
  /** Answer to the spend dialog (confirmSpend). Default: allow, as a person clicking "Allow once". */
  spendApproval?: (request: SpendApprovalRequest, tabId: TabId) => boolean;
}

const VIEWPORT = { width: 1280, height: 800 };

/** What the mock answers for a tab locked after a credential fill (the desktop wording differs). */
export const SECRET_FILL_LOCK_TEXT = "A saved secret was filled into this tab; scripts and raw page reads are blocked until it navigates.";

// 1x1 transparent PNG.
const PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

interface TabState {
  tab: Tab;
  history: string[];
  index: number;
  scrollY: number;
  inputs: Map<string, string>;
  dialog: DialogInfo | null;
  zoom: number;
  viewport: ViewportOverride | null;
}

/** In-memory BrowserController for tests and the corvus-mcp-dev server. Records every call in `calls`. */
export class MockBrowserController implements BrowserController {
  readonly calls: MockCall[] = [];
  readonly evaluate?: (id: TabId, expression: string, opts?: { world?: "main" | "isolated"; timeoutMs?: number }) => Promise<unknown>;
  /** request_user_action calls waiting for an answer. */
  readonly pendingUserActions: PendingUserAction[] = [];
  /** Inputs dispatched through input(), in order. */
  readonly inputs: Array<{ tabId: TabId; action: AgentInput }> = [];
  private readonly downloads: DownloadEntry[];
  private readonly cookieJar: Map<string, CookieInfo[]>;
  private readonly credentialFill: NonNullable<MockBrowserControllerOptions["credentialFill"]>;
  private readonly spendApproval: NonNullable<MockBrowserControllerOptions["spendApproval"]>;
  private readonly pages: Record<string, MockPage>;
  private readonly tabs = new Map<TabId, TabState>();
  private readonly groups = new Map<GroupId, TabGroup>();
  private readonly bookmarks: Bookmark[] = [];
  private readonly history = new Map<string, HistoryEntry>();
  private seq = 0;

  constructor(opts: MockBrowserControllerOptions = {}) {
    this.pages = { ...opts.pages };
    this.downloads = [...(opts.downloads ?? [])];
    this.credentialFill = opts.credentialFill ?? (() => ({ status: "handoff", message: "The user has not allowed agents to use this login. Call request_user_action." }));
    this.spendApproval = opts.spendApproval ?? (() => true);
    this.cookieJar = new Map(Object.entries(opts.cookies ?? {}).map(([host, list]) => [host, list.map((c) => ({ ...c }))]));
    for (const b of opts.bookmarks ?? []) this.insertBookmark(b);
    opts.initialTabs?.forEach((url, i) => this.createTab(url, { background: i > 0, agent: false }));
    const evaluateImpl = opts.evaluate;
    if (evaluateImpl) {
      this.evaluate = async (id, expression, evalOpts) => {
        this.record("evaluate", id, expression, evalOpts);
        this.state(id);
        return evaluateImpl(id, expression, evalOpts);
      };
    }
  }

  private nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}${this.seq}`;
  }

  private record(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args });
  }

  private state(id: TabId): TabState {
    const s = this.tabs.get(id);
    if (!s) throw new Error(`No tab with id ${id}`);
    return s;
  }

  private page(url: string): MockPage {
    return (
      this.pages[url] ?? {
        title: `Page ${new URL(url).hostname}`,
        text: `Placeholder content for ${url}.`,
        elements: [
          { ref: "e1", role: "link", name: "More information" },
          { ref: "e2", role: "textbox", name: "Search" },
          { ref: "e3", role: "button", name: "Go" },
        ],
      }
    );
  }

  private visit(url: string): void {
    const now = Date.now();
    const existing = this.history.get(url);
    const title = this.page(url).title;
    if (existing) {
      existing.visitCount += 1;
      existing.visitedAt = now;
      existing.title = title;
    } else {
      this.history.set(url, { id: this.nextId("h"), url, title, visitedAt: now, visitCount: 1 });
    }
  }

  private load(s: TabState, url: string): void {
    this.lockedTabs.delete(s.tab.id);
    s.tab.url = url;
    s.tab.title = this.page(url).title;
    s.scrollY = 0;
    s.inputs.clear();
    const dialog = this.page(url).dialog;
    s.dialog = dialog ? { ...dialog, url, at: Date.now() } : null;
    this.visit(url);
  }

  private createTab(url: string, opts: { background?: boolean; groupId?: GroupId; agent?: boolean }): Tab {
    if (opts.groupId && !this.groups.has(opts.groupId)) throw new Error(`No group with id ${opts.groupId}`);
    const tab: Tab = {
      id: this.nextId("t"),
      windowId: "w1",
      url,
      title: "",
      pinned: false,
      active: false,
      loading: false,
      agentControlled: opts.agent ?? false,
      ...(opts.groupId ? { groupId: opts.groupId } : {}),
    };
    const s: TabState = { tab, history: [url], index: 0, scrollY: 0, inputs: new Map(), dialog: null, zoom: 1, viewport: null };
    this.tabs.set(tab.id, s);
    this.load(s, url);
    if (!opts.background || this.tabs.size === 1) this.setActive(tab.id);
    return { ...tab };
  }

  private setActive(id: TabId): void {
    for (const s of this.tabs.values()) s.tab.active = s.tab.id === id;
  }

  private insertBookmark(b: MockBookmarkSeed): Bookmark {
    const now = Date.now();
    const bookmark: Bookmark = {
      id: b.id ?? this.nextId("b"),
      parentId: b.parentId,
      kind: b.kind ?? "bookmark",
      title: b.title,
      ...(b.url !== undefined ? { url: b.url } : {}),
      position: this.bookmarks.filter((x) => x.parentId === b.parentId).length,
      createdAt: now,
      updatedAt: now,
    };
    this.bookmarks.push(bookmark);
    return bookmark;
  }

  /** Sets or replaces the content served for a URL. */
  setPage(url: string, page: MockPage): void {
    this.pages[url] = page;
  }

  async listTabs(): Promise<Tab[]> {
    this.record("listTabs");
    return [...this.tabs.values()].map((s) => ({ ...s.tab }));
  }

  async listGroups(): Promise<TabGroup[]> {
    this.record("listGroups");
    return [...this.groups.values()].map((g) => ({ ...g }));
  }

  async openTab(url: string, opts: { background?: boolean; groupId?: GroupId; agent?: boolean } = {}): Promise<Tab> {
    this.record("openTab", url, opts);
    return this.createTab(url, opts);
  }

  async closeTab(id: TabId): Promise<void> {
    this.record("closeTab", id);
    const s = this.state(id);
    this.tabs.delete(id);
    if (s.tab.active) {
      const next = [...this.tabs.keys()].at(-1);
      if (next) this.setActive(next);
    }
  }

  async activateTab(id: TabId): Promise<void> {
    this.record("activateTab", id);
    this.state(id);
    this.setActive(id);
  }

  async navigate(id: TabId, url: string): Promise<Tab> {
    this.record("navigate", id, url);
    const s = this.state(id);
    s.history = [...s.history.slice(0, s.index + 1), url];
    s.index = s.history.length - 1;
    this.load(s, url);
    return { ...s.tab };
  }

  async goBack(id: TabId): Promise<void> {
    this.record("goBack", id);
    const s = this.state(id);
    if (s.index === 0) throw new Error("No previous page");
    s.index -= 1;
    this.load(s, s.history[s.index] as string);
  }

  async goForward(id: TabId): Promise<void> {
    this.record("goForward", id);
    const s = this.state(id);
    if (s.index >= s.history.length - 1) throw new Error("No next page");
    s.index += 1;
    this.load(s, s.history[s.index] as string);
  }

  async reload(id: TabId): Promise<void> {
    this.record("reload", id);
    const s = this.state(id);
    this.load(s, s.tab.url);
  }

  async createGroup(tabIds: TabId[], opts: { title?: string; color?: GroupColor } = {}): Promise<TabGroup> {
    this.record("createGroup", tabIds, opts);
    const states = tabIds.map((id) => this.state(id));
    const group: TabGroup = { id: this.nextId("g"), title: opts.title ?? "", color: opts.color ?? "grey", collapsed: false };
    this.groups.set(group.id, group);
    for (const s of states) s.tab.groupId = group.id;
    return { ...group };
  }

  async ungroup(tabIds: TabId[]): Promise<void> {
    this.record("ungroup", tabIds);
    for (const s of tabIds.map((id) => this.state(id))) delete s.tab.groupId;
    const used = new Set([...this.tabs.values()].map((s) => s.tab.groupId));
    for (const id of this.groups.keys()) if (!used.has(id)) this.groups.delete(id);
  }

  async snapshot(id: TabId, opts: SnapshotOptions = {}): Promise<PageSnapshot> {
    this.record("snapshot", id, opts);
    const s = this.state(id);
    const page = this.page(s.tab.url);
    const max = opts.maxChars ?? 4000;
    const view = this.viewportOf(s);
    const elements = (page.elements ?? [])
      .filter((e) => !opts.viewportOnly || !e.bbox || (e.bbox[1] < view.height && e.bbox[1] + e.bbox[3] > 0))
      .map((e) => {
        const value = s.inputs.get(e.ref) ?? e.value;
        const { bbox, ...rest } = e;
        return { ...rest, ...(value === undefined ? {} : { value }), ...(opts.boxes && bbox ? { bbox } : {}) };
      });
    return {
      tabId: id,
      url: s.tab.url,
      title: page.title,
      text: opts.text === false ? "" : page.text.slice(0, max),
      elements,
      truncated: page.text.length > max,
      viewport: { ...view, devicePixelRatio: 1, scrollX: 0, scrollY: s.scrollY, zoom: s.zoom },
      ...(page.challenge ? { challenge: page.challenge } : {}),
      ...(s.dialog ? { dialog: s.dialog } : {}),
    };
  }

  private viewportOf(s: TabState): { width: number; height: number } {
    return s.viewport ? { width: s.viewport.width, height: s.viewport.height } : { ...VIEWPORT };
  }

  private element(s: TabState, ref: string) {
    const el = (this.page(s.tab.url).elements ?? []).find((e) => e.ref === ref);
    if (!el) throw new Error(`No element with ref ${ref}`);
    return el;
  }

  async click(id: TabId, ref: string): Promise<void> {
    this.record("click", id, ref);
    this.element(this.state(id), ref);
  }

  async type(id: TabId, ref: string, text: string, opts: { submit?: boolean } = {}): Promise<void> {
    this.record("type", id, ref, text, opts);
    const s = this.state(id);
    this.element(s, ref);
    s.inputs.set(ref, text);
  }

  async scroll(id: TabId, direction: "up" | "down", amount = 800): Promise<void> {
    this.record("scroll", id, direction, amount);
    const s = this.state(id);
    s.scrollY = Math.max(0, s.scrollY + (direction === "down" ? amount : -amount));
  }

  async screenshot(id: TabId): Promise<{ mimeType: "image/png"; base64: string }> {
    this.record("screenshot", id);
    this.state(id);
    return { mimeType: "image/png", base64: PIXEL_PNG };
  }

  // ---- AgentCapabilities ----------------------------------------------------------------------

  async capture(id: TabId, opts: CaptureOptions = {}): Promise<Capture> {
    this.record("capture", id, opts);
    const s = this.state(id);
    const view = this.viewportOf(s);
    const scale = opts.scale ?? 1;
    let clip = { x: 0, y: 0, width: view.width, height: view.height };
    if (opts.mode === "element") {
      const box = this.element(s, opts.ref ?? "").bbox;
      if (!box) throw new Error(`Element ${opts.ref} has no box`);
      clip = { x: box[0], y: box[1], width: box[2], height: box[3] };
    } else if (opts.mode === "full") {
      clip = { x: 0, y: 0, width: view.width, height: view.height * 3 };
    }
    const challenge = this.page(s.tab.url).challenge;
    return {
      mimeType: opts.format === "jpeg" ? "image/jpeg" : "image/png",
      base64: PIXEL_PNG,
      width: Math.round(clip.width * scale),
      height: Math.round(clip.height * scale),
      scale,
      viewport: { ...view, devicePixelRatio: 1, scrollX: 0, scrollY: s.scrollY, zoom: s.zoom },
      clip,
      ...(challenge ? { challenge } : {}),
    };
  }

  /** Element whose box contains the point, if any. */
  elementAt(id: TabId, x: number, y: number): SnapshotElement | undefined {
    const s = this.state(id);
    return (this.page(s.tab.url).elements ?? []).find((e) => e.bbox && x >= e.bbox[0] && y >= e.bbox[1] && x <= e.bbox[0] + e.bbox[2] && y <= e.bbox[1] + e.bbox[3]);
  }

  async input(id: TabId, action: AgentInput): Promise<void> {
    this.record("input", id, action);
    const s = this.state(id);
    this.blockedByDialog(s);
    this.inputs.push({ tabId: id, action });
    if (action.type === "text") {
      const focused = [...s.inputs.entries()].find(([k]) => k === "__focus")?.[1];
      if (focused) s.inputs.set(focused, (s.inputs.get(focused) ?? "") + action.text);
    }
    if (action.type === "click") {
      const el = this.elementAt(id, action.x, action.y);
      if (el && (el.role === "textbox" || el.role === "searchbox")) s.inputs.set("__focus", el.ref);
    }
  }

  private blockedByDialog(s: TabState): void {
    if (s.dialog) throw new Error(`A ${s.dialog.type} dialog is open; call handle_dialog first`);
  }

  async elementAction(id: TabId, ref: string, action: ElementAction): Promise<void> {
    this.record("elementAction", id, ref, action);
    const s = this.state(id);
    this.blockedByDialog(s);
    const el = this.element(s, ref);
    if (action.type === "check") {
      if (el.role !== "checkbox" && el.role !== "radio" && el.role !== "switch") throw new Error(`Element ${ref} is not checkable`);
      s.inputs.set(ref, action.checked ? "checked" : "unchecked");
    } else if (action.type === "select") {
      if (el.role !== "combobox" && el.role !== "listbox") throw new Error(`Element ${ref} is not a select`);
      const options = el.options ?? [];
      const missing = action.values.filter((v) => !options.includes(v));
      if (missing.length) throw new Error(`No option ${JSON.stringify(missing[0])}`);
      s.inputs.set(ref, action.values.join(", "));
    } else if (action.type === "focus") {
      s.inputs.set("__focus", ref);
    }
  }

  async fill(id: TabId, ref: string, value: FieldValue): Promise<void> {
    this.record("fill", id, ref, value);
    const s = this.state(id);
    const el = this.element(s, ref);
    if (typeof value === "boolean") return this.elementAction(id, ref, { type: "check", checked: value });
    if (el.role === "combobox" || el.role === "listbox") return this.elementAction(id, ref, { type: "select", values: Array.isArray(value) ? value : [value] });
    if (Array.isArray(value)) throw new Error(`Element ${ref} takes a single value`);
    if (el.role !== "textbox" && el.role !== "searchbox") throw new Error(`Element ${ref} is not a text field`);
    s.inputs.set(ref, value);
  }

  async uploadFiles(id: TabId, ref: string, paths: string[]): Promise<{ files: number }> {
    this.record("uploadFiles", id, ref, paths);
    const s = this.state(id);
    const el = this.element(s, ref);
    if (el.role !== "file") throw new Error(`Element ${ref} is not a file input`);
    s.inputs.set(ref, paths.map((p) => p.split(/[\\/]/).pop()).join(", "));
    return { files: paths.length };
  }

  async find(id: TabId, query: FindQuery): Promise<SnapshotElement[]> {
    this.record("find", id, query);
    const s = this.state(id);
    const q = query.text?.toLowerCase();
    return (this.page(s.tab.url).elements ?? [])
      .filter((e) => !query.role || e.role === query.role)
      .filter((e) => !q || (query.exact ? e.name.toLowerCase() === q : e.name.toLowerCase().includes(q)))
      .slice(0, query.limit ?? 10)
      .map((e) => ({ ...e }));
  }

  async waitFor(id: TabId, condition: WaitCondition, signal?: AbortSignal): Promise<WaitResult> {
    this.record("waitFor", id, condition);
    const started = Date.now();
    const timeout = condition.timeoutMs ?? 10_000;
    for (;;) {
      const s = this.state(id);
      const page = this.page(s.tab.url);
      const text = page.text.toLowerCase();
      const ok =
        (!condition.text || text.includes(condition.text.toLowerCase())) &&
        (!condition.textGone || !text.includes(condition.textGone.toLowerCase())) &&
        (!condition.url || s.tab.url.includes(condition.url)) &&
        (!condition.ref || (page.elements ?? []).some((e) => e.ref === condition.ref) === (condition.state !== "detached" && condition.state !== "hidden"));
      const elapsedMs = Date.now() - started;
      if (ok) return { matched: true, elapsedMs, url: s.tab.url };
      if (elapsedMs >= timeout || signal?.aborted) return { matched: false, elapsedMs, url: s.tab.url, detail: "condition not met" };
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  async getText(id: TabId, opts: { ref?: string; maxChars?: number } = {}): Promise<{ text: string; truncated: boolean }> {
    this.record("getText", id, opts);
    const s = this.state(id);
    const source = opts.ref ? this.element(s, opts.ref).name : this.page(s.tab.url).text;
    const max = opts.maxChars ?? 4000;
    return { text: source.slice(0, max), truncated: source.length > max };
  }

  async extract(id: TabId, opts: ExtractOptions): Promise<ExtractResult> {
    this.record("extract", id, opts);
    const s = this.state(id);
    const page = this.page(s.tab.url);
    const base = { url: s.tab.url, title: page.title, truncated: false };
    const limit = opts.limit ?? 30;
    switch (opts.kind) {
      case "markdown":
        return { ...base, markdown: `# ${page.title}\n\n${page.text}` };
      case "tables":
        return { ...base, tables: (page.tables ?? []).slice(0, limit) };
      case "links":
        return { ...base, links: (page.links ?? []).slice(0, limit) };
      case "metadata":
        return { ...base, metadata: { title: page.title, ...page.metadata } };
    }
  }

  async getHtml(id: TabId, opts: { ref?: string; selector?: string; maxChars?: number } = {}): Promise<{ html: string; truncated: boolean }> {
    this.record("getHtml", id, opts);
    const s = this.state(id);
    const page = this.page(s.tab.url);
    const html = opts.ref ? `<div data-corvus-ref="${this.element(s, opts.ref).ref}">${this.element(s, opts.ref).name}</div>` : (page.html ?? `<body>${page.text}</body>`);
    const max = opts.maxChars ?? 4000;
    return { html: html.slice(0, max), truncated: html.length > max };
  }

  async consoleMessages(id: TabId, opts: { level?: string; limit?: number; clear?: boolean } = {}): Promise<ConsoleEntry[]> {
    this.record("consoleMessages", id, opts);
    const page = this.page(this.state(id).tab.url);
    const order = ["debug", "info", "warning", "error"];
    const min = opts.level ? order.indexOf(opts.level) : 0;
    const rows = (page.console ?? []).filter((m) => order.indexOf(m.level) >= min).slice(-(opts.limit ?? 50));
    if (opts.clear) page.console = [];
    return rows;
  }

  async networkRequests(id: TabId, opts: { filter?: string; failedOnly?: boolean; limit?: number; clear?: boolean } = {}): Promise<NetworkEntry[]> {
    this.record("networkRequests", id, opts);
    const page = this.page(this.state(id).tab.url);
    const rows = (page.network ?? [])
      .filter((r) => !opts.filter || r.url.includes(opts.filter))
      .filter((r) => !opts.failedOnly || r.failed !== undefined || (r.status ?? 0) >= 400)
      .slice(-(opts.limit ?? 50));
    if (opts.clear) page.network = [];
    return rows;
  }

  async pendingDialog(id: TabId): Promise<DialogInfo | null> {
    return this.state(id).dialog;
  }

  async handleDialog(id: TabId, opts: { accept: boolean; promptText?: string }): Promise<DialogInfo> {
    this.record("handleDialog", id, opts);
    const s = this.state(id);
    if (!s.dialog) throw new Error("No dialog is open");
    const dialog = s.dialog;
    s.dialog = null;
    const page = this.page(s.tab.url);
    if (page.dialog) this.pages[s.tab.url] = { ...page, dialog: undefined } as MockPage;
    return dialog;
  }

  async pdf(id: TabId, opts: { landscape?: boolean; printBackground?: boolean } = {}): Promise<{ path: string; bytes: number }> {
    this.record("pdf", id, opts);
    const s = this.state(id);
    return { path: `/downloads/${this.page(s.tab.url).title.replace(/[^\w.-]+/g, "_")}.pdf`, bytes: 1234 };
  }

  async setZoom(id: TabId, factor: number): Promise<number> {
    this.record("setZoom", id, factor);
    this.state(id).zoom = factor;
    return factor;
  }

  async setViewport(id: TabId, viewport: ViewportOverride | null): Promise<void> {
    this.record("setViewport", id, viewport);
    this.state(id).viewport = viewport;
  }

  async listDownloads(limit = 20): Promise<DownloadEntry[]> {
    this.record("listDownloads", limit);
    return this.downloads.slice(0, limit).map((d) => ({ ...d }));
  }

  private hostOf(id: TabId): string {
    try {
      return new URL(this.state(id).tab.url).host;
    } catch {
      return "";
    }
  }

  async cookies(id: TabId): Promise<CookieInfo[]> {
    this.record("cookies", id);
    return (this.cookieJar.get(this.hostOf(id)) ?? []).map((c) => ({ ...c }));
  }

  async clearCookie(id: TabId, name: string): Promise<{ removed: number }> {
    this.record("clearCookie", id, name);
    const host = this.hostOf(id);
    const list = this.cookieJar.get(host) ?? [];
    const next = list.filter((c) => c.name !== name);
    this.cookieJar.set(host, next);
    return { removed: list.length - next.length };
  }

  async fillTotp(id: TabId, ref: string, opts: { username?: string } = {}): Promise<CredentialFillResult> {
    this.record("fillTotp", id, ref, opts);
    this.state(id);
    const result = this.credentialFill("totp", id, { ref, ...opts });
    if (result.status === "filled") this.lockedTabs.add(id);
    return result;
  }

  async fillLogin(id: TabId, opts: { ref?: string; username?: string } = {}): Promise<CredentialFillResult> {
    this.record("fillLogin", id, opts);
    this.state(id);
    const result = this.credentialFill("login", id, opts);
    if (result.status === "filled") this.lockedTabs.add(id);
    return result;
  }

  /** Role, name and page of an element, plus its form when the page declares one (`MockPage.forms`). */
  async describeTarget(id: TabId, ref: string): Promise<ActionTarget | null> {
    const s = this.state(id);
    const page = this.page(s.tab.url);
    const el = (page.elements ?? []).find((e) => e.ref === ref);
    if (!el) return null;
    const form = page.forms?.[ref];
    return { url: s.tab.url, role: el.role, name: el.name, ...(form ? { form: { ...form } } : {}) };
  }

  /** Spend prompts answered so far (the "dialog"), newest last. */
  readonly spendPrompts: Array<{ tabId: TabId; request: SpendApprovalRequest; allowed: boolean }> = [];

  /** The native spend dialog: answered by `spendApproval` (default: allow). */
  async confirmSpend(id: TabId, request: SpendApprovalRequest): Promise<boolean> {
    this.record("confirmSpend", id, request);
    this.state(id);
    const allowed = this.spendApproval(request, id) === true;
    this.spendPrompts.push({ tabId: id, request, allowed });
    return allowed;
  }

  /** Tabs where a saved secret was filled; cleared when the tab loads a new document, like the browser. */
  readonly lockedTabs = new Set<TabId>();

  async secretFillLock(id: TabId): Promise<string | null> {
    return this.lockedTabs.has(id) ? SECRET_FILL_LOCK_TEXT : null;
  }

  async download(id: TabId, url: string, opts: { maxBytes?: number } = {}): Promise<DownloadEntry> {
    this.record("download", id, url, opts);
    this.state(id);
    let filename = "download";
    try {
      filename = new URL(url).pathname.split("/").filter(Boolean).pop() || "download";
    } catch {
      // keep default
    }
    const size = Math.min(1234, opts.maxBytes ?? 1234);
    return { id: this.nextId("d"), url, filename, path: `/downloads/${filename}`, state: "completed", receivedBytes: size, totalBytes: size, startedAt: Date.now() };
  }

  async waitForLoad(id: TabId, timeoutMs?: number): Promise<Tab> {
    this.record("waitForLoad", id, timeoutMs);
    return { ...this.state(id).tab };
  }

  async detectChallenge(id: TabId): Promise<ChallengeInfo | null> {
    return this.page(this.state(id).tab.url).challenge ?? null;
  }

  requestUserAction(id: TabId, request: UserActionRequest, signal?: AbortSignal): Promise<UserActionResult> {
    this.record("requestUserAction", id, request);
    this.state(id);
    const started = Date.now();
    return new Promise((resolve) => {
      const finish = (outcome: UserActionResult["outcome"]): void => {
        clearTimeout(timer);
        const i = this.pendingUserActions.indexOf(pending);
        if (i >= 0) this.pendingUserActions.splice(i, 1);
        resolve({ outcome, waitedMs: Date.now() - started });
      };
      const timer = setTimeout(() => finish("timeout"), request.timeoutMs);
      const pending: PendingUserAction = { tabId: id, request, answer: finish };
      this.pendingUserActions.push(pending);
      signal?.addEventListener("abort", () => finish("cancelled"), { once: true });
    });
  }

  async listBookmarks(): Promise<Bookmark[]> {
    this.record("listBookmarks");
    return this.bookmarks.map((b) => ({ ...b }));
  }

  async addBookmark(b: Pick<Bookmark, "title" | "url" | "parentId">): Promise<Bookmark> {
    this.record("addBookmark", b);
    if (b.parentId !== null && !this.bookmarks.some((x) => x.id === b.parentId && x.kind === "folder")) {
      throw new Error(`No bookmark folder with id ${b.parentId}`);
    }
    return { ...this.insertBookmark(b) };
  }

  async searchHistory(query: string, limit = 20): Promise<HistoryEntry[]> {
    this.record("searchHistory", query, limit);
    const q = query.toLowerCase();
    return [...this.history.values()]
      .filter((h) => h.url.toLowerCase().includes(q) || h.title.toLowerCase().includes(q))
      .sort((a, b) => b.visitedAt - a.visitedAt)
      .slice(0, limit)
      .map((h) => ({ ...h }));
  }
}
