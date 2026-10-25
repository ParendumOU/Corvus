import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { app, shell, type DownloadItem, type Session, type WebContents } from "electron";
import type { ProfileId } from "@corvus/shared";
import type { DownloadsSummary } from "../shared/browser-ipc";
import {
  clearFinished,
  downloadProgress,
  isActiveDownload,
  isExecutableFilename,
  removeDownload,
  reviveDownloads,
  safeDownloadPath,
  uniqueFilename,
  upsertDownload,
  type DownloadAction,
  type DownloadRecord,
} from "../shared/downloads";
import type { AppContext } from "./context";
import { JsonFile } from "./json-file";
import { maybeInterceptPdf } from "./pdf-intercept";
import type { ProfileRuntime } from "./profiles";

const BUBBLE_ITEMS = 6;

interface ProfileDownloads {
  runtime: ProfileRuntime;
  file: JsonFile<DownloadRecord[]>;
  /** Downloads started since launch: the toolbar bubble only shows these. */
  sessionIds: Set<string>;
  /** Completed downloads the person has not looked at yet: the toolbar button shows a check. */
  unseen: Set<string>;
  notifyTimer: NodeJS.Timeout | null;
  /** Downloads of private windows: listed while they are open, never written to downloads.json. */
  ephemeral: DownloadRecord[];
}

export class DownloadError extends Error {}

/** How long a download an extension asked for may take to start. */
const EXTENSION_START_TIMEOUT_MS = 30_000;

type DownloadListListener = (profileId: string, before: readonly DownloadRecord[], after: readonly DownloadRecord[]) => void;

interface ExtensionRequest {
  extensionId: string;
  /** Relative path inside the downloads folder (safeDownloadPath). */
  filename?: string;
  saveAs: boolean;
  resolve(id: string): void;
}

/**
 * Downloads for every profile session: save location (OS Downloads folder, a chosen folder or a
 * save dialog), progress, pause/resume/cancel, and a persisted per-profile list. Executables
 * requested by agent-driven tabs are held back until the user keeps them.
 */
export class DownloadManager {
  private readonly profiles = new Map<ProfileId, ProfileDownloads>();
  private readonly live = new Map<string, DownloadItem>();
  /** Save paths of running downloads, so concurrent downloads never pick the same name. */
  private readonly reserved = new Set<string>();
  /**
   * `${profileId}|${url}`: programs the user chose to keep after an agent (null) or an extension
   * (its id) requested them.
   */
  private readonly approved = new Map<string, string | null>();
  /** URLs downloaded through "Save … as": always ask where to save. */
  private readonly saveAsUrls = new Set<string>();
  /** `${profileId}|${url}`: downloads extensions asked for, until the browser starts them. */
  private readonly extensionRequests = new Map<string, ExtensionRequest[]>();
  private readonly listeners = new Set<DownloadListListener>();

  constructor(private readonly ctx: AppContext) {}

  attach(runtime: ProfileRuntime): void {
    const id = runtime.profile.id;
    if (this.profiles.has(id)) return;
    const file = JsonFile.load(path.join(runtime.dataDir, "downloads.json"), () => [], reviveDownloads, 1000);
    this.profiles.set(id, { runtime, file, sessionIds: new Set(), unseen: new Set(), notifyTimer: null, ephemeral: [] });
    runtime.session.on("will-download", (event, item, wc) => this.onWillDownload(runtime, event, item, wc));
  }

  /** Downloads from a container tab of the profile land in the profile's list like any other. */
  attachSession(runtime: ProfileRuntime, session: Session): void {
    const ephemeral = runtime.isPrivateSession(session);
    session.on("will-download", (event, item, wc) => this.onWillDownload(runtime, event, item, wc, ephemeral));
  }

  /** The last private window of a profile closed: its running downloads stop and its list goes. */
  forgetPrivate(runtime: ProfileRuntime): void {
    const entry = this.profiles.get(runtime.profile.id);
    if (!entry || entry.ephemeral.length === 0) return;
    for (const record of entry.ephemeral) this.live.get(record.id)?.cancel();
    entry.ephemeral = [];
    this.notify(entry);
  }

  /** Saved and private downloads, newest first. */
  private records(entry: ProfileDownloads): DownloadRecord[] {
    return entry.ephemeral.length === 0 ? entry.file.get() : [...entry.ephemeral, ...entry.file.get()].sort((a, b) => b.startedAt - a.startedAt);
  }

  /** Download a URL from a tab, always asking where to save (context menu "Save … as"). */
  saveAs(wc: WebContents, url: string): void {
    this.saveAsUrls.add(url);
    wc.downloadURL(url);
  }

  /** Called with the profile's id and its list before and after every change. */
  onChange(listener: DownloadListListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * chrome.downloads.download: starts a download for an extension and resolves with its id once
   * the browser has started it (or held it back, for a program).
   */
  downloadForExtension(runtime: ProfileRuntime, extensionId: string, url: string, opts: { filename?: string; saveAs?: boolean } = {}): Promise<string> {
    if (!/^(https?|ftp|data):/i.test(url)) return Promise.reject(new DownloadError("Invalid URL."));
    const filename = opts.filename === undefined ? undefined : safeDownloadPath(opts.filename);
    if (filename === null) return Promise.reject(new DownloadError("Invalid filename."));
    const key = `${runtime.profile.id}|${url}`;
    return new Promise<string>((resolve, reject) => {
      const request: ExtensionRequest = {
        extensionId,
        ...(filename ? { filename } : {}),
        saveAs: opts.saveAs === true,
        resolve: (id) => {
          clearTimeout(timer);
          resolve(id);
        },
      };
      const timer = setTimeout(() => {
        const list = this.extensionRequests.get(key) ?? [];
        this.extensionRequests.set(key, list.filter((r) => r !== request));
        reject(new DownloadError("The download did not start."));
      }, EXTENSION_START_TIMEOUT_MS);
      this.extensionRequests.set(key, [...(this.extensionRequests.get(key) ?? []), request]);
      runtime.session.downloadURL(url);
    });
  }

  private takeExtensionRequest(profileId: string, url: string): ExtensionRequest | undefined {
    const key = `${profileId}|${url}`;
    const [first, ...rest] = this.extensionRequests.get(key) ?? [];
    if (rest.length > 0) this.extensionRequests.set(key, rest);
    else this.extensionRequests.delete(key);
    return first;
  }

  directory(): string {
    const chosen = this.ctx.settings.get().downloads.directory.trim();
    return chosen && path.isAbsolute(chosen) ? chosen : app.getPath("downloads");
  }

  list(runtime: ProfileRuntime): DownloadRecord[] {
    return this.records(this.entry(runtime));
  }

  summary(runtime: ProfileRuntime): DownloadsSummary {
    const entry = this.profiles.get(runtime.profile.id);
    const recent = entry ? this.records(entry).filter((d) => entry.sessionIds.has(d.id)) : [];
    const active = recent.filter(isActiveDownload);
    const total = active.reduce((sum, d) => sum + d.totalBytes, 0);
    const known = active.every((d) => downloadProgress(d) !== null);
    return {
      recent: recent.slice(0, BUBBLE_ITEMS),
      active: active.length,
      progress: active.length > 0 && known && total > 0 ? active.reduce((sum, d) => sum + d.receivedBytes, 0) / total : null,
      attention: recent.some((d) => d.state === "blocked"),
      finished: recent.filter((d) => d.state === "completed" && entry?.unseen.has(d.id)).length,
      queue: this.ctx.queue.summary(runtime),
    };
  }

  /** The person opened the bubble or the downloads page: drop the toolbar's "finished" check. */
  markSeen(runtime: ProfileRuntime): void {
    const entry = this.entry(runtime);
    if (entry.unseen.size === 0) return;
    entry.unseen.clear();
    this.notify(entry);
  }

  private entry(runtime: ProfileRuntime): ProfileDownloads {
    this.attach(runtime);
    return this.profiles.get(runtime.profile.id) as ProfileDownloads;
  }

  private onWillDownload(runtime: ProfileRuntime, event: Electron.Event, item: DownloadItem, wc: WebContents | undefined, ephemeral = false): void {
    const url = item.getURL();
    const filename = item.getFilename() || "download";
    const tab = wc && !wc.isDestroyed() ? this.ctx.windows.byTabWebContents(wc) : undefined;
    // A tab opened from the download queue ("Open page"): its download belongs to the queue.
    if (tab && this.ctx.queue.claimDownload(runtime, tab.window, tab.tab.id, item)) return;
    // Matched on the address the extension gave, before any redirect.
    const request = [...new Set([...item.getURLChain(), url])].reduce<ExtensionRequest | undefined>((found, u) => found ?? this.takeExtensionRequest(runtime.profile.id, u), undefined);
    if (!request && maybeInterceptPdf(this.ctx, item, tab, this.saveAsUrls)) {
      event.preventDefault();
      return;
    }
    const approvalKey = `${runtime.profile.id}|${url}`;
    const approval = this.approved.get(approvalKey);
    this.approved.delete(approvalKey);
    const approved = approval !== undefined;
    const agent = approval === null || tab?.tab.agentControlled === true;
    const extensionId = request?.extensionId ?? approval ?? undefined;
    // An extension may name the file, inside the downloads folder.
    const suggested = request?.filename;

    // Programs an agent or an extension asked for wait until the person keeps them.
    if ((agent || request) && !approved && (isExecutableFilename(filename) || (suggested !== undefined && isExecutableFilename(path.basename(suggested))))) {
      event.preventDefault();
      const blockedId = crypto.randomUUID();
      this.commit(runtime, {
        id: blockedId,
        url,
        filename,
        savePath: "",
        mime: item.getMimeType(),
        totalBytes: item.getTotalBytes(),
        receivedBytes: 0,
        state: "blocked",
        startedAt: Date.now(),
        agent,
        ...(extensionId ? { extensionId } : {}),
        ...(ephemeral ? { ephemeral: true } : {}),
        canResume: false,
      });
      request?.resolve(blockedId);
      const window = tab?.window ?? this.ctx.windows.forProfile(runtime.profile.id)[0];
      window?.sendCommand({ type: "open-downloads" });
      return;
    }

    const dir = this.directory();
    const ask = this.saveAsUrls.delete(url) || request?.saveAs === true || this.ctx.settings.get().downloads.askWhereToSave;
    if (ask) {
      item.setSaveDialogOptions({ defaultPath: path.join(dir, suggested ?? filename) });
    } else {
      const folder = suggested ? path.join(dir, path.dirname(suggested)) : dir;
      fs.mkdirSync(folder, { recursive: true });
      const base = suggested ? path.basename(suggested) : filename;
      const name = uniqueFilename(base, (n) => this.reserved.has(path.join(folder, n)) || fs.existsSync(path.join(folder, n)));
      item.setSavePath(path.join(folder, name));
    }

    const record: DownloadRecord = {
      id: crypto.randomUUID(),
      url,
      filename,
      savePath: item.getSavePath(),
      mime: item.getMimeType(),
      totalBytes: item.getTotalBytes(),
      receivedBytes: 0,
      state: "progressing",
      startedAt: Date.now(),
      agent,
      ...(extensionId ? { extensionId } : {}),
      ...(ephemeral ? { ephemeral: true } : {}),
      canResume: false,
    };
    this.live.set(record.id, item);
    if (record.savePath) this.reserved.add(record.savePath);
    this.commit(runtime, record);
    request?.resolve(record.id);

    const snapshot = (): DownloadRecord => {
      const savePath = item.getSavePath();
      return {
        ...record,
        filename: savePath ? path.basename(savePath) : record.filename,
        savePath,
        totalBytes: item.getTotalBytes(),
        receivedBytes: item.getReceivedBytes(),
        canResume: item.canResume(),
      };
    };
    item.on("updated", (_e, state) => {
      const next = snapshot();
      if (next.savePath) this.reserved.add(next.savePath);
      this.commit(runtime, { ...next, state: state === "interrupted" ? "interrupted" : item.isPaused() ? "paused" : "progressing" });
    });
    item.once("done", (_e, state) => {
      this.live.delete(record.id);
      const next = snapshot();
      this.reserved.delete(next.savePath);
      if (state === "cancelled" && !next.savePath) {
        // The save dialog was cancelled: nothing was downloaded, so nothing to list.
        this.mutate(runtime, (list) => removeDownload(list, record.id));
        return;
      }
      if (state === "completed") this.entry(runtime).unseen.add(record.id);
      this.commit(runtime, { ...next, state, endedAt: Date.now(), canResume: false });
      this.entry(runtime).file.flush();
    });
  }

  private commit(runtime: ProfileRuntime, record: DownloadRecord): void {
    this.entry(runtime).sessionIds.add(record.id);
    this.mutate(runtime, (list) => upsertDownload(list, record));
  }

  private mutate(runtime: ProfileRuntime, fn: (list: DownloadRecord[]) => DownloadRecord[]): void {
    const entry = this.entry(runtime);
    const before = this.records(entry);
    const after = fn(before);
    entry.file.set(after.filter((d) => !d.ephemeral));
    entry.ephemeral = after.filter((d) => d.ephemeral);
    for (const l of this.listeners) l(runtime.profile.id, before, after);
    this.notify(entry);
  }

  /** Re-render toolbars right away; refresh corvus://downloads pages at most a few times a second. */
  private notify(entry: ProfileDownloads): void {
    const windows = this.ctx.windows.forProfile(entry.runtime.profile.id);
    for (const w of windows) w.pushState();
    if (entry.notifyTimer) return;
    entry.notifyTimer = setTimeout(() => {
      entry.notifyTimer = null;
      for (const w of this.ctx.windows.forProfile(entry.runtime.profile.id)) w.notifyInternalPages({ type: "downloads-changed" }, ["downloads"]);
    }, 250);
  }

  act(runtime: ProfileRuntime, id: string, action: DownloadAction): void {
    const record = this.list(runtime).find((d) => d.id === id);
    if (!record) throw new DownloadError("Unknown download");
    const item = this.live.get(id);
    switch (action) {
      case "pause":
        item?.pause();
        break;
      case "resume":
        if (item?.canResume()) item.resume();
        else if (!item) this.retry(runtime, record);
        break;
      case "cancel":
        item?.cancel();
        break;
      case "open":
        if (record.state === "completed" && record.savePath) void shell.openPath(record.savePath);
        break;
      case "show":
        if (record.savePath) shell.showItemInFolder(record.savePath);
        break;
      case "remove":
        item?.cancel();
        this.mutate(runtime, (list) => removeDownload(list, id));
        break;
      case "discard":
        if (record.state === "blocked") this.mutate(runtime, (list) => removeDownload(list, id));
        break;
      case "keep":
        if (record.state !== "blocked") break;
        this.mutate(runtime, (list) => removeDownload(list, id));
        this.approved.set(`${runtime.profile.id}|${record.url}`, record.extensionId ?? null);
        runtime.session.downloadURL(record.url);
        break;
      case "retry":
        if (!item && (record.state === "cancelled" || record.state === "interrupted")) this.retry(runtime, record);
        break;
    }
  }

  private retry(runtime: ProfileRuntime, record: DownloadRecord): void {
    this.mutate(runtime, (list) => removeDownload(list, record.id));
    runtime.session.downloadURL(record.url);
  }

  clear(runtime: ProfileRuntime): void {
    this.mutate(runtime, clearFinished);
  }

  flush(): void {
    for (const entry of this.profiles.values()) entry.file.flush();
  }
}
