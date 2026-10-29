/**
 * Who Corvus is to the Windows taskbar. Pins, jump lists and notifications belong to an Application
 * User Model ID (AUMID). The installer gives its Start menu and desktop shortcuts the
 * electron-builder appId, so the installed app takes the same one: its windows then belong to those
 * shortcuts and to a pin made from them, whichever way Corvus was started.
 *
 * The portable build runs from a copy its launcher unpacks to a temporary folder, deleted when
 * Corvus quits and different for every version, so a pin of its window would start that copy and
 * break. Its windows name the portable file itself as what a pin starts (the self-update keeps that
 * file's name and place), under an ID of their own so they never mix with an installed Corvus.
 */

/** electron-builder.yml `appId` (test/taskbar-identity.test.ts checks they match). */
export const WINDOWS_APP_ID = "com.parendum.corvus";

export interface TaskbarIdentity {
  appId: string;
  /** What a taskbar pin of a window starts instead of the running executable. */
  relaunch: { command: string; displayName: string; iconPath: string } | null;
}

export function taskbarIdentity(portableFile: string | null): TaskbarIdentity {
  if (!portableFile) return { appId: WINDOWS_APP_ID, relaunch: null };
  return {
    appId: `${WINDOWS_APP_ID}.portable`,
    relaunch: { command: `"${portableFile}"`, displayName: "Corvus", iconPath: portableFile },
  };
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
