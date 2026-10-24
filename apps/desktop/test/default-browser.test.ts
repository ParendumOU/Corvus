import { describe, expect, it } from "vitest";
import {
  DEFAULT_BROWSER_EXTENSIONS,
  LINUX_MIME_TYPES,
  WINDOWS_REGISTRY_KEYS,
  launchTargets,
  linuxDesktopEntry,
  parseRegistered,
  parseUserChoice,
  windowsRegFile,
} from "../src/shared/default-browser";

describe("Windows registration", () => {
  const reg = windowsRegFile(String.raw`C:\Users\Ana María\AppData\Local\Programs\Corvus\Corvus.exe`, { description: 'An "AI" browser' });
  const lines = reg.split("\r\n");

  it("is a .reg file for the current user only, with escaped paths", () => {
    expect(lines[0]).toBe("Windows Registry Editor Version 5.00");
    expect(lines.filter((l) => l.startsWith("[")).every((l) => l.startsWith("[HKEY_CURRENT_USER\\"))).toBe(true);
    expect(lines).toContain('"ApplicationDescription"="An \\"AI\\" browser"');
    expect(lines).toContain(String.raw`"ApplicationIcon"="\"C:\\Users\\Ana María\\AppData\\Local\\Programs\\Corvus\\Corvus.exe\",0"`);
  });

  it("opens links and files with -- before the argument, so they can never become switches", () => {
    const commands = lines.filter((l, i) => l.startsWith("@=") && lines[i - 1]?.endsWith("\\shell\\open\\command]") && !lines[i - 1]?.includes("StartMenuInternet"));
    expect(commands).toHaveLength(3);
    for (const c of commands) expect(c).toBe(String.raw`@="\"C:\\Users\\Ana María\\AppData\\Local\\Programs\\Corvus\\Corvus.exe\" -- \"%1\""`);
  });

  it("lists Corvus in Default apps for http, https and every web file type", () => {
    expect(lines).toContain(String.raw`"Corvus"="Software\\Clients\\StartMenuInternet\\Corvus\\Capabilities"`);
    expect(lines).toContain('"http"="CorvusURL"');
    expect(lines).toContain('"https"="CorvusURL"');
    for (const ext of DEFAULT_BROWSER_EXTENSIONS) expect(lines).toContain(`"${ext}"="${ext === ".pdf" ? "CorvusPDF" : "CorvusHTML"}"`);
    expect(lines).toContain('"URL Protocol"=""');
    // The uninstaller (build/installer.nsh) removes exactly these keys.
    for (const key of WINDOWS_REGISTRY_KEYS) expect(lines).toContain(`[${key}]`);
  });

  it("reads which browser Windows uses and whether Corvus is registered", () => {
    const out = "\r\nHKEY_CURRENT_USER\\Software\\...\\UserChoice\r\n    ProgId    REG_SZ    CorvusURL\r\n\r\n";
    expect(parseUserChoice(out)).toBe("CorvusURL");
    expect(parseUserChoice("    ProgId    REG_SZ    ChromeHTML\r\n")).toBe("ChromeHTML");
    expect(parseUserChoice("ERROR: The system was unable to find the specified registry key or value.")).toBeNull();
    expect(parseRegistered("    Corvus    REG_SZ    Software\\Clients\\StartMenuInternet\\Corvus\\Capabilities")).toBe(true);
    expect(parseRegistered("    Firefox-308046B0AF4A39CB    REG_SZ    Software\\Clients\\...")).toBe(false);
  });
});

describe("Linux .desktop entry", () => {
  it("quotes the program path and lists every MIME type", () => {
    const entry = linuxDesktopEntry("/home/ana/Apps/Corvus 0.14.0.AppImage", "corvus");
    expect(entry).toContain('Exec="/home/ana/Apps/Corvus 0.14.0.AppImage" %U');
    expect(entry).toContain(`MimeType=${LINUX_MIME_TYPES.join(";")};`);
    expect(entry).toContain("Categories=Network;WebBrowser;");
    expect(linuxDesktopEntry("/opt/corvus/corvus", "corvus")).toContain("Exec=/opt/corvus/corvus %U");
  });
});

describe("what a launch opens", () => {
  const files = new Set(["/home/ana/page.html", "/home/ana/doc.PDF", "/home/ana/notes.txt", "C:\\Docs\\report.pdf"]);
  const open = (argv: string[]) => launchTargets(argv, (p) => files.has(p), (p) => `file://${p.replace(/\\/g, "/")}`);

  it("opens web links and existing web files, skipping switches and other arguments", () => {
    expect(open(["corvus", "--enable-mcp", "https://example.com/a", "/home/ana/page.html", "/home/ana/notes.txt", "/home/ana/missing.html", "."])).toEqual([
      "https://example.com/a",
      "file:///home/ana/page.html",
    ]);
  });

  it("takes what follows -- as links and files, never as switches", () => {
    expect(open(["Corvus.exe", "--", "C:\\Docs\\report.pdf"])).toEqual(["file://C:/Docs/report.pdf"]);
    expect(open(["Corvus.exe", "--", "--gpu-launcher=calc.exe"])).toEqual([]);
    expect(open(["Corvus.exe", "--", "http://example.com/?q=1"])).toEqual(["http://example.com/?q=1"]);
  });

  it("accepts file URLs of web files, matches extensions in any case, and lists each once", () => {
    expect(open(["corvus", "file:///home/ana/My%20Page.htm", "file:///etc/passwd", "file:///bad%E0.html", "/home/ana/doc.PDF", "/home/ana/doc.PDF"])).toEqual([
      "file:///home/ana/My%20Page.htm",
      "file:///bad%E0.html",
      "file:///home/ana/doc.PDF",
    ]);
  });
});
