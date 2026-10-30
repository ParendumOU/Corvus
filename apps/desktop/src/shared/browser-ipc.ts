/**
 * IPC contracts for the daily-browser features (permissions, site info, find, zoom, downloads).
 * Merged into ChromeRpc / InternalRpc / WindowState in ./ipc.ts.
 */
import type { DialogView } from "./dialog";
import type { DownloadAction, DownloadRecord } from "./downloads";
import type { QueueAction, QueueView } from "./download-queue";
import type { GrabbedPackage } from "./link-grabber";
import type { PermissionDecision, PermissionKind, SitePermissionEntry } from "./permissions";
import type { PhoneShare } from "./phone-share";
import type { SettingsView } from "./settings";

export interface DisplaySourceView {
  id: string;
  name: string;
  kind: "screen" | "window";
}

export interface PermissionPromptView {
  id: string;
  origin: string;
  kinds: PermissionKind[];
  /** The tab is driven by an AI agent: the answer applies to this page only. */
  agent: boolean;
  /** Whether "remember for this site" can be offered. */
  rememberable: boolean;
  /** Screens and windows to choose from for screen capture requests. */
  sources?: DisplaySourceView[];
}

export type PermissionResponse = "allow" | "block" | "dismiss";

export interface FindState {
  text: string;
  /** 1-based index of the highlighted match, 0 when none. */
  active: number;
  matches: number;
}

export interface DownloadsSummary {
  /** Downloads started in this session, newest first (at most a handful, for the toolbar bubble). */
  recent: DownloadRecord[];
  active: number;
  /** Overall progress of running downloads (0..1), null when unknown. */
  progress: number | null;
  /** A download needs a decision (e.g. a program requested by an AI agent). */
  attention: boolean;
  /** Downloads that finished since the person last opened the bubble or the downloads page. */
  finished: number;
  /** Corvus's download queue, while it has files left. */
  queue: QueueSummary | null;
}

export interface QueueSummary {
  /** Files not finished yet (failed ones aside). */
  left: number;
  running: number;
  /** Files whose host needs the person (a CAPTCHA, a sign-in). */
  attention: number;
  /** Progress of the files left (0..1), null when sizes are unknown. */
  progress: number | null;
}

export interface BrowserWindowExtras {
  permissionPrompt: PermissionPromptView | null;
  /** A question Corvus asks in this window (shared/dialog.ts), shown as a modal over everything. */
  dialog: DialogView | null;
  /** Questions shown as bars under the toolbar (an AI agent asks for a hand in the page). */
  dialogBars: DialogView[];
  find: FindState | null;
  zoomPercent: number;
  downloads: DownloadsSummary;
  /** Download links in the text just copied (the link grabber chip), 0 when none. */
  copiedLinks: number;
  /** This launch's "Corvus is not your default browser" bar is shown in this window. */
  defaultBrowserOffer: boolean;
}

/** Whether Corvus is the default browser here, and whether this system lets Corvus ask. */
export interface DefaultBrowserView {
  /** False in development builds and where the system has no way to set it (e.g. no xdg-settings). */
  supported: boolean;
  isDefault: boolean;
  platform: string;
  /** Windows: Corvus is listed in Default apps. */
  registered?: boolean;
}

/**
 * What "Make default" did: "default" (Linux sets it), "asked" (macOS asks the person),
 * "settings-opened" (Windows Default apps opened on Corvus), or "failed".
 */
export type MakeDefaultResult = "default" | "asked" | "settings-opened" | "failed";

/** The default-browser bar's buttons. */
export type DefaultBrowserAnswer = "make" | "later" | "never";

export interface SitePermissionView {
  kind: PermissionKind;
  decision: PermissionDecision;
  /** Granted or blocked for the current page only. */
  temporary: boolean;
}

export interface SiteInfo {
  origin: string;
  host: string;
  scheme: "https" | "http" | "file" | "other";
  secure: boolean;
  agent: boolean;
  permissions: SitePermissionView[];
  zoomPercent: number;
  /** The site's certificate is not valid ("ERR_CERT_AUTHORITY_INVALID"): not secure, whatever the scheme. */
  certError?: string;
  /** ...and the person (or an agent in full auto) chose to go on anyway, for this session. */
  certAccepted?: boolean;
}

export type BrowserChromeCommand = { type: "find-focus" } | { type: "open-downloads" } | { type: "open-share"; share: PhoneShare };

export interface BrowserChromeRpc {
  "permissions.respond"(promptId: string, response: PermissionResponse, remember: boolean, sourceId?: string): void;
  "site.info"(): SiteInfo | null;
  "site.setPermission"(kind: PermissionKind, decision: PermissionDecision | null): SiteInfo | null;
  "site.resetPermissions"(): SiteInfo | null;
  /** "Turn on warnings again" for a site whose invalid certificate was accepted this session. */
  "site.restoreCertWarnings"(): void;
  "find.query"(text: string): void;
  "find.step"(forward: boolean): void;
  "find.close"(): void;
  "zoom.step"(delta: 1 | -1 | 0): void;
  "downloads.action"(id: string, action: DownloadAction): void;
  "downloads.openPage"(): void;
  /** The bubble was opened: finished downloads stop showing the check on the toolbar button. */
  "downloads.markSeen"(): void;
  /** The copied-links chip: put them in the link grabber and open it, or dismiss them. */
  "grabber.grabCopied"(): number;
  /** The chip's "Download": the copied links go straight to the download queue. */
  "grabber.queueCopied"(): number;
  "grabber.dismissCopied"(): void;
  /** The default-browser bar: Make default, Not now, Don't ask again. */
  "defaultBrowser.answer"(choice: DefaultBrowserAnswer): MakeDefaultResult | null;
  /** The chip's "AI" button: Corvus's agent finds and queues the copied links' files. */
  "grabber.downloadCopiedWithAi"(): boolean;
  /** "Send to your phone": sends the page to the linked Telegram chat. */
  "share.telegram"(url: string, title: string): void;
  /** Sends the page to a phone paired with this profile's sync (Corvus for mobile notifies). */
  "share.device"(deviceId: string, url: string, title: string): void;
  "share.copy"(url: string): void;
}

export interface BrowserInternalRpc {
  "downloads.list"(): DownloadRecord[];
  "downloads.act"(id: string, action: DownloadAction): void;
  "downloads.clear"(): void;
  "downloads.chooseDirectory"(): SettingsView | null;
  "grabber.list"(): GrabbedPackage[];
  /** Adds the download links in pasted text; returns how many were new. */
  /** `name`: all the links as one package of that name (its folder in Downloads). */
  "grabber.addText"(text: string, name?: string): number;
  "grabber.rename"(id: string, name: string): void;
  "grabber.remove"(ids: string[]): void;
  "grabber.clear"(): void;
  /** Watching the clipboard for download links: the setting, changed when `on` is given. */
  "grabber.watchClipboard"(on?: boolean): boolean;
  /** Starts packages or links (by id) and takes them out of the grabber; returns how many started. */
  "grabber.download"(ids: string[]): number;
  /** "Download with AI": Corvus's agent finds the real files of these packages or links and queues them. */
  "grabber.downloadWithAi"(ids: string[]): boolean;
  "defaultBrowser.status"(): DefaultBrowserView;
  /** Makes Corvus the default as far as this system allows; returns what happened and the new status. */
  "defaultBrowser.make"(): { result: MakeDefaultResult; status: DefaultBrowserView };
  /** Windows: removes Corvus from Default apps. */
  "defaultBrowser.unregister"(): DefaultBrowserView;
  "queue.list"(): QueueView;
  /** Pause, resume, retry or remove a package (every file) or one file. */
  "queue.act"(id: string, action: QueueAction): void;
  /** Moves a package up (-1) or down (1) in the queue. */
  "queue.move"(id: string, delta: number): void;
  /** Renames a package and moves its folder (not while it downloads). */
  "queue.rename"(id: string, name: string): void;
  /** Shows a package's folder in the system's file manager. */
  "queue.openFolder"(id: string): void;
  "queue.clearDone"(): void;
  /** Extracts a finished package's archives now, trying the password first when one is given. */
  "queue.extract"(id: string, password?: string): void;
  /** Opens the page of a file that needs the person; what it downloads goes to that queue item. */
  "queue.openPage"(id: string): void;
  "sitePermissions.list"(): SitePermissionEntry[];
  "sitePermissions.set"(origin: string, kind: PermissionKind, decision: PermissionDecision | null): SitePermissionEntry[];
  "sitePermissions.reset"(origin: string): SitePermissionEntry[];
  /** Stops a site from opening links of `scheme` in their app without asking ("Always allow" undone). */
  "sitePermissions.forgetExternalApp"(origin: string, scheme: string): SitePermissionEntry[];
}

export type BrowserInternalEvent = { type: "downloads-changed" } | { type: "site-permissions-changed" };
