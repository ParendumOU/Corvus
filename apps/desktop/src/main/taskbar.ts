import { app, type BaseWindow } from "electron";
import { taskbarIdentity, windowAppDetails, type TaskbarIdentity } from "../shared/taskbar-identity";
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
