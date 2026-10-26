import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { settingsAdapter } from "../src/main/sync-adapters";
import { SettingsStore, type SecretCipher } from "../src/main/settings-store";
import { defaultSettings, type SecretKey } from "../src/shared/settings";
import {
  LOCAL_ONLY_SETTINGS,
  OPT_IN_SYNCED_SETTINGS,
  SYNCED_SETTINGS,
  readSetting,
  settingsPatch,
  syncedSettingKeys,
} from "../src/shared/sync-settings";

const cipher: SecretCipher = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(`enc:${plain}`),
  decryptString: (enc) => enc.toString().slice(4),
};

function leafPaths(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [prefix];
  return Object.entries(value).flatMap(([k, v]) => leafPaths(v, prefix ? `${prefix}.${k}` : k));
}

const SECRET_NAMES: Array<SecretKey | "mcpToken"> = ["anthropicApiKey", "braveApiKey", "transcriptionApiKey", "mcpToken"];
/** Matched against the setting name: anthropicApiKey, mcpToken, ... (but not maxOutputTokens). */
const SECRET_LIKE = /key$|token$|apikey|secret|password|credential|cookie|phrase/i;

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "corvus-sync-settings-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("synced settings allowlist", () => {
  const synced: string[] = [...SYNCED_SETTINGS, ...OPT_IN_SYNCED_SETTINGS];

  it("never includes a secret or secret-looking key", () => {
    for (const key of synced) {
      expect(key.split(".").pop(), `${key} looks like a secret`).not.toMatch(SECRET_LIKE);
      for (const secret of SECRET_NAMES) expect(key.split(".")).not.toContain(secret);
    }
  });

  it("keeps MCP and machine paths local", () => {
    expect(synced.filter((k) => k.startsWith("mcp."))).toEqual([]);
    expect(synced).not.toContain("ai.claudeCliPath");
    expect(SYNCED_SETTINGS as readonly string[]).not.toContain("ai.searxngUrl");
  });

  it("classifies every setting exactly once (new settings must be added to one list)", () => {
    const all = leafPaths(defaultSettings()).sort();
    const classified = [...synced, ...Object.keys(LOCAL_ONLY_SETTINGS)];
    expect(new Set(classified).size).toBe(classified.length);
    expect(classified.sort()).toEqual(all);
  });

  it("only syncs primitive values", () => {
    const defaults = defaultSettings();
    for (const key of synced) expect(["string", "number", "boolean"]).toContain(typeof readSetting(defaults, key));
  });

  it("builds patches and honours the URL opt-in", () => {
    expect(syncedSettingKeys(false)).not.toContain("ai.searxngUrl");
    expect(syncedSettingKeys(true)).toContain("ai.searxngUrl");
    expect(settingsPatch([["appearance.theme", "dark"], ["ai.model", "m"], ["ai.maxOutputTokens", 300]])).toEqual({
      appearance: { theme: "dark" },
      ai: { model: "m", maxOutputTokens: 300 },
    });
  });

  it("publishes no secret values even when every secret is set", () => {
    const store = new SettingsStore(dir, cipher, {});
    store.setSecret("anthropicApiKey", "sk-ant-SECRET-VALUE");
    store.setSecret("braveApiKey", "BSA-SECRET-VALUE");
    const token = store.mcpToken();
    store.update({ mcp: { enabled: true, port: 41234, approvedClients: ["claude-code"] }, ai: { claudeCliPath: "/opt/claude" } });

    for (const optIn of [false, true]) {
      const published = JSON.stringify(settingsAdapter(store, () => optIn).list());
      for (const leaked of ["SECRET-VALUE", token, "41234", "claude-code", "/opt/claude"]) expect(published).not.toContain(leaked);
    }
  });

  it("applies only allowlisted keys from remote devices and validates values", async () => {
    const store = new SettingsStore(dir, cipher, {});
    const adapter = settingsAdapter(store, () => false);
    await adapter.apply([
      { collection: "settings", id: "appearance.theme", payload: { v: "dark" }, deleted: false },
      { collection: "settings", id: "ai.provider", payload: { v: "not-a-provider" }, deleted: false },
      { collection: "settings", id: "mcp.enabled", payload: { v: true }, deleted: false },
      { collection: "settings", id: "ai.searxngUrl", payload: { v: "http://evil.example" }, deleted: false },
      { collection: "settings", id: "ai.model", payload: null, deleted: true },
    ]);
    const s = store.get();
    expect(s.appearance.theme).toBe("dark");
    expect(s.ai.provider).toBe(defaultSettings().ai.provider);
    expect(s.mcp.enabled).toBe(false);
    expect(s.ai.searxngUrl).toBe(defaultSettings().ai.searxngUrl);
    expect(s.ai.model).toBe(defaultSettings().ai.model);
  });
});
