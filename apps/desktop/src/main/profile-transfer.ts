import fs from "node:fs";
import { app } from "electron";
import type { Profile } from "@corvus/shared";
import type { AppContext } from "./context";
import { collectProfile, openBundle, sealBundle, writeProfileFiles } from "./profile-bundle";
import type { ProfileRuntime } from "./profiles";

/** Writes `runtime`'s profile to `file`, sealed with `password` (its stores are flushed first). */
export function exportProfile(ctx: AppContext, runtime: ProfileRuntime, password: string, file: string): void {
  runtime.flush();
  ctx.monitor.flush();
  const contents = collectProfile(runtime.dataDir, runtime.profile, runtime.credentials.all());
  fs.writeFileSync(file, sealBundle(contents, password, Date.now(), app.getVersion()), "utf8");
}

/**
 * Opens a profile file with `password` into a new profile named after the original: its files go
 * into the new profile's folder before it loads, and its logins are sealed with this computer's
 * keychain (keeping their ids, so automatic sign-in choices still point at them).
 */
export function importProfile(ctx: AppContext, file: string, password: string): Profile {
  const contents = openBundle(fs.readFileSync(file, "utf8"), password);
  const taken = new Set(ctx.profiles.list().map((p) => p.name));
  let name = contents.profile.name;
  for (let n = 2; taken.has(name); n += 1) name = `${contents.profile.name} (${n})`;
  const created = ctx.profiles.create(name);
  writeProfileFiles(ctx.profiles.manager.dataDir(created.id), contents.files);
  const profile = contents.profile.avatar ? ctx.profiles.setMeta(created.id, { name, avatar: contents.profile.avatar }) : created;
  const runtime = ctx.profiles.get(created.id);
  runtime.credentials.applyRemote(contents.credentials.map((cred) => ({ id: cred.id, cred })));
  return profile;
}
