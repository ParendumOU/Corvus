import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentCredentialService } from "../src/main/agent-credentials";
import type { AppContext } from "../src/main/context";
import { CredentialVault } from "../src/main/credential-store";
import { LoginSources, vaultProvider } from "../src/main/login-sources";
import { SecretFillGuard } from "../src/main/secret-fill-guard";
import type { SecretCipher } from "../src/main/settings-store";
import { defaultSettings } from "../src/shared/settings";

vi.mock("electron", () => ({ ipcMain: { on: () => undefined, handle: () => undefined }, dialog: {}, BrowserWindow: { getFocusedWindow: () => null } }));

const keychain: SecretCipher = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(`enc:${plain}`),
  decryptString: (enc) => enc.toString().slice(4),
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** An opted-in login for https://example.com in tab t1; `script` answers each fill the page runs. */
function setup(script: (code: string) => unknown) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "corvus-agent-cred-"));
  dirs.push(dir);
  const vault = new CredentialVault(dir, keychain);
  vault.add({ origin: "https://example.com", username: "carol", password: "s3cret-pw", agentSignIn: true });
  const page = { url: "https://example.com/login", scripts: [] as string[] };
  const wc = {
    isDestroyed: () => false,
    getURL: () => page.url,
    executeJavaScriptInIsolatedWorld: async (_world: number, sources: { code: string }[]) => {
      const code = sources[0]!.code;
      page.scripts.push(code);
      return script(code);
    },
  };
  const tab = { id: "t1", url: page.url, view: { webContents: wc } };
  const window = { profile: { logins: new LoginSources(() => [vaultProvider(vault)]) }, markAgent: () => undefined };
  const secretFills = new SecretFillGuard();
  const defaults = defaultSettings();
  const settings = { ...defaults, passwords: { ...defaults.passwords, agentAccess: true } };
  const ctx = {
    settings: { get: () => settings },
    windows: { findTab: (id: string) => (id === "t1" ? { window, tab } : undefined) },
    agents: { currentClient: "client", beforeAction: async () => undefined },
    secretFills,
  } as unknown as AppContext;
  const opts = { approve: async () => true, client: "client", handoffHint: "Call ask_user." };
  return { service: new AgentCredentialService(ctx), secretFills, page, opts };
}

describe("agent fill_login", () => {
  it("runs the fill only in a page of the approved origin", async () => {
    const { service, page, opts } = setup(() => ({ ok: true, user: true, pass: true }));
    expect((await service.fillLogin("t1", null, opts)).status).toBe("filled");
    expect(page.scripts[0]!.startsWith('(location.origin === "https://example.com" ?')).toBe(true);
  });

  it("refuses when the page went to another site after the approval", async () => {
    const { service, page, opts } = setup(() => ({ ok: true }));
    const approve = async () => {
      // The gate re-checks after approval; the page moves on right after it (during beforeAction).
      setTimeout(() => void (page.url = "https://evil.example.org/"), 0);
      return true;
    };
    const ctxBefore = service as unknown as { ctx: { agents: { beforeAction: () => Promise<void> } } };
    ctxBefore.ctx.agents.beforeAction = () => new Promise((r) => setTimeout(r, 5));
    const outcome = await service.fillLogin("t1", "e1", { ...opts, approve });
    expect(outcome.status).toBe("error");
    expect(page.scripts.some((s) => s.includes("s3cret-pw"))).toBe(false);
  });

  it("keeps an earlier fill's lock when its own fill finds no field", async () => {
    const { service, secretFills, opts } = setup(() => ({ ok: false, reason: "missing" }));
    secretFills.mark("t1", ["earlier-secret"]);
    expect((await service.fillLogin("t1", "e1", opts)).status).toBe("error");
    expect(secretFills.isLocked("t1")).toBe(true);
  });

  it("lifts its own lock when its fill finds no field", async () => {
    const { service, secretFills, opts } = setup(() => ({ ok: false, reason: "missing" }));
    expect((await service.fillLogin("t1", "e1", opts)).status).toBe("error");
    expect(secretFills.isLocked("t1")).toBe(false);
  });
});
