import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SettingsStore, type SecretCipher } from "../src/main/settings-store";

const keychain: SecretCipher = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(`enc:${plain}`),
  decryptString: (enc) => enc.toString().slice(4),
};
const keychainDown: SecretCipher = {
  isEncryptionAvailable: () => false,
  encryptString: () => {
    throw new Error("unavailable");
  },
  decryptString: () => {
    throw new Error("unavailable");
  },
};

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("the MCP token", () => {
  it("survives a start without the keychain", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "corvus-mcp-token-"));
    dirs.push(dir);
    const token = new SettingsStore(dir, keychain, {}).mcpToken();

    const down = new SettingsStore(dir, keychainDown, {});
    const sessionToken = down.mcpToken();
    expect(sessionToken).not.toBe(token);
    expect(down.mcpToken()).toBe(sessionToken);

    expect(new SettingsStore(dir, keychain, {}).mcpToken()).toBe(token);
  });
});
