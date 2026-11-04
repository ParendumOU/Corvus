import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { app, shell, type BaseWindow } from "electron";
import { PORTABLE_TOAST_CLSID, notificationIdentityKey, shortcutToRemove, taskbarIdentity, windowAppDetails, type TaskbarIdentity } from "../shared/taskbar-identity";
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
  if (!id) return;
  app.setAppUserModelId(id.appId);
  if (id.relaunch) app.setToastActivatorCLSID(PORTABLE_TOAST_CLSID);
}

/** The Start menu shortcut Electron makes for notifications: Programs\<product name>.lnk. */
function notificationShortcut(): string {
  return path.join(app.getPath("appData"), "Microsoft", "Windows", "Start Menu", "Programs", `${app.getName()}.lnk`);
}

/**
 * A portable Corvus keeps that shortcut from leading to a build's folder that is gone (see
 * shortcutToRemove): at start, before its windows show, so the taskbar does not take their icon from
 * a dead shortcut, and when it quits.
 */
export function tidyNotificationShortcut(when: "start" | "quit"): void {
  const id = current();
  if (!id?.relaunch) return;
  const file = notificationShortcut();
  try {
    if (!fs.existsSync(file)) return;
    const link = shell.readShortcutLink(file);
    const target = link.target ?? "";
    const remove = shortcutToRemove(
      { target, appUserModelId: link.appUserModelId ?? "", targetExists: target !== "" && fs.existsSync(target) },
      { exe: process.execPath, appId: id.appId },
      when,
    );
    if (!remove) return;
    fs.rmSync(file, { force: true });
    if (when === "start") deadShortcutRemovedAt = Date.now();
  } catch (err) {
    console.error("[corvus] could not check the Start menu shortcut:", err);
  }
}

/** When a dead shortcut was removed at start (0: none was). */
let deadShortcutRemovedAt = 0;
/** How long after that removal new windows still get their taskbar icon looked up again. */
const RELOOK_WINDOW_MS = 60_000;
/** Time for Windows to notice the removal before a window's icon is looked up again. */
const RELOOK_DELAY_MS = 5000;

/** Each Corvus window: its ID and what a taskbar pin of it starts. */
export function applyWindowTaskbarIdentity(win: BaseWindow): void {
  const id = current();
  if (!id) return;
  const details = windowAppDetails(id);
  win.setAppDetails(details);
  if (!deadShortcutRemovedAt || Date.now() - deadShortcutRemovedAt > RELOOK_WINDOW_MS) return;
  // The taskbar may have taken the window's icon from that shortcut before Windows noticed it was
  // gone: under another ID for a moment and back, the window gets its icon looked up again.
  setTimeout(() => {
    if (win.isDestroyed()) return;
    win.setAppDetails({ appId: `${id.appId}.relook` });
    setTimeout(() => {
      if (!win.isDestroyed()) win.setAppDetails(details);
    }, 400);
  }, RELOOK_DELAY_MS);
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
