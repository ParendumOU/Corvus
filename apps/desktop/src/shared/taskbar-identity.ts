/**
 * Who Corvus is to the Windows taskbar. Pins, jump lists and notifications belong to an Application
 * User Model ID (AUMID). The installer gives its Start menu and desktop shortcuts the
 * electron-builder appId, so the installed app takes the same one: its windows then belong to those
 * shortcuts and to a pin made from them, whichever way Corvus was started.
 *
 * The portable build runs from a copy its launcher unpacks into a folder of each build's own,
 * removed once another build has run, so a pin of its window would start that copy and break. Its windows name the portable file itself as what a pin starts (the self-update keeps that
 * file's name and place), under an ID of their own so they never mix with an installed Corvus.
 *
 * That ID names the portable file too. Windows keeps what it learned about an ID (a pin's shortcut
 * and its target) in a cache that outlives the shortcut and restarts, and takes the taskbar icon
 * from there over what the window says: once the file an ID was pinned with is moved, renamed or
 * deleted, every window of that ID shows a blank icon. A portable file of its own ID never inherits
 * an older file's dead entry.
 */

/** electron-builder.yml `appId` (test/taskbar-identity.test.ts checks they match). */
export const WINDOWS_APP_ID = "com.parendum.corvus";

/** The ID of a portable file's windows: one per file path (Windows paths ignore case). */
export function portableAppId(portableFile: string): string {
  // FNV-1a: short, stable and dependency-free; it only has to tell a few paths apart.
  let hash = 0x811c9dc5;
  for (const ch of portableFile.toLowerCase()) {
    hash ^= ch.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${WINDOWS_APP_ID}.portable.${hash.toString(16).padStart(8, "0")}`;
}

export interface TaskbarIdentity {
  appId: string;
  /** What a taskbar pin of a window starts instead of the running executable. */
  relaunch: { command: string; displayName: string; iconPath: string } | null;
}

export function taskbarIdentity(portableFile: string | null): TaskbarIdentity {
  if (!portableFile) return { appId: WINDOWS_APP_ID, relaunch: null };
  return {
    appId: portableAppId(portableFile),
    relaunch: { command: `"${portableFile}"`, displayName: "Corvus", iconPath: portableFile },
  };
}

/** Where Windows learns the name and icon of an app ID that has no shortcut, for its notifications. */
export function notificationIdentityKey(appId: string): string {
  return `HKCU\\Software\\Classes\\AppUserModelId\\${appId}`;
}

/** The options for Electron's BrowserWindow.setAppDetails. */
export function windowAppDetails(identity: TaskbarIdentity): {
  appId: string;
  relaunchCommand?: string;
  relaunchDisplayName?: string;
  appIconPath?: string;
  appIconIndex?: number;
} {
  const { appId, relaunch } = identity;
  if (!relaunch) return { appId };
  return { appId, relaunchCommand: relaunch.command, relaunchDisplayName: relaunch.displayName, appIconPath: relaunch.iconPath, appIconIndex: 0 };
}
