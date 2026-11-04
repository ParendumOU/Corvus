import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { app, type BaseWindow } from "electron";
import { notificationIdentityKey, taskbarIdentity, windowAppDetails, type TaskbarIdentity } from "../shared/taskbar-identity";
import { paths } from "./paths";
import { portableExecutable } from "./portable-updater";

let identity: TaskbarIdentity | null | undefined;

/** Windows, packaged builds only (see shared/taskbar-identity.ts). */
function current(): TaskbarIdentity | null {
  if (identity === undefined) identity = process.platform === "win32" && app.isPackaged ? taskbarIdentity(portableExecutable()) : null;
  return identity;
}

/** Before any window exists: the app's ID, which also covers windows other code opens. */
export function applyAppTaskbarIdentity(): void {
  const id = current();
  if (id) app.setAppUserModelId(id.appId);
}

/** Each Corvus window: its ID and what a taskbar pin of it starts. */
export function applyWindowTaskbarIdentity(win: BaseWindow): void {
  const id = current();
  if (id) win.setAppDetails(windowAppDetails(id));
}

/**
 * Windows drops, without a word, the notifications of an app ID it does not know. The installer's
 * Start menu shortcut names the installed Corvus; a portable file has none, so its ID is registered
 * for the current user with Corvus's name and icon (a copy in `userData`, as Windows cannot read the
 * one inside the app's archive). In the background, once per start.
 */
export function registerNotificationIdentity(userData: string): void {
  const id = current();
  if (!id?.relaunch) return;
  const icon = path.join(userData, "notification-icon.png");
  try {
    if (!fs.existsSync(icon)) fs.writeFileSync(icon, fs.readFileSync(paths.icon));
  } catch (err) {
    console.error("[corvus] could not write the notification icon:", err);
    return;
  }
  const key = notificationIdentityKey(id.appId);
  const add = (name: string, value: string, next?: () => void): void => {
    execFile("reg", ["add", key, "/v", name, "/t", "REG_SZ", "/d", value, "/f"], { windowsHide: true, timeout: 15_000 }, (err) => {
      if (err) console.error(`[corvus] could not register ${name} for notifications:`, err.message);
      else next?.();
    });
  };
  add("DisplayName", "Corvus", () => add("IconUri", icon));
}
