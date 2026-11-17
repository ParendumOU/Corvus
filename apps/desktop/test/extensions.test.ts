import { describe, expect, it, vi } from "vitest";

const uninstallExtension = vi.fn(async () => undefined);
vi.mock("electron", () => ({ app: {}, dialog: {}, nativeImage: {}, screen: {}, webContents: {} }));
vi.mock("electron-chrome-extensions", () => ({ ElectronChromeExtensions: class {} }));
vi.mock("electron-chrome-web-store", () => ({ downloadExtension: vi.fn(), installChromeWebStore: vi.fn(), uninstallExtension, updateExtensions: vi.fn() }));

const { ExtensionHost, checkExtensionUrl } = await import("../src/main/extensions");

describe("checkExtensionUrl", () => {
  it("lets extensions open the New Tab page", () => {
    expect(checkExtensionUrl("corvus://newtab/", undefined)).toBe("corvus://newtab/");
    expect(checkExtensionUrl("https://example.com/a", undefined)).toBe("https://example.com/a");
  });

  it("refuses other corvus:// documents, including New Tab widget documents", () => {
    expect(() => checkExtensionUrl("corvus://settings/", undefined)).toThrow(/corvus:\/\//);
    expect(() => checkExtensionUrl("corvus://newtab/widget/custom-1", undefined)).toThrow(/corvus:\/\//);
    expect(() => checkExtensionUrl("CORVUS://newtab/media/a.png", undefined)).toThrow(/corvus:\/\//);
  });
});

describe("ExtensionHost.remove", () => {
  it("never hands a path-like id to the web store uninstaller", async () => {
    const host = { find: () => undefined } as unknown as InstanceType<typeof ExtensionHost>;
    for (const id of ["..", "../..", "", "x/../.."]) {
      await expect(ExtensionHost.prototype.remove.call(host, id)).rejects.toThrow("Extension is not installed");
    }
    expect(uninstallExtension).not.toHaveBeenCalled();
  });
});
