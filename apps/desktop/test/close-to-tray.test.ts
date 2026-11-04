import { describe, expect, it } from "vitest";
import { keepWindowOnClose, trayAvailable } from "../src/shared/close-to-tray";
import { defaultSettings, mergeSettings } from "../src/shared/settings";

const last = { enabled: true, isPrivate: false, tabCount: 3, otherWindows: 0 };

describe("keep running in the notification area", () => {
  it("is off until the person turns it on", () => {
    expect(defaultSettings().startup.closeToTray).toBe(false);
    expect(mergeSettings(defaultSettings(), { startup: { closeToTray: true } }).startup.closeToTray).toBe(true);
    expect(mergeSettings(defaultSettings(), { startup: { closeToTray: "yes" } }).startup.closeToTray).toBe(false);
  });

  it("is for Windows and Linux (macOS keeps apps in the Dock)", () => {
    expect(trayAvailable("win32")).toBe(true);
    expect(trayAvailable("linux")).toBe(true);
    expect(trayAvailable("darwin")).toBe(false);
  });

  it("keeps the last window, with its tabs, instead of closing it", () => {
    expect(keepWindowOnClose(last)).toBe(true);
    expect(keepWindowOnClose({ ...last, enabled: false })).toBe(false);
  });

  it("closes a window while another stays open", () => {
    expect(keepWindowOnClose({ ...last, otherWindows: 1 })).toBe(false);
  });

  it("still closes a private window and one whose last tab was closed", () => {
    expect(keepWindowOnClose({ ...last, isPrivate: true })).toBe(false);
    expect(keepWindowOnClose({ ...last, tabCount: 0 })).toBe(false);
  });
});
