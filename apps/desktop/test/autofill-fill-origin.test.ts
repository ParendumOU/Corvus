import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AutofillService } from "../src/main/autofill-service";
import type { AppContext } from "../src/main/context";
import { CredentialVault } from "../src/main/credential-store";
import { LoginSources, vaultProvider } from "../src/main/login-sources";
import { SiteSettingsStore } from "../src/main/site-settings";
import type { SecretCipher } from "../src/main/settings-store";
import type { BrowserWindowCtl, TabRuntime } from "../src/main/window";

vi.mock("electron", () => ({ ipcMain: { on: () => undefined, handle: () => undefined }, clipboard: { writeText: () => undefined }, webFrameMain: { fromId: () => undefined } }));

const keychain: SecretCipher = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(`enc:${plain}`),
  decryptString: (enc) => enc.toString().slice(4),
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A window whose active tab shows https://example.com/login; `navigateTo` makes the next scripts run on another page. */
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "corvus-autofill-origin-"));
  dirs.push(dir);
  const vault = new CredentialVault(dir, keychain);
  const login = vault.add({ origin: "https://example.com", username: "carol", password: "s3cret-pw" });
  const scripts: string[] = [];
  let url = "https://example.com/login";
  let afterDetect: string | null = null;
  const page = {
    isDestroyed: () => false,
    getURL: () => url,
    executeJavaScriptInIsolatedWorld: async (_world: number, sources: { code: string }[]) => {
      const code = sources[0]!.code;
      scripts.push(code);
      if (scripts.length === 1) {
        if (afterDetect) url = afterDetect;
        return { hasPassword: true, hasUsername: true, username: "", hasIdentifier: false, hasOtp: false, origin: "https://example.com" };
      }
      return true;
    },
  };
  const tab = { id: "t1", agentControlled: false, url, view: { webContents: page } } as unknown as TabRuntime;
  const win = {
    profile: { credentials: vault, logins: new LoginSources(() => [vaultProvider(vault)]), siteSettings: new SiteSettingsStore(dir) },
    isPrivate: false,
    activeTab: () => tab,
    pushState: () => undefined,
  } as unknown as BrowserWindowCtl;
  const ctx = { secretFills: { mark: () => undefined } } as unknown as AppContext;
  return { autofill: new AutofillService(ctx), win, login, scripts, navigateAfterDetect: (to: string) => void (afterDetect = to) };
}

describe("filling a saved login", () => {
  it("writes the password only into a page still of the origin it matched", async () => {
    const { autofill, win, login, scripts } = setup();
    await autofill.fill(win, login.id);
    const fill = scripts.find((s) => s.includes("s3cret-pw"));
    expect(fill).toBeDefined();
    expect(fill!.startsWith('(location.origin === "https://example.com" ?')).toBe(true);
  });

  it("never sends the password to a page that navigated to another site meanwhile", async () => {
    const { autofill, win, login, scripts, navigateAfterDetect } = setup();
    navigateAfterDetect("https://evil.example.org/login");
    await autofill.fill(win, login.id);
    expect(scripts).toHaveLength(1);
    expect(scripts.some((s) => s.includes("s3cret-pw"))).toBe(false);
  });
});
