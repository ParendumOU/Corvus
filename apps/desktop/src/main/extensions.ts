import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { ElectronChromeExtensions } from "electron-chrome-extensions";
import { downloadExtension, installChromeWebStore, uninstallExtension, updateExtensions } from "electron-chrome-web-store";
import {
  app,
  dialog,
  nativeImage,
  screen,
  webContents as allWebContents,
  type BaseWindow,
  type NativeImage,
  type Session,
  type WebContents,
} from "electron";
import {
  apiPermissions,
  DNR_DEFAULTS_CHANNEL,
  compareVersions,
  defaultRulesets,
  hostPatterns,
  localizeManifestString,
  parseExtensionId,
  permissionWarnings,
  storeUrlFor,
  unsupportedPermissions,
  type ManifestLike,
} from "../shared/extension-manifest";
import { isInternalUrl, isNewTabUrl } from "../shared/internal-urls";
import type { ExtensionError, ExtensionInfo, ToolbarExtension } from "../shared/ipc";
import { JsonFile } from "./json-file";
import { paths } from "./paths";

type Manifest = ManifestLike & Record<string, unknown>;

export interface TabCreateDetails {
  url?: string;
  active?: boolean;
  index?: number;
  pinned?: boolean;
  windowId?: number;
  openerTabId?: number;
}

export interface TabPlacement {
  index: number;
  pinned: boolean;
  groupId: number;
}

/** What the extension host needs from the window layer (see extension-windows.ts). */
export interface ExtensionWindowDelegate {
  createTab(profileId: string, details: TabCreateDetails): Promise<[WebContents, BaseWindow]>;
  selectTab(webContents: WebContents): void;
  removeTab(webContents: WebContents): void;
  createWindow(profileId: string, urls: string[]): Promise<BaseWindow>;
  removeWindow(window: BaseWindow): void;
  describeTab(webContents: WebContents): TabPlacement | null;
  windowOf(webContents: WebContents): BaseWindow | null;
  extensionsChanged(profileId: string): void;
}

export interface InstallRequest {
  id: string;
  name: string;
  version: string;
  manifest: ManifestLike;
  warnings: string[];
  icon: NativeImage | null;
  window: BaseWindow | null;
}

/** Asks the user to confirm an install. Replaced by the smoke test to auto-accept. */
export type InstallPrompt = (request: InstallRequest) => Promise<boolean>;

async function defaultInstallPrompt(request: InstallRequest): Promise<boolean> {
  const detail =
    request.warnings.length > 0
      ? `It can:\n${request.warnings.map((w) => `•  ${w}`).join("\n")}`
      : "It does not require any special permissions.";
  const options: Electron.MessageBoxOptions = {
    type: "question",
    buttons: ["Add extension", "Cancel"],
    defaultId: 0,
    cancelId: 1,
    title: "Add extension",
    message: `Add “${request.name}”?`,
    detail,
    ...(request.icon && !request.icon.isEmpty() ? { icon: request.icon.resize({ width: 48, height: 48 }) } : {}),
  };
  const { response } = request.window ? await dialog.showMessageBox(request.window, options) : await dialog.showMessageBox(options);
  return response === 0;
}

let installPrompt: InstallPrompt = defaultInstallPrompt;

export function setInstallPrompt(prompt: InstallPrompt): void {
  installPrompt = prompt;
}

const EXTENSION_ID_RE = /^[a-p]{32}$/;
const MAX_ERRORS = 30;
const WORKER_GRACE_MS = 3000;
const UPDATE_DELAY_MS = 20_000;
const UPDATE_INTERVAL_MS = 5 * 60 * 60 * 1000;

interface ExtensionPrefs {
  disabled: string[];
  pinned: string[];
  /** IDs that were loaded at least once; a first load pins the extension. */
  seen: string[];
  /** Resolved unpacked folder -> extension ID, so disabled unpacked extensions can be listed. */
  unpackedIds: Record<string, string>;
  /** id@version whose default static DNR rulesets were already enabled once. */
  dnrDefaults: string[];
}

interface Installed {
  id: string;
  path: string;
  source: "webstore" | "unpacked";
  manifest: Manifest;
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function readDirNames(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
}

/** Reads a manifest from disk and resolves __MSG_*__ placeholders for name and description. */
function readManifest(dir: string): Manifest | null {
  const raw = readJson(path.join(dir, "manifest.json"));
  if (typeof raw !== "object" || raw === null) return null;
  const manifest = raw as Manifest;
  const locale = typeof manifest.default_locale === "string" ? manifest.default_locale : null;
  if (!locale) return manifest;
  const appLocale = app.getLocale().replace("-", "_");
  const candidates = [appLocale, appLocale.split("_")[0] ?? appLocale, locale];
  let messages: Record<string, { message?: unknown }> | null = null;
  for (const candidate of candidates) {
    const found = readJson(path.join(dir, "_locales", candidate, "messages.json"));
    if (found && typeof found === "object") {
      messages = found as Record<string, { message?: unknown }>;
      break;
    }
  }
  const out: Manifest = { ...manifest };
  for (const key of ["name", "short_name", "description"] as const) {
    if (typeof manifest[key] === "string") out[key] = localizeManifestString(manifest[key] as string, messages);
  }
  return out;
}

function iconDataUrl(extPath: string, icons: unknown, preferred = 48): string {
  if (typeof icons !== "object" || icons === null) return "";
  const map = icons as Record<string, unknown>;
  const sizes = Object.keys(map)
    .map(Number)
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  const size = sizes.find((s) => s >= preferred) ?? sizes[sizes.length - 1];
  const rel = size !== undefined ? map[String(size)] : undefined;
  if (typeof rel !== "string") return "";
  const root = path.resolve(extPath);
  const abs = path.resolve(root, rel.replace(/^\//, ""));
  if (!abs.startsWith(root + path.sep)) return "";
  const image = nativeImage.createFromPath(abs);
  return image.isEmpty() ? "" : image.toDataURL();
}

function actionOf(manifest: Manifest): Record<string, unknown> | null {
  const action = manifest.manifest_version === 3 ? manifest.action : manifest.browser_action;
  return typeof action === "object" && action !== null ? (action as Record<string, unknown>) : null;
}

function optionsPage(manifest: Manifest): string | null {
  if (typeof manifest.options_page === "string") return manifest.options_page;
  if (typeof manifest.options_ui?.page === "string") return manifest.options_ui.page;
  return null;
}

function hasServiceWorker(manifest: Manifest): boolean {
  return manifest.manifest_version === 3 && typeof manifest.background?.service_worker === "string";
}

/** Resolves a URL an extension wants to open and rejects the ones extensions may not reach. */
export function checkExtensionUrl(url: string, extensionId: string | undefined): string {
  let resolved: string;
  try {
    resolved = new URL(url, extensionId ? `chrome-extension://${extensionId}/` : undefined).href;
  } catch {
    throw new Error("Invalid URL");
  }
  const scheme = resolved.slice(0, resolved.indexOf(":") + 1).toLowerCase();
  if (isInternalUrl(resolved) && !isNewTabUrl(resolved)) throw new Error("Extensions cannot open corvus:// pages");
  if (["javascript:", "chrome:", "file:", "devtools:", "view-source:"].includes(scheme)) throw new Error(`Extensions cannot open ${scheme} URLs`);
  return resolved;
}

// electron-chrome-extensions keeps its API router private; Corvus wraps a few handlers to
// harden them (no corvus:// navigation) and to fix tab details. Shape mirrors the 4.9.0 source.
export type RouterEvent = { type: "frame" | "service-worker"; extension?: Electron.Extension; sender?: unknown };
export type RouterCallback = (event: RouterEvent, ...args: unknown[]) => unknown;
interface RouterHandler {
  callback: RouterCallback;
  extensionContext: boolean;
  allowRemote: boolean;
  permission?: string;
}
interface RouterInternals {
  handlers: Map<string, RouterHandler>;
  handle(name: string, callback: RouterCallback, opts?: { extensionContext?: boolean; allowRemote?: boolean; permission?: string }): void;
}

/**
 * Per-profile Chrome extension support: chrome.* APIs and toolbar actions via
 * electron-chrome-extensions, Chrome Web Store installs and updates via
 * electron-chrome-web-store, unpacked extensions, enable/disable and toolbar pinning.
 */
export class ExtensionHost {
  readonly api: ElectronChromeExtensions;
  private readonly unpacked: JsonFile<string[]>;
  private readonly prefs: JsonFile<ExtensionPrefs>;
  private readonly extensionsPath: string;
  private readonly errors = new Map<string, ExtensionError[]>();
  private readonly emitter = new EventEmitter();
  private readonly ready: Promise<void>;
  private updateTimer: NodeJS.Timeout | null = null;
  private changeQueued = false;

  constructor(
    private readonly profileId: string,
    private readonly session: Session,
    dataDir: string,
    private readonly delegate: ExtensionWindowDelegate,
  ) {
    this.extensionsPath = path.join(dataDir, "Extensions");
    this.unpacked = JsonFile.load(path.join(dataDir, "unpacked-extensions.json"), () => [], (raw) =>
      Array.isArray(raw) ? raw.filter((p): p is string => typeof p === "string") : [],
    0);
    this.prefs = JsonFile.load(
      path.join(dataDir, "extension-prefs.json"),
      () => ({ disabled: [], pinned: [], seen: [], unpackedIds: {}, dnrDefaults: [] }),
      (raw) => {
        const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
        const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
        const ids = typeof r.unpackedIds === "object" && r.unpackedIds !== null ? (r.unpackedIds as Record<string, unknown>) : {};
        return {
          disabled: list(r.disabled),
          pinned: list(r.pinned),
          seen: list(r.seen),
          dnrDefaults: list(r.dnrDefaults),
          unpackedIds: Object.fromEntries(Object.entries(ids).filter((e): e is [string, string] => typeof e[1] === "string")),
        };
      },
      0,
    );

    // Before electron-chrome-extensions' preloads, which freeze `chrome` (see preload/extension-api.ts).
    session.registerPreloadScript({ id: "corvus-extension-api-worker", type: "service-worker", filePath: paths.extensionApiPreload });
    session.registerPreloadScript({ id: "corvus-extension-api-frame", type: "frame", filePath: paths.extensionApiPreload });
    this.api = new ElectronChromeExtensions({
      license: "GPL-3.0",
      session,
      createTab: (details) => delegate.createTab(profileId, details as TabCreateDetails),
      selectTab: (webContents) => delegate.selectTab(webContents),
      removeTab: (webContents) => delegate.removeTab(webContents),
      createWindow: (details) => delegate.createWindow(profileId, Array.isArray(details.url) ? details.url : details.url ? [details.url] : []),
      removeWindow: (window) => delegate.removeWindow(window),
      assignTabDetails: (details, webContents) => {
        const placement = delegate.describeTab(webContents);
        if (placement) Object.assign(details, placement);
      },
      requestPermissions: (extension, permissions) => this.confirmPermissionRequest(extension, permissions),
    });
    // After electron-chrome-extensions' preloads, which it registers in its constructor.
    session.registerPreloadScript({ id: "corvus-extension-worker", type: "service-worker", filePath: paths.extensionWorkerPreload });
    session.registerPreloadScript({ id: "corvus-extension-frame", type: "frame", filePath: paths.extensionWorkerPreload });
    ElectronChromeExtensions.handleCRXProtocol(session);
    this.hardenRouter();
    this.watchExtensions();
    this.api.on("browser-action-popup-created", (popup: PopupLike) => this.placePopup(popup));

    this.ready = this.init();
  }

  private async init(): Promise<void> {
    try {
      await installChromeWebStore({
        session: this.session,
        extensionsPath: this.extensionsPath,
        loadExtensions: false,
        autoUpdate: false,
        beforeInstall: (details) => this.beforeStoreInstall(details),
      });
    } catch (err) {
      console.error(`[corvus] Chrome Web Store support failed for profile ${this.profileId}:`, err);
    }
    const disabled = new Set(this.prefs.get().disabled);
    for (const entry of this.scan()) {
      if (!disabled.has(entry.id)) await this.loadPath(entry.path, entry.source);
    }
    for (const dir of this.unpacked.get()) {
      if (!this.prefs.get().unpackedIds[path.resolve(dir)]) await this.loadPath(dir, "unpacked");
    }
    this.scheduleUpdates();
  }

  whenReady(): Promise<void> {
    return this.ready;
  }

  onChange(listener: () => void): () => void {
    this.emitter.on("change", listener);
    return () => this.emitter.off("change", listener);
  }

  private changed(): void {
    if (this.changeQueued) return;
    this.changeQueued = true;
    queueMicrotask(() => {
      this.changeQueued = false;
      this.emitter.emit("change");
      this.delegate.extensionsChanged(this.profileId);
    });
  }

  // Container tabs run in sessions of their own, where the profile's extensions do not exist.

  addTab(webContents: WebContents, window: BaseWindow): void {
    if (webContents.session === this.session) this.api.addTab(webContents, window);
  }

  selectTab(webContents: WebContents): void {
    if (webContents.session === this.session) this.api.selectTab(webContents);
  }

  getContextMenuItems(webContents: WebContents, params: Electron.ContextMenuParams): Electron.MenuItem[] {
    return webContents.session === this.session ? this.api.getContextMenuItems(webContents, params) : [];
  }

  // ------------------------------------------------------------------ inventory

  /** Installed extensions on disk (enabled or not): latest web store version + unpacked folders. */
  private scan(): Installed[] {
    const out: Installed[] = [];
    for (const id of readDirNames(this.extensionsPath)) {
      if (!EXTENSION_ID_RE.test(id)) continue;
      let best: Installed | null = null;
      for (const version of readDirNames(path.join(this.extensionsPath, id))) {
        const dir = path.join(this.extensionsPath, id, version);
        const manifest = readManifest(dir);
        if (!manifest) continue;
        if (!best || compareVersions(String(manifest.version ?? "0"), String(best.manifest.version ?? "0")) > 0) {
          best = { id, path: dir, source: "webstore", manifest };
        }
      }
      if (best) out.push(best);
    }
    const ids = this.prefs.get().unpackedIds;
    for (const dir of this.unpacked.get()) {
      const id = ids[path.resolve(dir)];
      const manifest = readManifest(dir);
      if (id && manifest) out.push({ id, path: dir, source: "unpacked", manifest });
    }
    return out;
  }

  private find(id: string): Installed | undefined {
    return this.scan().find((e) => e.id === id);
  }

  private describe(entry: Installed): ExtensionInfo {
    const loaded = this.session.extensions.getExtension(entry.id);
    const manifest = entry.manifest;
    const page = optionsPage(manifest);
    const prefs = this.prefs.get();
    return {
      id: entry.id,
      name: loaded?.name ?? String(manifest.name ?? entry.id),
      version: loaded?.version ?? String(manifest.version ?? ""),
      description: String(manifest.description ?? ""),
      source: entry.source,
      path: entry.path,
      iconUrl: iconDataUrl(entry.path, manifest.icons),
      enabled: loaded !== null,
      pinned: prefs.pinned.includes(entry.id),
      hasAction: actionOf(manifest) !== null,
      manifestVersion: Number(manifest.manifest_version ?? 2),
      permissions: apiPermissions(manifest),
      hostPermissions: hostPatterns(manifest),
      warnings: permissionWarnings(manifest),
      unsupported: unsupportedPermissions(manifest),
      optionsUrl: page ? `chrome-extension://${entry.id}/${page.replace(/^\//, "")}` : null,
      homepageUrl: typeof manifest.homepage_url === "string" ? manifest.homepage_url : null,
      storeUrl: entry.source === "webstore" ? storeUrlFor(entry.id) : null,
      errors: [...(this.errors.get(entry.id) ?? [])],
    };
  }

  list(): ExtensionInfo[] {
    return this.scan()
      .map((e) => this.describe(e))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  info(id: string): ExtensionInfo | null {
    const entry = this.find(id);
    return entry ? this.describe(entry) : null;
  }

  /** Enabled extensions for the toolbar and the extensions menu. */
  toolbar(): ToolbarExtension[] {
    const pinned = this.prefs.get().pinned;
    return this.scan()
      .filter((e) => this.session.extensions.getExtension(e.id) !== null)
      .map((e) => ({
        id: e.id,
        name: this.session.extensions.getExtension(e.id)?.name ?? String(e.manifest.name ?? e.id),
        iconUrl: iconDataUrl(e.path, e.manifest.icons, 32),
        pinned: pinned.includes(e.id),
        hasAction: actionOf(e.manifest) !== null,
        hasOptions: optionsPage(e.manifest) !== null,
      }))
      .sort((a, b) => pinned.indexOf(a.id) - pinned.indexOf(b.id) || a.name.localeCompare(b.name));
  }

  // ------------------------------------------------------------------ lifecycle

  private async loadPath(dir: string, source: "webstore" | "unpacked"): Promise<Electron.Extension | null> {
    try {
      const ext = await this.session.extensions.loadExtension(dir, { allowFileAccess: false });
      if (source === "unpacked") {
        const resolved = path.resolve(dir);
        this.prefs.update((p) => ({ ...p, unpackedIds: { ...p.unpackedIds, [resolved]: ext.id } }));
      }
      return ext;
    } catch (err) {
      const id = source === "webstore" ? path.basename(path.dirname(dir)) : this.prefs.get().unpackedIds[path.resolve(dir)];
      const message = (err as Error).message;
      if (id) this.recordError(id, "load", message);
      console.warn(`[corvus] could not load extension ${dir}: ${message}`);
      return null;
    }
  }

  private watchExtensions(): void {
    this.session.extensions.on("extension-loaded", (_event, ext) => {
      const prefs = this.prefs.get();
      if (!prefs.seen.includes(ext.id)) {
        this.prefs.set({ ...prefs, seen: [...prefs.seen, ext.id], pinned: prefs.pinned.includes(ext.id) ? prefs.pinned : [...prefs.pinned, ext.id] });
      }
      void this.ensureWorker(ext);
      this.changed();
    });
    this.session.extensions.on("extension-unloaded", () => this.changed());

    const workers = new WeakSet<Electron.ServiceWorkerMain>();
    this.session.serviceWorkers.on("running-status-changed", ({ versionId, runningStatus }) => {
      if (runningStatus !== "starting") return;
      const worker = this.session.serviceWorkers.getWorkerFromVersionID(versionId);
      if (!worker || workers.has(worker) || !worker.scope.startsWith("chrome-extension://")) return;
      workers.add(worker);
      worker.ipc.handle(DNR_DEFAULTS_CHANNEL, () => this.takeDefaultRulesets(worker.scope));
    });

    this.session.serviceWorkers.on("console-message", (_event, details) => {
      if (details.level < 3) return;
      let scope = "";
      try {
        scope = this.session.serviceWorkers.getInfoFromVersionID(details.versionId).scope;
      } catch {
        scope = details.sourceUrl;
      }
      const id = /^chrome-extension:\/\/([a-p]{32})\//.exec(scope || details.sourceUrl)?.[1];
      if (id) this.recordError(id, "service-worker", `${details.message} (${details.sourceUrl}:${details.lineNumber})`);
    });
    app.on("web-contents-created", (_event, wc) => {
      if (wc.session !== this.session) return;
      wc.on("console-message", (event) => {
        if (event.level !== "error") return;
        const source = event.sourceId || wc.getURL();
        const id = /^chrome-extension:\/\/([a-p]{32})\//.exec(source)?.[1];
        if (id && this.session.extensions.getExtension(id)) {
          const where = wc.getURL().startsWith("chrome-extension://") ? "page" : "content-script";
          this.recordError(id, where, `${event.message} (${source}:${event.lineNumber})`);
        }
      });
    });
  }

  private workerRunning(scope: string): boolean {
    return Object.values(this.session.serviceWorkers.getAllRunning()).some((w) => w.scope === scope);
  }

  /**
   * MV3 workers start on their own right after a fresh registration; extensions loaded from a
   * previous run only start on their first event. Starting a worker while Chromium is still
   * registering it fails the registration, so give it a moment first.
   */
  private async ensureWorker(ext: Electron.Extension): Promise<void> {
    if (!hasServiceWorker(ext.manifest as Manifest)) return;
    for (let waited = 0; waited < WORKER_GRACE_MS; waited += 250) {
      if (this.workerRunning(ext.url)) return;
      await new Promise((r) => setTimeout(r, 250));
    }
    if (!this.session.extensions.getExtension(ext.id) || this.workerRunning(ext.url)) return;
    try {
      await this.session.serviceWorkers.startWorkerForScope(ext.url);
    } catch (err) {
      this.recordError(ext.id, "service-worker", `Service worker failed to start: ${(err as Error).message}`);
    }
  }

  /** Default static rulesets to enable in this worker: once per installed version. */
  private takeDefaultRulesets(scope: string): string[] {
    const id = /^chrome-extension:\/\/([a-p]{32})\//.exec(scope)?.[1];
    const ext = id ? this.session.extensions.getExtension(id) : null;
    if (!ext) return [];
    const key = `${ext.id}@${ext.version}`;
    const prefs = this.prefs.get();
    if (prefs.dnrDefaults.includes(key)) return [];
    const ids = defaultRulesets(ext.manifest as Manifest);
    this.prefs.set({ ...prefs, dnrDefaults: [...prefs.dnrDefaults.filter((k) => !k.startsWith(`${ext.id}@`)), key] });
    return ids;
  }

  private recordError(id: string, source: string, message: string): void {
    const list = this.errors.get(id) ?? [];
    list.push({ message: message.slice(0, 2000), source, at: Date.now() });
    this.errors.set(id, list.slice(-MAX_ERRORS));
  }

  clearErrors(id: string): void {
    this.errors.delete(id);
    this.changed();
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const entry = this.find(id);
    if (!entry) throw new Error("Extension is not installed");
    this.prefs.update((p) => ({ ...p, disabled: enabled ? p.disabled.filter((x) => x !== id) : [...new Set([...p.disabled, id])] }));
    const loaded = this.session.extensions.getExtension(id);
    if (enabled && !loaded) {
      const ext = await this.loadPath(entry.path, entry.source);
      if (!ext) throw new Error(this.errors.get(id)?.at(-1)?.message ?? "The extension could not be loaded");
    } else if (!enabled && loaded) {
      this.session.extensions.removeExtension(id);
    }
    this.changed();
  }

  setPinned(id: string, pinned: boolean): void {
    this.prefs.update((p) => ({ ...p, pinned: pinned ? [...new Set([...p.pinned, id])] : p.pinned.filter((x) => x !== id) }));
    this.changed();
  }

  async loadUnpacked(dir: string): Promise<ExtensionInfo> {
    if (!fs.existsSync(path.join(dir, "manifest.json"))) throw new Error("The selected folder has no manifest.json");
    const resolved = path.resolve(dir);
    const ext = await this.session.extensions.loadExtension(resolved, { allowFileAccess: false });
    this.unpacked.update((list) => (list.some((p) => path.resolve(p) === resolved) ? list : [...list, resolved]));
    this.prefs.update((p) => ({ ...p, unpackedIds: { ...p.unpackedIds, [resolved]: ext.id }, disabled: p.disabled.filter((x) => x !== ext.id) }));
    this.changed();
    return this.info(ext.id) ?? this.describe({ id: ext.id, path: resolved, source: "unpacked", manifest: ext.manifest as Manifest });
  }

  async remove(id: string): Promise<void> {
    const entry = this.find(id);
    const forget = (p: ExtensionPrefs): ExtensionPrefs => ({
      ...p,
      disabled: p.disabled.filter((x) => x !== id),
      pinned: p.pinned.filter((x) => x !== id),
      seen: p.seen.filter((x) => x !== id),
      dnrDefaults: p.dnrDefaults.filter((k) => !k.startsWith(`${id}@`)),
      unpackedIds: Object.fromEntries(Object.entries(p.unpackedIds).filter(([, v]) => v !== id)),
    });
    if (entry?.source === "unpacked") {
      const resolved = path.resolve(entry.path);
      if (this.session.extensions.getExtension(id)) this.session.extensions.removeExtension(id);
      this.unpacked.update((list) => list.filter((p) => path.resolve(p) !== resolved));
    } else {
      await uninstallExtension(id, { session: this.session, extensionsPath: this.extensionsPath });
    }
    this.prefs.update(forget);
    this.errors.delete(id);
    this.changed();
  }

  /**
   * Installs an extension from the Chrome Web Store by ID or detail-page URL. Shows the
   * permission prompt before the extension is loaded; this is what corvus://extensions uses.
   */
  async installFromStore(input: string, window: BaseWindow | null = null): Promise<ExtensionInfo | null> {
    const id = parseExtensionId(input);
    if (!id) throw new Error("Enter a Chrome Web Store URL or a 32-letter extension ID");
    const existing = this.find(id);
    if (existing) {
      if (!this.session.extensions.getExtension(id)) await this.setEnabled(id, true);
      return this.info(id);
    }
    const dir = await downloadExtension(id, this.extensionsPath);
    const manifest = readManifest(dir);
    if (!manifest) {
      fs.rmSync(path.join(this.extensionsPath, id), { recursive: true, force: true });
      throw new Error("The downloaded extension has no valid manifest");
    }
    const iconPath = iconDataUrl(dir, manifest.icons, 128);
    const allowed = await installPrompt({
      id,
      name: String(manifest.name ?? id),
      version: String(manifest.version ?? ""),
      manifest,
      warnings: permissionWarnings(manifest),
      icon: iconPath ? nativeImage.createFromDataURL(iconPath) : null,
      window,
    });
    if (!allowed) {
      fs.rmSync(path.join(this.extensionsPath, id), { recursive: true, force: true });
      return null;
    }
    const ext = await this.loadPath(dir, "webstore");
    if (!ext) throw new Error(this.errors.get(id)?.at(-1)?.message ?? "The extension could not be loaded");
    return this.info(id);
  }

  /** "Add to Chrome" on chromewebstore.google.com: same prompt as installFromStore. */
  private async beforeStoreInstall(details: {
    id: string;
    localizedName: string;
    manifest: unknown;
    icon: NativeImage;
    frame: Electron.WebFrameMain;
  }): Promise<{ action: "allow" | "deny" }> {
    const manifest = (typeof details.manifest === "object" && details.manifest !== null ? details.manifest : {}) as Manifest;
    const sender = allWebContents.fromFrame(details.frame);
    const allowed = await installPrompt({
      id: details.id,
      name: details.localizedName,
      version: String(manifest.version ?? ""),
      manifest,
      warnings: permissionWarnings(manifest),
      icon: details.icon,
      window: sender ? this.delegate.windowOf(sender) : null,
    });
    if (allowed) this.prefs.update((p) => ({ ...p, disabled: p.disabled.filter((x) => x !== details.id) }));
    return { action: allowed ? "allow" : "deny" };
  }

  private async confirmPermissionRequest(extension: Electron.Extension, request: { permissions?: string[]; origins?: string[] }): Promise<boolean> {
    const warnings = permissionWarnings({
      manifest_version: 3,
      permissions: request.permissions ?? [],
      host_permissions: request.origins ?? [],
    });
    if (warnings.length === 0) return true;
    const { response } = await dialog.showMessageBox({
      type: "question",
      buttons: ["Allow", "Deny"],
      defaultId: 1,
      cancelId: 1,
      title: "Extension permissions",
      message: `“${extension.name}” requests additional permissions`,
      detail: `It will be able to:\n${warnings.map((w) => `•  ${w}`).join("\n")}`,
    });
    return response === 0;
  }

  /** Checks loaded web store extensions for updates; returns the IDs that were updated. */
  async checkForUpdates(): Promise<{ checked: number; updated: string[] }> {
    const before = new Map(this.session.extensions.getAllExtensions().map((e) => [e.id, e.version]));
    const checked = this.scan().filter((e) => e.source === "webstore" && before.has(e.id)).length;
    await updateExtensions(this.session);
    const updated = this.session.extensions
      .getAllExtensions()
      .filter((e) => before.has(e.id) && before.get(e.id) !== e.version)
      .map((e) => e.id);
    if (updated.length > 0) this.changed();
    return { checked, updated };
  }

  private scheduleUpdates(): void {
    const run = (): void => {
      this.checkForUpdates().catch((err: unknown) => console.warn(`[corvus] extension update check failed: ${(err as Error).message}`));
    };
    setTimeout(run, UPDATE_DELAY_MS).unref();
    this.updateTimer = setInterval(run, UPDATE_INTERVAL_MS);
    this.updateTimer.unref();
  }

  async openOptions(id: string): Promise<void> {
    const info = this.info(id);
    if (!info?.optionsUrl) throw new Error("This extension has no options page");
    if (!info.enabled) throw new Error("Enable the extension to open its options");
    await this.delegate.createTab(this.profileId, { url: info.optionsUrl, active: true });
  }

  // ------------------------------------------------------------------ Corvus API handlers

  /** Registers a chrome.* handler on electron-chrome-extensions' router; `permission` is enforced there. */
  handle(name: string, callback: RouterCallback, permission?: string): void {
    this.router().handle(name, callback, permission ? { permission } : {});
  }

  /** Wraps an existing electron-chrome-extensions handler. */
  intercept(name: string, wrap: (original: RouterCallback) => RouterCallback): void {
    this.wrapHandler(name, wrap);
  }

  /** Sends an extension event to every loaded extension that declares `permission`. */
  emit(permission: string, event: string, ...args: unknown[]): void {
    for (const ext of this.session.extensions.getAllExtensions()) {
      const perms = (ext.manifest as Manifest).permissions;
      if (Array.isArray(perms) && perms.includes(permission)) this.sendTo(ext.id, event, ...args);
    }
  }

  /** Sends an extension event to one extension (only delivered if it listens for it). */
  sendTo(extensionId: string, event: string, ...args: unknown[]): void {
    (this.router() as RouterInternals & { sendEvent(id: string, event: string, ...args: unknown[]): void }).sendEvent(extensionId, event, ...args);
  }

  /** Called by the window layer after a window's tabs or groups changed. */
  windowChanged(windowId: number): void {
    this.emitter.emit("window-changed", windowId);
  }

  onWindowChanged(listener: (windowId: number) => void): () => void {
    this.emitter.on("window-changed", listener);
    return () => this.emitter.off("window-changed", listener);
  }

  // ------------------------------------------------------------------ hardening

  private router(): RouterInternals {
    return (this.api as unknown as { ctx: { router: RouterInternals } }).ctx.router;
  }

  private wrapHandler(name: string, wrap: (original: RouterCallback) => RouterCallback): void {
    const router = this.router();
    const handler = router.handlers.get(name);
    if (!handler) {
      console.warn(`[corvus] electron-chrome-extensions handler ${name} not found; hardening skipped`);
      return;
    }
    router.handlers.set(name, { ...handler, callback: wrap(handler.callback) });
  }

  private hardenRouter(): void {
    const urlGuard =
      (urlArg: (args: unknown[]) => { url?: unknown } | undefined): ((original: RouterCallback) => RouterCallback) =>
      (original) =>
      (event, ...args) => {
        const props = urlArg(args);
        if (props && typeof props.url === "string") props.url = checkExtensionUrl(props.url, event.extension?.id);
        return original(event, ...args);
      };
    this.wrapHandler(
      "tabs.create",
      urlGuard((args) => args[0] as { url?: unknown } | undefined),
    );
    this.wrapHandler(
      "tabs.update",
      urlGuard((args) => (typeof args[0] === "object" ? args[0] : args[1]) as { url?: unknown } | undefined),
    );
    this.wrapHandler("windows.create", (original) => (event, details, ...rest) => {
      const d = { ...((details ?? {}) as Record<string, unknown>) };
      const urls = Array.isArray(d.url) ? d.url : d.url !== undefined ? [d.url] : [];
      d.url = urls.filter((u): u is string => typeof u === "string").map((u) => checkExtensionUrl(u, event.extension?.id));
      return original(event, d, ...rest);
    });
    this.wrapHandler("tabs.query", (original) => async (event, info, ...rest) => {
      const query = { ...((info ?? {}) as Record<string, unknown>) };
      if ((query.currentWindow === true || query.lastFocusedWindow === true) && query.windowId === undefined) query.windowId = -2;
      const result = (await original(event, query, ...rest)) as Array<{ id: number; index: number; pinned: boolean }>;
      return result.map((tab) => this.withPlacement(tab));
    });
    this.wrapHandler("tabs.get", (original) => async (event, ...args) => {
      const tab = (await original(event, ...args)) as { id: number; index: number; pinned: boolean };
      return this.withPlacement(tab);
    });
  }

  private withPlacement<T extends { id: number }>(tab: T): T {
    const wc = allWebContents.fromId(tab.id);
    const placement = wc ? this.delegate.describeTab(wc) : null;
    return placement ? { ...tab, ...placement } : tab;
  }

  /** Keeps action popups on screen: electron-chrome-extensions positions them from the window origin. */
  private placePopup(popup: PopupLike): void {
    popup.on("will-move", (position: { x: number; y: number }) => {
      const bounds = popup.browserWindow?.getBounds();
      const parent = popup.parent?.getBounds();
      if (!bounds || !parent) return;
      const area = screen.getDisplayMatching(parent).workArea;
      position.x = Math.max(area.x, Math.min(position.x, area.x + area.width - bounds.width));
      position.y = Math.max(area.y, Math.min(position.y, area.y + area.height - bounds.height));
    });
  }
}

interface PopupLike {
  browserWindow?: Electron.BrowserWindow;
  parent?: BaseWindow;
  on(event: "will-move", listener: (position: { x: number; y: number }) => void): void;
}
