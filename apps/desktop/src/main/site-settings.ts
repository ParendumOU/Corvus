import path from "node:path";
import {
  resetSitePermissions,
  reviveSitePermissions,
  setSitePermission,
  type PermissionDecision,
  type PermissionKind,
  type SitePermissionEntry,
  type SitePermissionMap,
} from "../shared/permissions";
import { forgetSiteApps, isAppAllowed, listSiteSettings, reviveExternalApps, setAppAllowed, type ExternalAppMap } from "../shared/external-apps";
import { reviveZoomMap, setZoom, zoomFor, type ZoomMap } from "../shared/zoom";
import { addNeverSave, noteLastLogin, reviveLastLogins, reviveNeverSave, type LastLogins } from "../shared/autofill-sites";
import { JsonFile } from "./json-file";

interface SiteSettingsFile {
  version: 1;
  permissions: SitePermissionMap;
  zoom: ZoomMap;
  /** Per site (see autofillSiteOf): a login of the account the autofill filled there last. */
  lastLogins: LastLogins;
  /** Hosts where the save-password prompt is never offered ("Never for this site"). */
  neverSave: string[];
  /** Per site, the schemes of links it may open in another app without asking. */
  externalApps: ExternalAppMap;
}

function revive(raw: unknown): SiteSettingsFile {
  const data = (typeof raw === "object" && raw !== null ? raw : {}) as Partial<SiteSettingsFile>;
  return {
    version: 1,
    permissions: reviveSitePermissions(data.permissions),
    zoom: reviveZoomMap(data.zoom),
    lastLogins: reviveLastLogins(data.lastLogins),
    neverSave: reviveNeverSave(data.neverSave),
    externalApps: reviveExternalApps(data.externalApps),
  };
}

/**
 * Per-profile, per-site settings: remembered permission decisions, the apps a site may open without
 * asking, zoom levels and what the autofill remembers (the account filled last, the sites never to
 * offer saving on). Local to this device.
 */
export class SiteSettingsStore {
  private readonly file: JsonFile<SiteSettingsFile>;
  private readonly listeners = new Set<() => void>();

  constructor(dir: string) {
    this.file = JsonFile.load(path.join(dir, "site-settings.json"), () => ({ version: 1, permissions: {}, zoom: {}, lastLogins: {}, neverSave: [], externalApps: {} }), revive, 300);
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private commit(next: SiteSettingsFile, notify: boolean): void {
    this.file.set(next);
    if (notify) for (const listener of this.listeners) listener();
  }

  permission(origin: string, kind: PermissionKind): PermissionDecision | undefined {
    return this.file.get().permissions[origin]?.[kind];
  }

  permissionsFor(origin: string): Partial<Record<PermissionKind, PermissionDecision>> {
    return { ...this.file.get().permissions[origin] };
  }

  /** Every site with a remembered permission or an app it may open, for Settings. */
  listPermissions(): SitePermissionEntry[] {
    const { permissions, externalApps } = this.file.get();
    return listSiteSettings(permissions, externalApps);
  }

  setPermission(origin: string, kind: PermissionKind, decision: PermissionDecision | null): void {
    const current = this.file.get();
    const permissions = setSitePermission(current.permissions, origin, kind, decision);
    if (permissions !== current.permissions) this.commit({ ...current, permissions }, true);
  }

  resetPermissions(origin: string): void {
    const current = this.file.get();
    const permissions = resetSitePermissions(current.permissions, origin);
    const externalApps = forgetSiteApps(current.externalApps, origin);
    if (permissions !== current.permissions || externalApps !== current.externalApps) this.commit({ ...current, permissions, externalApps }, true);
  }

  /** Whether the site may open links of `scheme` in their app without asking ("Always allow"). */
  externalAppAllowed(origin: string, scheme: string): boolean {
    return isAppAllowed(this.file.get().externalApps, origin, scheme);
  }

  setExternalAppAllowed(origin: string, scheme: string, allowed: boolean): void {
    const current = this.file.get();
    const externalApps = setAppAllowed(current.externalApps, origin, scheme, allowed);
    if (externalApps !== current.externalApps) this.commit({ ...current, externalApps }, true);
  }

  zoom(key: string | null): number {
    return zoomFor(this.file.get().zoom, key);
  }

  setZoom(key: string | null, factor: number): void {
    if (!key) return;
    const current = this.file.get();
    const zoom = setZoom(current.zoom, key, factor);
    if (JSON.stringify(zoom) !== JSON.stringify(current.zoom)) this.commit({ ...current, zoom }, false);
  }

  /** The id of a login of the account filled last on a site, if any. */
  lastLogin(site: string): string | undefined {
    return site ? this.file.get().lastLogins[site]?.id : undefined;
  }

  noteLastLogin(site: string, id: string): void {
    const current = this.file.get();
    if (site && id) this.commit({ ...current, lastLogins: noteLastLogin(current.lastLogins, site, id, Date.now()) }, false);
  }

  neverSave(): string[] {
    return [...this.file.get().neverSave];
  }

  isNeverSave(host: string): boolean {
    return Boolean(host) && this.file.get().neverSave.includes(host);
  }

  /** Adds a host to the "Never saved" list, or takes it off; the list as it is now. */
  setNeverSave(host: string, never: boolean): string[] {
    const current = this.file.get();
    const neverSave = never ? addNeverSave(current.neverSave, host) : current.neverSave.filter((h) => h !== host);
    if (neverSave.length !== current.neverSave.length) this.commit({ ...current, neverSave }, false);
    return [...neverSave];
  }

  flush(): void {
    this.file.flush();
  }
}
