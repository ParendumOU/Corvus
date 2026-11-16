import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { app, shell } from "electron";
import { DEELEVATED_SWITCH, deelevatedArgs, parseElevated, staysElevated } from "../shared/default-browser";
import { portableExecutable } from "./portable-updater";

const SHORTCUT_PREFIX = "corvus-deelevate-";

/** Full path to a Windows tool: on the PATH, Git for Windows' `whoami` (no /groups) can come first. */
function windowsTool(dir: string, exe: string): string {
  return path.join(process.env.SystemRoot ?? String.raw`C:\Windows`, dir, exe);
}

function isElevated(): boolean {
  const res = spawnSync(windowsTool("System32", "whoami.exe"), ["/groups"], { windowsHide: true, timeout: 5_000, encoding: "utf8" });
  if (res.error || res.status !== 0) {
    // Unknown is taken as not elevated (Corvus starts as it is); the log says why links may not reach it.
    console.warn(`[deelevate] whoami failed (${res.error?.message ?? `exit ${res.status}`}): staying as started`);
    return false;
  }
  return parseElevated(String(res.stdout ?? ""));
}

/** Shortcuts left by earlier relaunches (the new copy cannot delete its own before explorer reads it). */
function removeOldShortcuts(): void {
  try {
    for (const name of fs.readdirSync(os.tmpdir())) {
      if (!name.startsWith(SHORTCUT_PREFIX)) continue;
      const file = path.join(os.tmpdir(), name);
      if (Date.now() - fs.statSync(file).mtimeMs > 60_000) fs.rmSync(file, { force: true });
    }
  } catch {
    // Best effort: a leftover shortcut in the temp folder does no harm.
  }
}

/**
 * Windows only, packaged builds: when the first Corvus runs as administrator (started from an elevated
 * terminal or by an AI agent running elevated), Windows drops the hand-off from every normal launch, so
 * links from other apps (a sign-in page, an email link) never open. Corvus then starts the same launch
 * again through Explorer, which runs it as the normal user, and returns true: the caller quits. The new
 * copy carries DEELEVATED_SWITCH, so if it still ends up elevated (UAC off) it stays instead of looping.
 * The portable build starts its launcher again, which sets the portable environment the new copy needs
 * (its taskbar identity, updates). CORVUS_ALLOW_ELEVATED=1 or a launch set up by environment variables
 * (another profile, a test run) keeps an elevated Corvus.
 */
export function relaunchWithoutAdminRights(): boolean {
  if (process.platform !== "win32" || !app.isPackaged) return false;
  if (process.argv.includes(DEELEVATED_SWITCH)) {
    removeOldShortcuts();
    return false;
  }
  if (staysElevated(process.env) || !isElevated()) return false;
  const lnk = path.join(os.tmpdir(), `${SHORTCUT_PREFIX}${process.pid}.lnk`);
  const written = shell.writeShortcutLink(lnk, "create", {
    target: portableExecutable() ?? process.execPath,
    args: deelevatedArgs(process.argv),
    cwd: process.cwd(),
  });
  if (!written) return false;
  try {
    spawn(windowsTool("", "explorer.exe"), [lnk], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    }).unref();
  } catch {
    fs.rmSync(lnk, { force: true });
    return false;
  }
  return true;
}
