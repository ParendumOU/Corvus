import { describe, expect, it } from "vitest";
import {
  compareVersions,
  defaultRulesets,
  filtersRequests,
  hostPatterns,
  localizeManifestString,
  parseExtensionId,
  permissionWarnings,
  unsupportedPermissions,
} from "../src/shared/extension-manifest";

const UBO = "ddkjiahejlhfcafbddmgiahcphecmpfh";

describe("permission warnings", () => {
  it("collapses all-site access and lists API permissions", () => {
    const warnings = permissionWarnings({
      manifest_version: 3,
      permissions: ["tabs", "storage", "declarativeNetRequest", "clipboardRead"],
      host_permissions: ["<all_urls>", "https://example.com/*"],
    });
    expect(warnings).toEqual([
      "Read and change all your data on all websites",
      "Block content on any page",
      "Read your browsing history",
      "Read data you copy and paste",
    ]);
  });

  it("names specific sites and counts the rest", () => {
    expect(permissionWarnings({ manifest_version: 3, host_permissions: ["https://a.com/*", "https://*.b.com/*"] })).toEqual([
      "Read and change your data on a.com and b.com",
    ]);
    expect(
      permissionWarnings({ manifest_version: 3, host_permissions: ["https://a.com/*", "https://b.com/*", "https://c.com/*", "https://d.com/*"] }),
    ).toEqual(["Read and change your data on a.com, b.com and 2 other sites"]);
  });

  it("counts content script matches as host access and MV2 host permissions", () => {
    expect(hostPatterns({ manifest_version: 2, permissions: ["http://*/*", "storage"], content_scripts: [{ matches: ["https://x.org/*"] }] })).toEqual([
      "http://*/*",
      "https://x.org/*",
    ]);
  });

  it("history supersedes tabs", () => {
    expect(permissionWarnings({ manifest_version: 3, permissions: ["history", "tabs"] })).toEqual([
      "Read and change your browsing history on all your signed-in devices",
    ]);
  });

  it("returns nothing for harmless permissions", () => {
    expect(permissionWarnings({ manifest_version: 3, permissions: ["storage", "alarms", "contextMenus"] })).toEqual([]);
  });
});

describe("manifest helpers", () => {
  it("flags permissions Corvus does not implement", () => {
    expect(unsupportedPermissions({ permissions: ["storage", "history", "bookmarks", "tabGroups", "tabs", "sidePanel", "userScripts", "tts", "https://a.com/*"] })).toEqual([
      "userScripts",
      "tts",
    ]);
  });

  it("parses extension IDs from store URLs", () => {
    expect(parseExtensionId(UBO)).toBe(UBO);
    expect(parseExtensionId(`https://chromewebstore.google.com/detail/ublock-origin-lite/${UBO}?hl=en`)).toBe(UBO);
    expect(parseExtensionId(`https://chrome.google.com/webstore/detail/x/${UBO}`)).toBe(UBO);
    expect(parseExtensionId(`https://evil.test/detail/${UBO}`)).toBeNull();
    expect(parseExtensionId("not an id")).toBeNull();
  });

  it("compares versions numerically", () => {
    expect(compareVersions("1.10", "1.9")).toBe(1);
    expect(compareVersions("2.0", "2.0.0")).toBe(0);
    expect(compareVersions("4.3.1", "4.12")).toBe(-1);
  });

  it("localizes __MSG_ placeholders case-insensitively", () => {
    expect(localizeManifestString("__MSG_extName__", { extname: { message: "Dark Reader" } })).toBe("Dark Reader");
    expect(localizeManifestString("__MSG_missing__", {})).toBe("__MSG_missing__");
  });

  it("lists default-enabled static rulesets", () => {
    expect(
      defaultRulesets({
        declarative_net_request: { rule_resources: [{ id: "a", enabled: true, path: "a.json" }, { id: "b", enabled: false, path: "b.json" }] },
      }),
    ).toEqual(["a"]);
  });

  it("tells which extensions filter requests", () => {
    expect(filtersRequests({ manifest_version: 3, permissions: ["storage", "declarativeNetRequest"] })).toBe(true);
    expect(filtersRequests({ manifest_version: 3, permissions: ["declarativeNetRequestWithHostAccess"] })).toBe(true);
    expect(filtersRequests({ manifest_version: 2, permissions: ["webRequest", "webRequestBlocking", "<all_urls>"] })).toBe(true);
    expect(filtersRequests({ manifest_version: 3, permissions: ["tabs", "storage"], host_permissions: ["<all_urls>"] })).toBe(false);
  });
});
