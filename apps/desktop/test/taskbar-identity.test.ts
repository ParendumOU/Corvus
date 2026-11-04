import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { WINDOWS_APP_ID, isPortableAppId, notificationIdentityKey, portableAppId, shortcutToRemove, taskbarIdentity, windowAppDetails } from "../src/shared/taskbar-identity";

const builderYml = readFileSync(new URL("../electron-builder.yml", import.meta.url), "utf8");

describe("taskbar identity", () => {
  it("is the appId the installer gives its shortcuts", () => {
    expect(/^appId: (.+)$/m.exec(builderYml)?.[1]?.trim()).toBe(WINDOWS_APP_ID);
  });

  it("lets the installed app's windows belong to its shortcuts", () => {
    const identity = taskbarIdentity(null);
    expect(identity).toEqual({ appId: "com.parendum.corvus", relaunch: null });
    expect(windowAppDetails(identity)).toEqual({ appId: "com.parendum.corvus" });
  });

  it("makes a pin of a portable window start the portable file, not its temporary copy", () => {
    const identity = taskbarIdentity("C:\\Users\\Ana\\Desktop\\My Corvus.exe");
    expect(identity.appId).toBe(portableAppId("C:\\Users\\Ana\\Desktop\\My Corvus.exe"));
    expect(windowAppDetails(identity)).toEqual({
      appId: identity.appId,
      relaunchCommand: '"C:\\Users\\Ana\\Desktop\\My Corvus.exe"',
      relaunchDisplayName: "Corvus",
      appIconPath: "C:\\Users\\Ana\\Desktop\\My Corvus.exe",
      appIconIndex: 0,
    });
  });

  it("gives each portable file an ID of its own, so a moved or renamed one never inherits a dead pin", () => {
    const id = portableAppId("C:\\Users\\Ana\\Desktop\\My Corvus.exe");
    expect(id).toMatch(/^com\.parendum\.corvus\.portable\.[0-9a-f]{8}$/);
    expect(portableAppId("c:\\users\\ana\\desktop\\MY CORVUS.EXE")).toBe(id);
    expect(portableAppId("D:\\Apps\\My Corvus.exe")).not.toBe(id);
    expect(portableAppId("C:\\Users\\Ana\\Desktop\\Corvus-Portable-0.38.0.exe")).not.toBe(id);
  });

  it("keeps the Start menu shortcut Electron makes from leading to a build's folder that is gone", () => {
    const appId = portableAppId("C:\\Users\\Ana\\Desktop\\Corvus-Portable.exe");
    const running = { exe: "C:\\Users\\Ana\\AppData\\Local\\Corvus-portable\\NEW\\Corvus.exe", appId };
    const link = (target: string, id = appId, targetExists = true) => ({ target, appUserModelId: id, targetExists });
    const old = "C:\\Users\\Ana\\AppData\\Local\\Corvus-portable\\OLD\\Corvus.exe";
    // At start: its own shortcut to another build goes, even while that build's folder is still there.
    expect(shortcutToRemove(link(old, appId, false), running, "start")).toBe(true);
    expect(shortcutToRemove(link(old), running, "start")).toBe(true);
    expect(shortcutToRemove(link(running.exe.toLowerCase()), running, "start")).toBe(false);
    // Another portable file's: only when it leads nowhere; the older shared ID's too.
    expect(shortcutToRemove(link(old, portableAppId("D:\\Corvus.exe")), running, "start")).toBe(false);
    expect(shortcutToRemove(link(old, portableAppId("D:\\Corvus.exe"), false), running, "start")).toBe(true);
    expect(shortcutToRemove(link("F:\\old\\Corvus-Portable-0.36.3.exe", "com.parendum.corvus.portable", false), running, "start")).toBe(true);
    // When it quits: its own goes, nobody else's.
    expect(shortcutToRemove(link(running.exe), running, "quit")).toBe(true);
    expect(shortcutToRemove(link(old, portableAppId("D:\\Corvus.exe")), running, "quit")).toBe(false);
    // The installed Corvus's shortcut is never touched, even when it leads nowhere.
    expect(shortcutToRemove(link("C:\\Program Files\\Corvus\\Corvus.exe", WINDOWS_APP_ID, false), running, "start")).toBe(false);
    expect(shortcutToRemove(link("C:\\Program Files\\Corvus\\Corvus.exe", WINDOWS_APP_ID), running, "quit")).toBe(false);
    expect(isPortableAppId("com.parendum.corvus.portablex")).toBe(false);
  });

  it("registers a portable file's ID for notifications under the current user", () => {
    expect(notificationIdentityKey("com.parendum.corvus.portable.0a1b2c3d")).toBe("HKCU\\Software\\Classes\\AppUserModelId\\com.parendum.corvus.portable.0a1b2c3d");
  });
});
