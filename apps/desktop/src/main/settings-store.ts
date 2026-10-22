import crypto from "node:crypto";
import path from "node:path";
import { JsonFile } from "./json-file";
import {
  defaultSettings,
  mergeSettings,
  type SecretKey,
  type Settings,
  type SettingsPatch,
  type SettingsView,
} from "../shared/settings";

/** Subset of Electron's safeStorage, injected so the store stays testable. */
export interface SecretCipher {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

interface StoredSecret {
  enc: boolean;
  data: string;
}

type SecretName = SecretKey | "mcpToken";

const ENV_SECRETS: Record<SecretKey, string> = {
  anthropicApiKey: "ANTHROPIC_API_KEY",
  braveApiKey: "BRAVE_SEARCH_API_KEY",
};

export type SettingsListener = (next: Settings, prev: Settings) => void;

/**
 * Global (cross-profile) settings plus secrets. Secrets are encrypted with the OS keychain via
 * safeStorage; when that is unavailable, API keys are kept in memory for the session only.
 * The MCP bearer token is local-only and is persisted even without a keychain.
 */
export class SettingsStore {
  private readonly file: JsonFile<Settings>;
  private readonly secretsFile: JsonFile<Partial<Record<SecretName, StoredSecret>>>;
  private readonly memorySecrets = new Map<SecretName, string>();
  private readonly listeners = new Set<SettingsListener>();
  private readonly defaults: Settings;

  constructor(
    dir: string,
    private readonly cipher: SecretCipher,
    private readonly env: Record<string, string | undefined>,
  ) {
    this.defaults = defaultSettings(env);
    this.file = JsonFile.load(path.join(dir, "settings.json"), () => this.defaults, (raw) => mergeSettings(this.defaults, raw), 0);
    this.secretsFile = JsonFile.load(path.join(dir, "secrets.json"), () => ({}), (raw) => (typeof raw === "object" && raw ? raw : {}), 0);
  }

  get(): Settings {
    return this.file.get();
  }

  update(patch: SettingsPatch): Settings {
    const prev = this.file.get();
    const next = mergeSettings(prev, patch);
    this.file.set(next);
    for (const listener of this.listeners) listener(next, prev);
    return next;
  }

  onChange(listener: SettingsListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get secretsPersisted(): boolean {
    return this.cipher.isEncryptionAvailable();
  }

  getSecret(name: SecretName): string | undefined {
    const memory = this.memorySecrets.get(name);
    if (memory !== undefined) return memory;
    const stored = this.secretsFile.get()[name];
    if (stored) {
      try {
        return stored.enc ? this.cipher.decryptString(Buffer.from(stored.data, "base64")) : stored.data;
      } catch (err) {
        console.warn(`[corvus] could not decrypt secret ${name}:`, err);
      }
    }
    if (name !== "mcpToken") {
      const fromEnv = this.env[ENV_SECRETS[name]];
      if (fromEnv) return fromEnv;
    }
    return undefined;
  }

  setSecret(name: SecretName, value: string): void {
    const trimmed = value.trim();
    const secrets = { ...this.secretsFile.get() };
    this.memorySecrets.delete(name);
    if (!trimmed) {
      delete secrets[name];
    } else if (this.cipher.isEncryptionAvailable()) {
      secrets[name] = { enc: true, data: this.cipher.encryptString(trimmed).toString("base64") };
    } else if (name === "mcpToken") {
      secrets[name] = { enc: false, data: trimmed };
    } else {
      delete secrets[name];
      this.memorySecrets.set(name, trimmed);
    }
    this.secretsFile.set(secrets);
    const current = this.file.get();
    for (const listener of this.listeners) listener(current, current);
  }

  mcpToken(): string {
    const existing = this.getSecret("mcpToken");
    if (existing) return existing;
    return this.regenerateMcpToken();
  }

  regenerateMcpToken(): string {
    const token = crypto.randomBytes(24).toString("base64url");
    this.setSecret("mcpToken", token);
    return token;
  }

  view(): SettingsView {
    return {
      settings: this.get(),
      secrets: {
        anthropicApiKey: Boolean(this.getSecret("anthropicApiKey")),
        braveApiKey: Boolean(this.getSecret("braveApiKey")),
      },
      secretsPersisted: this.secretsPersisted,
    };
  }

  flush(): void {
    this.file.flush();
    this.secretsFile.flush();
  }
}
