import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { WINDOWS_APP_ID, notificationIdentityKey, portableAppId, taskbarIdentity, windowAppDetails } from "../src/shared/taskbar-identity";

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

  it("registers a portable file's ID for notifications under the current user", () => {
    expect(notificationIdentityKey("com.parendum.corvus.portable.0a1b2c3d")).toBe("HKCU\\Software\\Classes\\AppUserModelId\\com.parendum.corvus.portable.0a1b2c3d");
  });
});
