/**
 * IPC contract for per-site AI profiles. The corvus://site-profiles manager talks InternalRpc.
 * Merged into InternalRpc / InternalEvent in ./ipc.ts so that file's diff stays small.
 */
import type { AccessLevel } from "@corvus/shared";
import type { SiteProfile, SiteProfileInput } from "./site-profiles";

export type { SiteProfile, SiteProfileInput };

/** Result of testing a URL against the stored profiles (manager "Test a URL" box). */
export interface SiteProfileMatch {
  url: string;
  /** The winning profile, or null when nothing matches (today's behavior is unchanged). */
  profile: SiteProfile | null;
  /** Effective agent access after the profile's cap narrows the global level. */
  effectiveAccess: AccessLevel;
  /** Provider/model that would run, after any profile override. */
  provider: string;
  model: string;
}

export interface SiteProfileInternalRpc {
  "siteProfile.list"(): SiteProfile[];
  "siteProfile.add"(input: SiteProfileInput): SiteProfile[];
  "siteProfile.update"(id: string, input: SiteProfileInput): SiteProfile[];
  "siteProfile.remove"(id: string): SiteProfile[];
  "siteProfile.setEnabled"(id: string, enabled: boolean): SiteProfile[];
  /** Test which profile a URL resolves to, plus the effective access/provider. */
  "siteProfile.match"(url: string): SiteProfileMatch;
}

export type SiteProfileInternalEvent = { type: "site-profiles-changed" };
