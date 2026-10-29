import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { WINDOWS_APP_ID, taskbarIdentity, windowAppDetails } from "../src/shared/taskbar-identity";

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
    expect(identity.appId).toBe("com.parendum.corvus.portable");
    expect(windowAppDetails(identity)).toEqual({
      appId: "com.parendum.corvus.portable",
      relaunchCommand: '"C:\\Users\\Ana\\Desktop\\My Corvus.exe"',
      relaunchDisplayName: "Corvus",
      appIconPath: "C:\\Users\\Ana\\Desktop\\My Corvus.exe",
      appIconIndex: 0,
    });
  });
});
