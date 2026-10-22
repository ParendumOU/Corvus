import crypto from "node:crypto";
import path from "node:path";
import {
  MAX_SITE_PROFILES,
  matchSiteProfile,
  normalizeInput,
  reviveProfile,
  type SiteProfile,
  type SiteProfileInput,
} from "../shared/site-profiles";
import { JsonFile } from "./json-file";

type Listener = () => void;

function revive(raw: unknown): SiteProfile[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(reviveProfile).filter((p): p is SiteProfile => p !== null).slice(0, MAX_SITE_PROFILES);
}

/** Per-site AI profiles for one profile (user). Durable, bounded, local-only. */
export class SiteProfileStore {
  private readonly file: JsonFile<SiteProfile[]>;
  private readonly listeners = new Set<Listener>();

  constructor(dir: string) {
    this.file = JsonFile.load(path.join(dir, "site-profiles.json"), () => [], revive, 0);
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private commit(list: SiteProfile[]): void {
    this.file.set(list);
    for (const l of this.listeners) l();
  }

  list(): SiteProfile[] {
    return this.file.get();
  }

  get(id: string): SiteProfile | undefined {
    return this.file.get().find((p) => p.id === id);
  }

  /** The profile that applies to a URL, or null. Narrowing decisions all start from this. */
  match(url: string): SiteProfile | null {
    return matchSiteProfile(this.file.get(), url);
  }

  /** Create a profile. Returns null when the per-profile cap is hit or the pattern is invalid. */
  add(input: SiteProfileInput): SiteProfile | null {
    const list = this.file.get();
    if (list.length >= MAX_SITE_PROFILES) return null;
    const n = normalizeInput(input);
    if (!n.pattern) return null;
    const profile: SiteProfile = { id: crypto.randomUUID(), ...n, createdAt: Date.now() };
    this.commit([...list, profile]);
    return profile;
  }

  update(id: string, input: SiteProfileInput): void {
    const n = normalizeInput(input);
    if (!n.pattern) return;
    const list = this.file.get();
    if (!list.some((p) => p.id === id)) return;
    this.commit(list.map((p) => (p.id === id ? { ...p, ...n } : p)));
  }

  setEnabled(id: string, enabled: boolean): void {
    const list = this.file.get();
    if (!list.some((p) => p.id === id)) return;
    this.commit(list.map((p) => (p.id === id ? { ...p, enabled } : p)));
  }

  remove(id: string): void {
    this.commit(this.file.get().filter((p) => p.id !== id));
  }

  flush(): void {
    this.file.flush();
  }
}
