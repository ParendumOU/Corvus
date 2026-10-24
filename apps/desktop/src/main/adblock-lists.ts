import fs from "node:fs";
import path from "node:path";
import { net, utilityProcess } from "electron";
import { ElectronBlocker, adsAndTrackingLists, fetchLists, fetchResources, fullLists } from "@ghostery/adblocker-electron";
import type { AdblockListSource } from "../shared/adblock";
import { ENGINE_CONFIG, buildEngine, countFilters, type BuiltEngine } from "./adblock-engine";
import { paths } from "./paths";

const REFRESH_MS = 7 * 24 * 60 * 60 * 1000;
const PARSE_TIMEOUT_MS = 3 * 60_000;

/**
 * Parses filter lists into an engine in a short-lived utility process, so the main process (and
 * every tab's input with it) never stalls on the hundred thousand rules; only the quick
 * deserialization happens here. Parses in this process if the parser cannot run.
 */
export async function parseLists(lists: string, resources: string | null): Promise<{ blocker: ElectronBlocker; built: BuiltEngine; offMainThread: boolean }> {
  let built: BuiltEngine;
  let offMainThread = true;
  try {
    built = await parseInUtilityProcess(lists, resources);
  } catch (err) {
    console.warn(`[corvus] adblock list parser unavailable, parsing in the main process: ${(err as Error).message}`);
    built = buildEngine(lists, resources);
    offMainThread = false;
  }
  return { blocker: ElectronBlocker.deserialize(built.bytes), built, offMainThread };
}

function parseInUtilityProcess(lists: string, resources: string | null): Promise<BuiltEngine> {
  return new Promise((resolve, reject) => {
    const child = utilityProcess.fork(paths.adblockParser, [], { serviceName: "Corvus filter lists", stdio: "ignore" });
    let settled = false;
    const finish = (settle: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      settle();
      child.kill();
    };
    const timer = setTimeout(() => finish(() => reject(new Error("timed out"))), PARSE_TIMEOUT_MS);
    child.once("spawn", () => child.postMessage({ lists, resources }));
    child.once("message", (msg: { ok?: boolean; bytes?: Uint8Array; filterCount?: number; error?: string }) =>
      finish(() => (msg.ok && msg.bytes ? resolve({ bytes: msg.bytes, filterCount: msg.filterCount ?? 0 }) : reject(new Error(msg.error ?? "no engine")))),
    );
    child.once("exit", (code) => finish(() => reject(new Error(`exited with code ${code}`))));
  });
}

export interface ListMeta {
  updatedAt: number | null;
  source: AdblockListSource;
  filterCount: number;
  /** Which list set the cached engine was built from. */
  lists?: string;
}

export interface FilterSetSpec {
  /** Names the list set; a cached engine built from another set is rebuilt. */
  set: string;
  urls: readonly string[];
  /** Used until the first download succeeds (offline first run). */
  fallback: string;
  /** Cache file names in the adblock directory. */
  engineFile: string;
  metaFile: string;
}

/**
 * The lists Brave and uBlock Origin block with: EasyList and EasyPrivacy plus uBlock Origin's own
 * filters (with its quick fixes, where sites like YouTube are kept ad-free) and Peter Lowe's list,
 * as Ghostery mirrors them.
 */
export function adsAndTrackingSpec(fallback: string): FilterSetSpec {
  return { set: "ghostery-ads-and-tracking-1", urls: adsAndTrackingLists, fallback, engineFile: "engine.bin", metaFile: "meta.json" };
}

/** Cookie notices and other annoyances: EasyList Cookie and uBlock Origin's annoyances lists. */
export function annoyancesSpec(): FilterSetSpec {
  return {
    set: "ghostery-annoyances-1",
    urls: fullLists.filter((url) => !adsAndTrackingLists.includes(url)),
    fallback: ANNOYANCES_FALLBACK,
    engineFile: "annoyances.bin",
    metaFile: "annoyances.json",
  };
}

/** The consent platforms most sites use, so their notices hide even before the lists download. */
const ANNOYANCES_FALLBACK = [
  "###onetrust-consent-sdk",
  "###onetrust-banner-sdk",
  "###CybotCookiebotDialog",
  "###CybotCookiebotDialogBodyUnderlay",
  "###usercentrics-root",
  "###didomi-host",
  "##.didomi-popup-open:style(overflow: auto !important)",
  "##.qc-cmp2-container",
  "###qc-cmp2-container",
  "###truste-consent-track",
  "##.truste_overlay",
  "###cookie-law-info-bar",
  "##.cky-consent-container",
  "##.cky-overlay",
  "###cmplz-cookiebanner-container",
  "##.cc-window.cc-banner",
  "###sp_message_container_1",
].join("\n");

/** One filter engine: loaded from its cache, refreshed weekly, bundled fallback when offline. */
export class FilterSet {
  blocker: ElectronBlocker;
  meta: ListMeta;
  updating = false;

  constructor(
    private readonly cacheDir: string,
    private readonly spec: FilterSetSpec,
    private readonly onChange: () => void,
  ) {
    const loaded = this.loadFromCache() ?? this.buildFallback();
    this.blocker = loaded.blocker;
    this.meta = loaded.meta;
  }

  /** Refreshes at once when the cache is missing, stale or of another set, then weekly. */
  scheduleRefresh(delayMs: number): void {
    if (!this.fresh()) setTimeout(() => void this.refresh(false), delayMs).unref();
    setInterval(() => void this.refresh(false), REFRESH_MS).unref();
  }

  async refresh(force: boolean): Promise<void> {
    if (this.updating) return;
    if (!force && this.fresh()) return;
    this.updating = true;
    this.onChange();
    try {
      // As ElectronBlocker.fromLists, with the parsing moved out of this process.
      const fetchImpl = (url: string): ReturnType<typeof net.fetch> => net.fetch(url);
      const [lists, resources] = await Promise.all([fetchLists(fetchImpl, [...this.spec.urls]), fetchResources(fetchImpl)]);
      const { blocker, built } = await parseLists(lists.join("\n"), resources);
      this.blocker = blocker;
      this.meta = { updatedAt: Date.now(), source: "network", filterCount: built.filterCount, lists: this.spec.set };
      this.writeCache(built.bytes);
    } catch (err) {
      console.warn(`[corvus] adblock list refresh failed (${this.spec.set}): ${(err as Error).message}`);
    } finally {
      this.updating = false;
      this.onChange();
    }
  }

  /** Whether the engine in use is a cached one, built from this set, less than a week ago. */
  private fresh(): boolean {
    return this.meta.source === "cache" && this.meta.lists === this.spec.set && this.meta.updatedAt !== null && Date.now() - this.meta.updatedAt <= REFRESH_MS;
  }

  private buildFallback(): { blocker: ElectronBlocker; meta: ListMeta } {
    const blocker = ElectronBlocker.parse(this.spec.fallback, ENGINE_CONFIG);
    return { blocker, meta: { updatedAt: null, source: "bundled", filterCount: countFilters(blocker) } };
  }

  private loadFromCache(): { blocker: ElectronBlocker; meta: ListMeta } | null {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(this.cacheDir, this.spec.metaFile), "utf8")) as ListMeta;
      const bytes = fs.readFileSync(path.join(this.cacheDir, this.spec.engineFile));
      const blocker = ElectronBlocker.deserialize(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
      return {
        blocker,
        meta: {
          updatedAt: meta.updatedAt ?? null,
          source: "cache",
          filterCount: meta.filterCount ?? countFilters(blocker),
          ...(typeof meta.lists === "string" ? { lists: meta.lists } : {}),
        },
      };
    } catch {
      return null;
    }
  }

  private writeCache(bytes: Uint8Array): void {
    try {
      fs.mkdirSync(this.cacheDir, { recursive: true });
      fs.writeFileSync(path.join(this.cacheDir, this.spec.engineFile), bytes);
      fs.writeFileSync(
        path.join(this.cacheDir, this.spec.metaFile),
        JSON.stringify({ updatedAt: this.meta.updatedAt, filterCount: this.meta.filterCount, lists: this.meta.lists }),
        "utf8",
      );
    } catch (err) {
      console.warn(`[corvus] adblock cache write failed (${this.spec.set}): ${(err as Error).message}`);
    }
  }
}
