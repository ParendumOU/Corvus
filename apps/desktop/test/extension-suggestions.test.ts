import { describe, expect, it } from "vitest";
import { extensionSuggestions, parseDeviceExtensions, webstoreExtensions } from "../src/shared/extension-suggestions";
import type { ExtensionInfo } from "../src/shared/ipc";

const UBLOCK = "cjpalhdlnbpafiamejdnhcphjbkeiagm";
const DARK = "eimadpbcbfnmbkopoojfekhnkhdbieeh";
const PASSWORDS = "nngceckbapebfimnlniiiahkandclblb";

function ext(id: string, name: string, source: ExtensionInfo["source"] = "webstore"): ExtensionInfo {
  return { id, name, version: "1.0", description: "", source, path: `/ext/${id}`, iconUrl: "", enabled: true, pinned: false, hasAction: false, manifestVersion: 3, permissions: [], hostPermissions: [], warnings: [], unsupported: [], optionsUrl: null, homepageUrl: null, storeUrl: null, errors: [] };
}

describe("extension sync", () => {
  it("publishes only Chrome Web Store extensions, sorted and without local paths", () => {
    const published = webstoreExtensions([ext(UBLOCK, "uBlock Origin"), ext("a".repeat(32), "Dev build", "unpacked"), ext("not-an-id", "Weird"), ext(DARK, "Dark Reader")]);
    expect(published).toEqual([
      { id: UBLOCK, name: "uBlock Origin" },
      { id: DARK, name: "Dark Reader" },
    ].sort((a, b) => a.id.localeCompare(b.id)));
    expect(JSON.stringify(published)).not.toContain("/ext/");
  });

  it("validates remote records", () => {
    expect(parseDeviceExtensions({ device: "Phone" })).toBeNull();
    expect(parseDeviceExtensions({ device: "Phone", extensions: [{ id: "../../etc", name: "x" }, { id: DARK }] })).toEqual({
      device: "Phone",
      extensions: [{ id: DARK, name: DARK }],
    });
  });

  it("suggests extensions from other devices that are neither installed nor dismissed", () => {
    const remote = {
      own: { device: "This laptop", extensions: [{ id: PASSWORDS, name: "Passwords" }] },
      desk: { device: "Desktop", extensions: [{ id: UBLOCK, name: "uBlock Origin" }, { id: DARK, name: "Dark Reader" }, { id: PASSWORDS, name: "Passwords" }] },
      phone: { device: "Work PC", extensions: [{ id: UBLOCK, name: "uBlock Origin" }] },
      broken: { nope: true },
    };
    expect(extensionSuggestions(remote, "own", [DARK], [])).toEqual([
      { id: PASSWORDS, name: "Passwords", devices: ["Desktop"] },
      { id: UBLOCK, name: "uBlock Origin", devices: ["Desktop", "Work PC"] },
    ]);
    expect(extensionSuggestions(remote, "own", [DARK], [UBLOCK, PASSWORDS])).toEqual([]);
  });
});
