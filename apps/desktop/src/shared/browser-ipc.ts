/**
 * IPC contracts for the daily-browser features (permissions, site info, find, zoom, downloads).
 * Merged into ChromeRpc / InternalRpc / WindowState in ./ipc.ts.
 */
import type { DownloadAction, DownloadRecord } from "./downloads";
import type { PermissionDecision, PermissionKind, SitePermissionEntry } from "./permissions";
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
}

export interface BrowserWindowExtras {
  permissionPrompt: PermissionPromptView | null;
  find: FindState | null;
  zoomPercent: number;
  downloads: DownloadsSummary;
}

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
}

export type BrowserChromeCommand = { type: "find-focus" } | { type: "open-downloads" };

export interface BrowserChromeRpc {
  "permissions.respond"(promptId: string, response: PermissionResponse, remember: boolean, sourceId?: string): void;
  "site.info"(): SiteInfo | null;
  "site.setPermission"(kind: PermissionKind, decision: PermissionDecision | null): SiteInfo | null;
  "site.resetPermissions"(): SiteInfo | null;
  "find.query"(text: string): void;
  "find.step"(forward: boolean): void;
  "find.close"(): void;
  "zoom.step"(delta: 1 | -1 | 0): void;
  "downloads.action"(id: string, action: DownloadAction): void;
  "downloads.openPage"(): void;
}

export interface BrowserInternalRpc {
  "downloads.list"(): DownloadRecord[];
  "downloads.act"(id: string, action: DownloadAction): void;
  "downloads.clear"(): void;
  "downloads.chooseDirectory"(): SettingsView | null;
  "sitePermissions.list"(): SitePermissionEntry[];
  "sitePermissions.set"(origin: string, kind: PermissionKind, decision: PermissionDecision | null): SitePermissionEntry[];
  "sitePermissions.reset"(origin: string): SitePermissionEntry[];
}

export type BrowserInternalEvent = { type: "downloads-changed" } | { type: "site-permissions-changed" };
