import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Profile, ProfileId } from "@corvus/shared";
import { JsonFile } from "./json-file";

interface ProfilesFile {
  version: 1;
  profiles: Profile[];
  lastUsed: ProfileId;
}

export const DEFAULT_PROFILE_ID = "default";

const AVATAR_COLORS = ["#8ab4f8", "#f28b82", "#81c995", "#fdd663", "#c58af9", "#78d9ec", "#fcad70", "#ff8bcb"];

export class ProfileError extends Error {}

/**
 * Owns the list of profiles and their on-disk data directories. Electron-free: the runtime
 * (session partition, stores, extensions) is built on top of it in profile-runtime.ts.
 */
export class ProfileManager {
  private readonly file: JsonFile<ProfilesFile>;

  constructor(private readonly rootDir: string) {
    fs.mkdirSync(rootDir, { recursive: true });
    this.file = JsonFile.load<ProfilesFile>(
      path.join(rootDir, "profiles.json"),
      () => ({
        version: 1,
        profiles: [{ id: DEFAULT_PROFILE_ID, name: "Personal", avatar: AVATAR_COLORS[0] }],
        lastUsed: DEFAULT_PROFILE_ID,
      }),
      (raw) => this.revive(raw),
      0,
    );
    if (this.file.get().profiles.length === 0) {
      this.file.set({ ...this.file.get(), profiles: [{ id: DEFAULT_PROFILE_ID, name: "Personal", avatar: AVATAR_COLORS[0] }] });
    }
    for (const p of this.list()) fs.mkdirSync(this.dataDir(p.id), { recursive: true });
    this.file.set(this.file.get());
  }

  private revive(raw: unknown): ProfilesFile {
    const data = raw as Partial<ProfilesFile>;
    const profiles = Array.isArray(data.profiles)
      ? data.profiles.filter((p): p is Profile => typeof p?.id === "string" && /^[a-z0-9-]+$/.test(p.id) && typeof p.name === "string")
      : [];
    const lastUsed = typeof data.lastUsed === "string" && profiles.some((p) => p.id === data.lastUsed) ? data.lastUsed : (profiles[0]?.id ?? DEFAULT_PROFILE_ID);
    return { version: 1, profiles, lastUsed };
  }

  list(): Profile[] {
    return this.file.get().profiles.map((p) => ({ ...p }));
  }

  get(id: ProfileId): Profile | undefined {
    const p = this.file.get().profiles.find((x) => x.id === id);
    return p ? { ...p } : undefined;
  }

  require(id: ProfileId): Profile {
    const p = this.get(id);
    if (!p) throw new ProfileError(`Unknown profile ${id}`);
    return p;
  }

  get lastUsed(): ProfileId {
    return this.file.get().lastUsed;
  }

  markUsed(id: ProfileId): void {
    this.require(id);
    if (this.file.get().lastUsed !== id) this.file.update((f) => ({ ...f, lastUsed: id }));
  }

  create(name: string): Profile {
    const clean = name.trim().slice(0, 60);
    if (!clean) throw new ProfileError("Profile name cannot be empty");
    const id = crypto.randomBytes(4).toString("hex");
    const profiles = this.file.get().profiles;
    const profile: Profile = { id, name: clean, avatar: AVATAR_COLORS[profiles.length % AVATAR_COLORS.length] };
    fs.mkdirSync(this.dataDir(id), { recursive: true });
    this.file.update((f) => ({ ...f, profiles: [...f.profiles, profile] }));
    return { ...profile };
  }

  rename(id: ProfileId, name: string): Profile {
    this.require(id);
    const clean = name.trim().slice(0, 60);
    if (!clean) throw new ProfileError("Profile name cannot be empty");
    this.file.update((f) => ({ ...f, profiles: f.profiles.map((p) => (p.id === id ? { ...p, name: clean } : p)) }));
    return this.require(id);
  }

  /** Name and avatar received from the profile's sync chain. */
  setMeta(id: ProfileId, meta: { name: string; avatar?: string }): Profile {
    const current = this.require(id);
    const name = meta.name.trim().slice(0, 60);
    if (!name) throw new ProfileError("Profile name cannot be empty");
    const avatar = meta.avatar ?? current.avatar;
    if (name === current.name && avatar === current.avatar) return current;
    this.file.update((f) => ({
      ...f,
      profiles: f.profiles.map((p) => (p.id === id ? { ...p, name, ...(avatar ? { avatar } : {}) } : p)),
    }));
    return this.require(id);
  }

  setSyncChain(id: ProfileId, chainId: string | undefined): void {
    this.require(id);
    this.file.update((f) => ({
      ...f,
      profiles: f.profiles.map((p) => {
        if (p.id !== id) return p;
        const { syncChainId: _old, ...rest } = p;
        return chainId ? { ...rest, syncChainId: chainId } : rest;
      }),
    }));
  }

  /** Delete a profile and its data directory. The last remaining profile cannot be deleted. */
  remove(id: ProfileId): void {
    this.require(id);
    const profiles = this.file.get().profiles;
    if (profiles.length <= 1) throw new ProfileError("Cannot delete the only profile");
    const remaining = profiles.filter((p) => p.id !== id);
    this.file.update((f) => ({
      ...f,
      profiles: remaining,
      lastUsed: f.lastUsed === id ? (remaining[0]?.id ?? DEFAULT_PROFILE_ID) : f.lastUsed,
    }));
    fs.rmSync(this.dataDir(id), { recursive: true, force: true });
  }

  dataDir(id: ProfileId): string {
    if (!/^[a-z0-9-]+$/.test(id)) throw new ProfileError(`Invalid profile id ${id}`);
    return path.join(this.rootDir, id);
  }

  static partition(id: ProfileId): string {
    return `persist:profile-${id}`;
  }
}
