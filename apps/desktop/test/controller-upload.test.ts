import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentError, Controller, isRemoteOrDevicePath } from "../src/main/controller";
import type { AppContext } from "../src/main/context";

function controllerWithTab(): Controller {
  const wc = { isDestroyed: () => false, getURL: () => "https://example.com/form" };
  const tab = { id: "t1", url: "https://example.com/form", view: { webContents: wc } };
  const window = { isPrivate: false, profile: { locked: false } };
  const ctx = {
    windows: { findTab: () => ({ window, tab }) },
    pageDialogs: { pending: () => null },
    httpAuth: { personStep: () => null },
    externalApps: { personStep: () => null },
  } as unknown as AppContext;
  return new Controller(ctx);
}

describe("isRemoteOrDevicePath", () => {
  it("flags UNC and device paths in either slash style", () => {
    for (const p of ["\\\\192.0.2.1\\share\\x.txt", "//host.test/share/x.txt", "\\\\?\\C:\\x.txt", "\\\\.\\pipe\\x", "\\\\?\\UNC\\host\\share\\x", "\\/host/share"]) {
      expect(isRemoteOrDevicePath(p)).toBe(true);
    }
  });

  it("lets local paths through", () => {
    for (const p of ["C:\\Users\\me\\x.txt", "/home/me/x.txt", "D:/files/x.pdf"]) expect(isRemoteOrDevicePath(p)).toBe(false);
  });
});

describe("Controller.uploadFiles", () => {
  afterEach(() => vi.restoreAllMocks());

  it("refuses a network path before touching the file system", async () => {
    const stat = vi.spyOn(fs.promises, "stat");
    const controller = controllerWithTab();
    await expect(controller.uploadFiles("t1", undefined, ["C:\\local.txt", "\\\\192.0.2.1\\share\\x.txt"])).rejects.toThrow(AgentError);
    await expect(controller.uploadFiles("t1", undefined, ["\\\\192.0.2.1\\share\\x.txt"])).rejects.toThrow(/Network and device paths/);
    expect(stat).not.toHaveBeenCalled();
  });
});
