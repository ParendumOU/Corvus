import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { REPLICA_RE } from "../shared/site-memory";

const cache = new Map<string, string>();

/**
 * A random id for this profile on this install (`sync-replica.json` in the profile folder). Synced
 * counters (workflow usage, site memory) keep one slot per replica so devices can merge them
 * without counting anything twice. Independent of the sync device id, which changes when a device
 * leaves and rejoins a chain.
 */
export function replicaId(dir: string): string {
  const file = path.join(dir, "sync-replica.json");
  const cached = cache.get(file);
  if (cached) return cached;
  let id = "";
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { id?: unknown };
    if (typeof raw.id === "string" && REPLICA_RE.test(raw.id)) id = raw.id;
  } catch {
    // first use, or unreadable: mint a new one
  }
  if (!id) {
    id = crypto.randomBytes(6).toString("hex");
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ id }));
    } catch {
      // read-only profile: the id still holds for this session
    }
  }
  cache.set(file, id);
  return id;
}
