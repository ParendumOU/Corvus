/**
 * A whole profile as one password-protected file (".corvus-profile"), to move it to another
 * computer or keep a backup: bookmarks, history, reading list, annotations, workspaces, site
 * settings, containers, watches, workflows, schedules, site memory, New Tab layout, ad blocker
 * settings and saved logins. The payload is gzipped JSON sealed with AES-256-GCM under a key
 * derived from the password with scrypt; logins are only ever in clear inside that sealed payload,
 * and are sealed again with this computer's keychain when imported. Node only (no Electron), so it
 * unit-tests freely.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import type { Credential } from "../shared/credentials";

/** Profile files that travel: the person's data, nothing tied to this machine or rebuildable. */
export const BUNDLE_FILES = [
  "adblock.json",
  "agent-runs.json",
  "annotations.json",
  "autosignin.json",
  "bookmarks.json",
  "containers.json",
  "flows.json",
  "history.json",
  "newtab.json",
  "reading.json",
  "schedules.json",
  "site-memory.json",
  "site-profiles.json",
  "site-search.json",
  "site-settings.json",
  "watches.json",
  "workspaces.json",
] as const;

export const MIN_BUNDLE_PASSWORD = 8;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export interface BundleContents {
  profile: { name: string; avatar?: string };
  files: Record<string, string>;
  credentials: Credential[];
}

interface SealedFile {
  format: "corvus-profile";
  v: 1;
  kdf: { name: "scrypt"; N: number; r: number; p: number; salt: string };
  iv: string;
  tag: string;
  data: string;
}

export class BundleError extends Error {}

function keyFor(password: string, salt: Buffer, params: { N: number; r: number; p: number }): Buffer {
  return scryptSync(password.normalize("NFC"), salt, 32, { ...params, maxmem: SCRYPT.maxmem });
}

/** The profile's files and logins, as they are on disk now (missing files are left out). */
export function collectProfile(dataDir: string, profile: { name: string; avatar?: string }, credentials: Credential[]): BundleContents {
  const files: Record<string, string> = {};
  for (const name of BUNDLE_FILES) {
    const file = path.join(dataDir, name);
    try {
      if (fs.statSync(file).size > MAX_FILE_BYTES) continue;
      files[name] = fs.readFileSync(file, "utf8");
    } catch {
      // Not there yet: nothing to carry.
    }
  }
  return { profile: { name: profile.name, ...(profile.avatar ? { avatar: profile.avatar } : {}) }, files, credentials };
}

/** Seals the contents with `password`; returns the file's text. */
export function sealBundle(contents: BundleContents, password: string, now = Date.now(), appVersion = ""): string {
  if (password.length < MIN_BUNDLE_PASSWORD) throw new BundleError(`Use a password of at least ${MIN_BUNDLE_PASSWORD} characters.`);
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFor(password, salt, SCRYPT), iv);
  const plain = gzipSync(Buffer.from(JSON.stringify({ format: "corvus-profile-data", v: 1, createdAt: now, app: appVersion, ...contents }), "utf8"));
  const data = Buffer.concat([cipher.update(plain), cipher.final()]);
  const sealed: SealedFile = {
    format: "corvus-profile",
    v: 1,
    kdf: { name: "scrypt", N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, salt: salt.toString("base64") },
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
  return JSON.stringify(sealed);
}

/** Opens a bundle with `password`, keeping only well-formed parts. Throws BundleError otherwise. */
export function openBundle(text: string, password: string): BundleContents {
  let sealed: SealedFile;
  try {
    sealed = JSON.parse(text) as SealedFile;
  } catch {
    throw new BundleError("This is not a Corvus profile file.");
  }
  if (sealed?.format !== "corvus-profile" || sealed.v !== 1 || sealed.kdf?.name !== "scrypt") throw new BundleError("This is not a Corvus profile file.");
  const { N, r, p } = sealed.kdf;
  // Bounded work: a crafted file must not make the key derivation take forever.
  if (![N, r, p].every((n) => Number.isInteger(n) && n > 0) || N > 1 << 20 || r > 16 || p > 4) throw new BundleError("This profile file is damaged.");
  let plain: Buffer;
  try {
    const decipher = createDecipheriv("aes-256-gcm", keyFor(password, Buffer.from(sealed.kdf.salt, "base64"), { N, r, p }), Buffer.from(sealed.iv, "base64"));
    decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
    plain = gunzipSync(Buffer.concat([decipher.update(Buffer.from(sealed.data, "base64")), decipher.final()]));
  } catch {
    throw new BundleError("Wrong password, or the file is damaged.");
  }
  const payload = JSON.parse(plain.toString("utf8")) as Partial<BundleContents> & { format?: string };
  if (payload.format !== "corvus-profile-data") throw new BundleError("This profile file is damaged.");
  const files: Record<string, string> = {};
  for (const name of BUNDLE_FILES) {
    const body = payload.files?.[name];
    if (typeof body !== "string") continue;
    try {
      JSON.parse(body);
      files[name] = body;
    } catch {
      // A file that does not parse is left out rather than breaking the profile.
    }
  }
  const name = typeof payload.profile?.name === "string" && payload.profile.name.trim() ? payload.profile.name.trim().slice(0, 60) : "Imported profile";
  const avatar = typeof payload.profile?.avatar === "string" ? payload.profile.avatar.slice(0, 32) : undefined;
  return {
    profile: { name, ...(avatar ? { avatar } : {}) },
    files,
    credentials: Array.isArray(payload.credentials) ? payload.credentials : [],
  };
}

/** Writes an opened bundle's files into a new profile's (still empty) data folder. */
export function writeProfileFiles(dataDir: string, files: Record<string, string>): string[] {
  fs.mkdirSync(dataDir, { recursive: true });
  const written: string[] = [];
  for (const name of BUNDLE_FILES) {
    const body = files[name];
    if (body === undefined) continue;
    fs.writeFileSync(path.join(dataDir, name), body, "utf8");
    written.push(name);
  }
  return written;
}
