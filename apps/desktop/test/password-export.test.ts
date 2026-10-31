import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BrowserImport } from "../src/main/browser-import";
import { CredentialVault } from "../src/main/credential-store";
import { PasswordExports, browserCommand, importPasswordCsv, waitForExport } from "../src/main/password-export";
import type { ProfileRuntime } from "../src/main/profiles";
import type { SecretCipher } from "../src/main/settings-store";
import { passwordExportPage } from "../src/shared/browser-import";

const keychain: SecretCipher = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(`enc:${plain}`),
  decryptString: (enc) => enc.toString().slice(4),
};

const dirs: string[] = [];
const tempDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "corvus-pwexport-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const CHROME_CSV = ["name,url,username,password,note", "example.com,https://example.com/,ana@example.com,made-up-export-pw,"].join("\n");
const runtimeWith = (vault: CredentialVault) => ({ credentials: vault, backup: { noteBigChange: () => {} }, profile: { id: "p1" } }) as unknown as ProfileRuntime;

describe("opening a browser at its password export", () => {
  it("names each browser's own page", () => {
    expect(passwordExportPage("chrome")).toBe("chrome://password-manager/settings");
    expect(passwordExportPage("firefox-snap")).toBe("about:logins");
    expect(passwordExportPage("edge")).toBe("edge://settings/passwords");
  });

  it("finds the installed program on each system, or nothing", () => {
    const env = { ProgramFiles: "C:\\Program Files", "ProgramFiles(x86)": "C:\\Program Files (x86)", LOCALAPPDATA: "C:\\Users\\ana\\AppData\\Local", PATH: "/usr/bin:/bin" };
    const only = (file: string) => (p: string) => p === file;
    expect(browserCommand("edge", "win32", env, only("C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"))).toEqual({
      file: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      args: ["edge://settings/passwords"],
    });
    expect(browserCommand("chrome", "win32", env, () => false)).toBeNull();
    expect(browserCommand("brave", "darwin", env, () => false)).toEqual({ file: "/usr/bin/open", args: ["-a", "Brave Browser", "brave://password-manager/settings"] });
    expect(browserCommand("firefox", "linux", env, only("/usr/bin/firefox"))).toEqual({ file: "/usr/bin/firefox", args: ["about:logins"] });
  });
});

describe("waiting for the export in Downloads", () => {
  it("returns the new password export only, ignoring other and older files", async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "old.csv"), CHROME_CSV);
    const old = new Date(Date.now() - 3_600_000);
    fs.utimesSync(path.join(dir, "old.csv"), old, old);
    const since = Date.now();
    fs.writeFileSync(path.join(dir, "bank.csv"), "date,amount,description\n1,2,3\n");
    fs.writeFileSync(path.join(dir, "notes.txt"), "url,password");
    setTimeout(() => fs.writeFileSync(path.join(dir, "Chrome Passwords.csv"), CHROME_CSV), 30);
    const found = await waitForExport(dir, since, { signal: new AbortController().signal, pollMs: 20, timeoutMs: 3000 });
    expect(found && path.basename(found)).toBe("Chrome Passwords.csv");
  });

  it("gives up after its time, and when cancelled", async () => {
    const dir = tempDir();
    expect(await waitForExport(dir, Date.now(), { signal: new AbortController().signal, pollMs: 10, timeoutMs: 50 })).toBeNull();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    expect(await waitForExport(dir, Date.now(), { signal: controller.signal, pollMs: 10, timeoutMs: 5000 })).toBeNull();
  });
});

describe("the guided export from the Import click", () => {
  it("opens the browser (stubbed), imports the CSV it saves through the merge, and deletes it", async () => {
    const downloads = tempDir();
    const vault = new CredentialVault(tempDir(), keychain);
    const exports = new PasswordExports(() => downloads);
    const opened: string[] = [];
    exports.setTest((id) => {
      opened.push(id);
      setTimeout(() => fs.writeFileSync(path.join(downloads, "Chrome Passwords.csv"), CHROME_CSV), 30);
      return true;
    }, downloads);
    const outcome = await exports.run(new BrowserImport(), runtimeWith(vault), { id: "chrome", name: "Google Chrome" }, true, 5000);
    expect(opened).toEqual(["chrome"]);
    expect(outcome.status).toBe("imported");
    if (outcome.status !== "imported") return;
    expect(outcome.import.summary.added).toBe(1);
    expect(outcome.import.deleted).toBe(true);
    expect(fs.existsSync(path.join(downloads, "Chrome Passwords.csv"))).toBe(false);
    expect(JSON.stringify(outcome)).not.toContain("made-up-export-pw");
  });

  it("a hand-picked CSV keeps the file when the person unticked the deletion; undated changes wait for review", async () => {
    const dir = tempDir();
    const file = path.join(dir, "export.csv");
    fs.writeFileSync(file, CHROME_CSV);
    const vault = new CredentialVault(tempDir(), keychain);
    vault.add({ origin: "https://example.com", username: "ana@example.com", password: "changed-since" });
    const imports = new BrowserImport();
    const result = await importPasswordCsv(imports, runtimeWith(vault), file, false);
    expect(result.deleted).toBe(false);
    expect(fs.existsSync(file)).toBe(true);
    expect(result.summary.review).toEqual([{ site: "example.com", username: "ana@example.com" }]);
    expect(vault.findByLogin("https://example.com", "ana@example.com")!.password).toBe("changed-since");
    expect(imports.applyReview(runtimeWith(vault), result.summary.reviewToken!, "all")).toBe(1);
    expect(vault.findByLogin("https://example.com", "ana@example.com")!.password).toBe("made-up-export-pw");
  });
});
