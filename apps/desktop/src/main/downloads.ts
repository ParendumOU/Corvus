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
  notifyTimer: NodeJS.Timeout | null;
}

export class DownloadError extends Error {}

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
  /** `${profileId}|${url}`: executables the user chose to keep after an agent requested them. */
  private readonly approved = new Set<string>();
  /** URLs downloaded through "Save … as": always ask where to save. */
  private readonly saveAsUrls = new Set<string>();

  constructor(private readonly ctx: AppContext) {}

  attach(runtime: ProfileRuntime): void {
    const id = runtime.profile.id;
    if (this.profiles.has(id)) return;
    const file = JsonFile.load(path.join(runtime.dataDir, "downloads.json"), () => [], reviveDownloads, 1000);
    this.profiles.set(id, { runtime, file, sessionIds: new Set(), notifyTimer: null });
    runtime.session.on("will-download", (event, item, wc) => this.onWillDownload(runtime, event, item, wc));
  }

  /** Downloads from a container tab of the profile land in the profile's list like any other. */
  attachSession(runtime: ProfileRuntime, session: Session): void {
    session.on("will-download", (event, item, wc) => this.onWillDownload(runtime, event, item, wc));
  }

  /** Download a URL from a tab, always asking where to save (context menu "Save … as"). */
  saveAs(wc: WebContents, url: string): void {
    this.saveAsUrls.add(url);
    wc.downloadURL(url);
  }

  directory(): string {
    const chosen = this.ctx.settings.get().downloads.directory.trim();
    return chosen && path.isAbsolute(chosen) ? chosen : app.getPath("downloads");
  }

  list(runtime: ProfileRuntime): DownloadRecord[] {
    return this.entry(runtime).file.get();
  }

  summary(runtime: ProfileRuntime): DownloadsSummary {
    const entry = this.profiles.get(runtime.profile.id);
    const recent = entry ? entry.file.get().filter((d) => entry.sessionIds.has(d.id)) : [];
    const active = recent.filter(isActiveDownload);
    const total = active.reduce((sum, d) => sum + d.totalBytes, 0);
    const known = active.every((d) => downloadProgress(d) !== null);
    return {
      recent: recent.slice(0, BUBBLE_ITEMS),
      active: active.length,
      progress: active.length > 0 && known && total > 0 ? active.reduce((sum, d) => sum + d.receivedBytes, 0) / total : null,
      attention: recent.some((d) => d.state === "blocked"),
    };
  }

  private entry(runtime: ProfileRuntime): ProfileDownloads {
    this.attach(runtime);
    return this.profiles.get(runtime.profile.id) as ProfileDownloads;
  }

  private onWillDownload(runtime: ProfileRuntime, event: Electron.Event, item: DownloadItem, wc: WebContents | undefined): void {
    const url = item.getURL();
    const filename = item.getFilename() || "download";
    const tab = wc && !wc.isDestroyed() ? this.ctx.windows.byTabWebContents(wc) : undefined;
    if (maybeInterceptPdf(this.ctx, item, tab, this.saveAsUrls)) {
      event.preventDefault();
      return;
    }
    const approvalKey = `${runtime.profile.id}|${url}`;
    const approved = this.approved.delete(approvalKey);
    const agent = approved || tab?.tab.agentControlled === true;

    if (agent && !approved && isExecutableFilename(filename)) {
      event.preventDefault();
      this.commit(runtime, {
        id: crypto.randomUUID(),
        url,
        filename,
        savePath: "",
        mime: item.getMimeType(),
        totalBytes: item.getTotalBytes(),
        receivedBytes: 0,
        state: "blocked",
        startedAt: Date.now(),
        agent: true,
        canResume: false,
      });
      const window = tab?.window ?? this.ctx.windows.forProfile(runtime.profile.id)[0];
      window?.sendCommand({ type: "open-downloads" });
      return;
    }

    const dir = this.directory();
    const ask = this.saveAsUrls.delete(url) || this.ctx.settings.get().downloads.askWhereToSave;
    if (ask) {
      item.setSaveDialogOptions({ defaultPath: path.join(dir, filename) });
    } else {
      fs.mkdirSync(dir, { recursive: true });
      const name = uniqueFilename(filename, (n) => this.reserved.has(path.join(dir, n)) || fs.existsSync(path.join(dir, n)));
      item.setSavePath(path.join(dir, name));
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
      canResume: false,
    };
    this.live.set(record.id, item);
    if (record.savePath) this.reserved.add(record.savePath);
    this.commit(runtime, record);

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
    entry.file.set(fn(entry.file.get()));
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
        this.approved.add(`${runtime.profile.id}|${record.url}`);
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
