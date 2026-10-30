import { describe, expect, it } from "vitest";
import {
  DANGEROUS_TYPE_GROUPS,
  cleanExtension,
  cleanSite,
  downloadSite,
  downloadTabStep,
  downloadedByAgent,
  emptyDownloadChoices,
  fileExtension,
  hasOwnPage,
  isTrusted,
  keepSuggestion,
  recordKeep,
  reviveDownloadChoices,
  trustType,
  untrustType,
} from "../src/shared/download-trust";
import { downloadStatus, isExecutableFilename, type DownloadRecord } from "../src/shared/downloads";

describe("file types Corvus warns about", () => {
  it("reads the type of a file name", () => {
    expect(fileExtension("pepk.JAR")).toBe("jar");
    expect(fileExtension("setup.exe. ")).toBe("exe");
    expect(fileExtension(".bashrc")).toBe("bashrc");
    expect(fileExtension("README")).toBe("");
  });

  it("lists every type once, and programs are exactly those types", () => {
    const all = DANGEROUS_TYPE_GROUPS.flatMap((g) => g.extensions);
    expect(new Set(all).size).toBe(all.length);
    expect(all).toContain("jar");
    expect(isExecutableFilename("pepk.jar")).toBe(true);
    expect(isExecutableFilename("report.zip")).toBe(false);
  });

  it("says why the person is asked", () => {
    const record: DownloadRecord = {
      id: "a",
      url: "https://www.gstatic.com/pepk.jar",
      filename: "pepk.jar",
      savePath: "",
      mime: "application/java-archive",
      totalBytes: 0,
      receivedBytes: 0,
      state: "blocked",
      startedAt: 1,
      agent: false,
      canResume: false,
    };
    expect(downloadStatus(record)).toBe("Blocked: an AI agent tried to download a program");
    expect(downloadStatus({ ...record, warning: { ext: "jar", site: "gstatic.com", ticked: false, scope: "site", canRemember: true } })).toBe(".jar files can harm your computer");
  });
});

describe("trusted file types", () => {
  it("takes the site from the link, without www", () => {
    expect(downloadSite("https://www.gstatic.com/play-apps-publisher-rapid/signing-tool/prod/pepk.jar")).toBe("gstatic.com");
    expect(downloadSite("http://Downloads.Example.com:8080/a.exe")).toBe("downloads.example.com");
    expect(downloadSite("blob:https://app.example.org/5a1c")).toBe("app.example.org");
    expect(downloadSite("data:application/octet-stream;base64,AAAA")).toBe("");
    expect(downloadSite("not a url")).toBe("");
  });

  it("cleans what the person types in Settings", () => {
    expect(cleanExtension(".JAR")).toBe("jar");
    expect(cleanExtension("*.exe")).toBe("exe");
    expect(cleanExtension(" msi ")).toBe("msi");
    expect(cleanExtension("txt")).toBeNull();
    expect(cleanExtension("")).toBeNull();
    expect(cleanSite("")).toBe("");
    expect(cleanSite("https://www.example.com/files/x.jar")).toBe("example.com");
    expect(cleanSite("*.example.org")).toBe("example.org");
    expect(cleanSite("Example.test")).toBe("example.test");
    expect(cleanSite("not a site!")).toBeNull();
  });

  it("trusts a type from a site and its subdomains, or from any site", () => {
    let choices = trustType(emptyDownloadChoices(), "jar", "gstatic.com", 1);
    expect(isTrusted(choices, "jar", "gstatic.com")).toBe(true);
    expect(isTrusted(choices, "jar", "dl.gstatic.com")).toBe(true);
    expect(isTrusted(choices, "jar", "notgstatic.com")).toBe(false);
    expect(isTrusted(choices, "jar", "example.com")).toBe(false);
    expect(isTrusted(choices, "exe", "gstatic.com")).toBe(false);
    expect(isTrusted(choices, "jar", "")).toBe(false);
    choices = trustType(choices, "exe", "", 2);
    expect(isTrusted(choices, "exe", "example.com")).toBe(true);
    expect(isTrusted(choices, "exe", "")).toBe(true);
  });

  it("adds a type once, newest first, and removes exactly the one asked", () => {
    let choices = trustType(emptyDownloadChoices(), "jar", "gstatic.com", 1);
    choices = trustType(choices, "jar", "", 2);
    choices = trustType(choices, "jar", "gstatic.com", 3);
    expect(choices.trusted).toEqual([
      { ext: "jar", site: "gstatic.com", addedAt: 3 },
      { ext: "jar", site: "", addedAt: 2 },
    ]);
    choices = untrustType(choices, "jar", "");
    expect(choices.trusted).toEqual([{ ext: "jar", site: "gstatic.com", addedAt: 3 }]);
    expect(isTrusted(choices, "jar", "example.com")).toBe(false);
  });
});

describe("learning from Keep", () => {
  it("ticks Always keep after two keeps of a type, never trusting by itself", () => {
    let choices = emptyDownloadChoices();
    expect(keepSuggestion(choices, "jar")).toEqual({ ticked: false, scope: "site" });
    choices = recordKeep(choices, "jar", "gstatic.com");
    expect(keepSuggestion(choices, "jar")).toEqual({ ticked: false, scope: "site" });
    choices = recordKeep(choices, "jar", "gstatic.com");
    expect(keepSuggestion(choices, "jar")).toEqual({ ticked: true, scope: "site" });
    expect(keepSuggestion(choices, "exe").ticked).toBe(false);
    expect(isTrusted(choices, "jar", "gstatic.com")).toBe(false);
    expect(choices.keeps).toEqual({ jar: { "gstatic.com": 2 } });
  });

  it("suggests any site once the type was kept from two sites", () => {
    let choices = recordKeep(emptyDownloadChoices(), "exe", "a.example.com");
    choices = recordKeep(choices, "exe", "b.example.org");
    expect(keepSuggestion(choices, "exe")).toEqual({ ticked: true, scope: "any" });
    // A file without a site does not count as a second site.
    const noSite = recordKeep(recordKeep(emptyDownloadChoices(), "sh", "a.example.com"), "sh", "");
    expect(keepSuggestion(noSite, "sh")).toEqual({ ticked: true, scope: "site" });
  });

  it("loads only what it can trust", () => {
    const choices = reviveDownloadChoices({
      trusted: [
        { ext: "jar", site: "gstatic.com", addedAt: 5 },
        { ext: "jar", site: "gstatic.com", addedAt: 6 },
        { ext: "txt", site: "", addedAt: 1 },
        { ext: "exe", site: "https://evil", addedAt: 1 },
        { ext: "msi", site: "" },
        null,
      ],
      keeps: { jar: { "gstatic.com": 2, "x.example": -1, y: "3" }, txt: { a: 1 }, exe: "nope" },
    });
    expect(choices.trusted).toEqual([
      { ext: "jar", site: "gstatic.com", addedAt: 5 },
      { ext: "msi", site: "", addedAt: 0 },
    ]);
    expect(choices.keeps).toEqual({ jar: { "gstatic.com": 2 } });
    expect(reviveDownloadChoices("garbage")).toEqual(emptyDownloadChoices());
  });
});

describe("downloads from tabs an AI agent drives", () => {
  const agentTab = { agentControlled: true, agentActedAt: 100 };

  it("are the person's in their own tabs", () => {
    expect(downloadedByAgent({ agentControlled: false }, true)).toBe(false);
  });

  it("are the agent's unless the person clicked after the agent's last action", () => {
    expect(downloadedByAgent(agentTab, true)).toBe(true);
    expect(downloadedByAgent({ ...agentTab, personInputAt: 90 }, true)).toBe(true);
    expect(downloadedByAgent({ ...agentTab, personInputAt: 150 }, true)).toBe(false);
  });

  it("look at the tab a new tab was opened from", () => {
    // A link with target=_blank: the new tab inherits the agent mark, the click was in its opener.
    const child = { agentControlled: true };
    expect(downloadedByAgent(child, false, { ...agentTab, personInputAt: 150 })).toBe(false);
    expect(downloadedByAgent(child, false, { ...agentTab, personInputAt: 50 })).toBe(true);
    expect(downloadedByAgent(child, false)).toBe(true);
    // The agent acted in the new tab after the person's click.
    expect(downloadedByAgent({ agentControlled: true, agentActedAt: 200 }, false, { ...agentTab, personInputAt: 150 })).toBe(true);
    // A tab with a page: the opener does not matter.
    expect(downloadedByAgent({ ...agentTab, personInputAt: 120 }, true, { agentControlled: true, agentActedAt: 500 })).toBe(false);
  });
});

describe("the tab a download came from", () => {
  it("knows when a tab has a page of its own", () => {
    expect(hasOwnPage(undefined)).toBe(false);
    expect(hasOwnPage("about:blank")).toBe(false);
    expect(hasOwnPage("https://example.com/")).toBe(true);
  });

  it("closes a tab opened only for the file and shows the tab it came from", () => {
    const opened = { url: "https://www.gstatic.com/pepk.jar", active: true, openerId: "t1", onlyTab: false };
    expect(downloadTabStep(opened)).toEqual({ kind: "close", activate: "t1" });
    expect(downloadTabStep({ ...opened, pageUrl: "about:blank" })).toEqual({ kind: "close", activate: "t1" });
    // A background tab (middle click) closes without changing the tab on screen.
    expect(downloadTabStep({ ...opened, active: false })).toEqual({ kind: "close" });
    // Its opener was closed meanwhile.
    expect(downloadTabStep({ url: opened.url, active: true, onlyTab: false })).toEqual({ kind: "close" });
  });

  it("keeps a window's only tab, on the New Tab page", () => {
    expect(downloadTabStep({ url: "https://example.com/a.zip", active: true, onlyTab: true })).toEqual({ kind: "new-tab" });
  });

  it("keeps a tab with a page on that page's address", () => {
    expect(downloadTabStep({ url: "https://example.com/a.zip", pageUrl: "https://example.com/", active: true, onlyTab: true })).toEqual({
      kind: "restore",
      url: "https://example.com/",
    });
    expect(downloadTabStep({ url: "https://example.com/", pageUrl: "https://example.com/", active: true, onlyTab: false })).toEqual({ kind: "keep" });
  });
});
