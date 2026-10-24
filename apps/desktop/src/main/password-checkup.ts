import { createHash, createHmac, randomBytes } from "node:crypto";
import { net } from "electron";
import { breachCount, isWeakPassword, reuseCounts, type PasswordCheckupView, type PasswordHealth } from "../shared/password-health";
import type { ProfileRuntime } from "./profiles";

/** Have I Been Pwned's range API: the first 5 hex characters of a SHA-1 in, every matching suffix out. */
export const PWNED_RANGE_URL = "https://api.pwnedpasswords.com/range/";

const PARALLEL = 4;
const TIMEOUT_MS = 15_000;

interface Login {
  id: string;
  password: string;
}

interface ProfileCheckup {
  checkedAt: number | null;
  running: Promise<void> | null;
  error: string | null;
}

/**
 * Checks a profile's saved passwords (vault and unlocked KeePass databases) against known data
 * breaches, on request only. Each password's SHA-1 is split: its first 5 characters go to the
 * breach service, which answers with every suffix it knows under that prefix (padded with fake
 * ones), and the match happens here. Results stay in memory for the session, keyed by a keyed
 * hash that is useless outside this run; reuse and weakness are worked out locally each time.
 */
export class PasswordCheckupService {
  /** Replaced by the smoke test with a local stand-in. */
  endpoint = PWNED_RANGE_URL;
  private readonly key = randomBytes(32);
  /** Breach counts by keyed hash of the password. */
  private readonly counts = new Map<string, number>();
  private readonly state = new WeakMap<ProfileRuntime, ProfileCheckup>();

  constructor(private readonly fetchText: (url: string) => Promise<string> = defaultFetch) {}

  view(profile: ProfileRuntime): PasswordCheckupView {
    const s = this.stateOf(profile);
    const logins = loginsOf(profile);
    const reused = reuseCounts(logins);
    const items: PasswordHealth[] = logins.map((l) => ({
      id: l.id,
      breaches: l.password ? (this.counts.get(this.keyed(l.password)) ?? null) : 0,
      reusedWith: reused.get(l.id) ?? 0,
      weak: l.password !== "" && isWeakPassword(l.password),
    }));
    return { checkedAt: s.checkedAt, running: s.running !== null, error: s.error, items };
  }

  /** Checks every saved password now; resolves with the updated view. */
  async run(profile: ProfileRuntime): Promise<PasswordCheckupView> {
    const s = this.stateOf(profile);
    s.running ??= this.check(profile, s).finally(() => {
      s.running = null;
    });
    await s.running;
    return this.view(profile);
  }

  private async check(profile: ProfileRuntime, s: ProfileCheckup): Promise<void> {
    s.error = null;
    // One request per prefix, whatever number of passwords share it.
    const byPrefix = new Map<string, Array<{ suffix: string; keyed: string }>>();
    for (const login of loginsOf(profile)) {
      if (!login.password) continue;
      const sha1 = createHash("sha1").update(login.password, "utf8").digest("hex").toUpperCase();
      const prefix = sha1.slice(0, 5);
      byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), { suffix: sha1.slice(5), keyed: this.keyed(login.password) }]);
    }
    const prefixes = [...byPrefix.keys()];
    let failed = 0;
    const worker = async (): Promise<void> => {
      for (let prefix = prefixes.shift(); prefix !== undefined; prefix = prefixes.shift()) {
        try {
          const body = await this.fetchText(`${this.endpoint}${prefix}`);
          for (const { suffix, keyed } of byPrefix.get(prefix) ?? []) this.counts.set(keyed, breachCount(body, suffix));
        } catch {
          failed += 1;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL, prefixes.length) }, worker));
    s.checkedAt = Date.now();
    if (failed > 0) s.error = failed === byPrefix.size ? "Could not reach the breach service. Check your connection and try again." : "Some passwords could not be checked. Try again.";
  }

  private keyed(password: string): string {
    return createHmac("sha256", this.key).update(password, "utf8").digest("hex");
  }

  private stateOf(profile: ProfileRuntime): ProfileCheckup {
    let s = this.state.get(profile);
    if (!s) {
      s = { checkedAt: null, running: null, error: null };
      this.state.set(profile, s);
    }
    return s;
  }
}

function loginsOf(profile: ProfileRuntime): Login[] {
  return [
    ...profile.credentials.all().map((c) => ({ id: c.id, password: c.password })),
    ...profile.keepass.records().map((r) => ({ id: r.id, password: r.password })),
  ];
}

async function defaultFetch(url: string): Promise<string> {
  // Padding makes every answer about the same size, so its length says nothing about the prefix.
  const res = await net.fetch(url, { headers: { "Add-Padding": "true" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}
