import fs from "node:fs";
import path from "node:path";
import { net, utilityProcess } from "electron";
import { ElectronBlocker } from "@ghostery/adblocker-electron";
import type { AdblockListSource } from "../shared/adblock";
import { buildEngine, countFilters, parseEngine, type BuiltEngine } from "./adblock-engine";
import { ADS_AND_TRACKING_LISTS, ANNOYANCE_LISTS, RESOURCES_LIST, downloadList, latestRevisions, type ListFetch } from "./adblock-sources";
import { paths } from "./paths";

/** How often to ask whether the lists moved (uBlock Origin's quick fixes expire after 8 hours). */
const CHECK_MS = 6 * 60 * 60 * 1000;
/** After a failed check (offline, say). */
const RETRY_MS = 30 * 60 * 1000;
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
  /** The list revisions it was built from, and when they were last compared with the newest. */
  revisions?: string;
  checkedAt?: number;
}

export interface FilterSetSpec {
  /** Names the list set; a cached engine built from another set is rebuilt. */
  set: string;
  lists: readonly string[];
  /** Used until the first download succeeds (offline first run). */
  fallback: string;
  /** Cache file names in the adblock directory. */
  engineFile: string;
  metaFile: string;
}

/**
 * The lists Brave and uBlock Origin block with: EasyList and EasyPrivacy plus uBlock Origin's own
 * filters (with its quick fixes, where sites like YouTube are kept ad-free) and Peter Lowe's list.
 */
export function adsAndTrackingSpec(fallback: string): FilterSetSpec {
  return { set: "cdn-ads-and-tracking-1", lists: ADS_AND_TRACKING_LISTS, fallback, engineFile: "engine.bin", metaFile: "meta.json" };
}

/** Cookie notices and other annoyances: EasyList Cookie and uBlock Origin's annoyances lists. */
export function annoyancesSpec(): FilterSetSpec {
  return {
    set: "cdn-annoyances-1",
    lists: ANNOYANCE_LISTS,
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

/**
 * Whether a new engine replaces one that barely filtered: the bundled fallback (first run) or a cache
 * of another list set (first run after an update changed the lists).
 */
export function replacesUnfiltered(previous: Pick<ListMeta, "source" | "lists">, set: string): boolean {
  return previous.source === "bundled" || previous.lists !== set;
}

/** One filter engine: loaded from its cache, rebuilt when its lists move, bundled fallback when offline. */
export class FilterSet {
  blocker: ElectronBlocker;
  meta: ListMeta;
  updating = false;

  constructor(
    private readonly cacheDir: string,
    private readonly spec: FilterSetSpec,
    private readonly onChange: () => void,
    /** A new engine is in place; `unfilteredBefore` as replacesUnfiltered says. */
    private readonly onSwap: (unfilteredBefore: boolean) => void = () => undefined,
  ) {
    const loaded = this.loadFromCache() ?? this.buildFallback();
    this.blocker = loaded.blocker;
    this.meta = loaded.meta;
  }

  /** Checks soon when the last check is old or the cache is of another set, then every few hours. */
  scheduleRefresh(delayMs: number): void {
    if (!this.fresh()) setTimeout(() => void this.refresh(false), delayMs).unref();
    setInterval(() => void this.refresh(false), CHECK_MS).unref();
  }

  async refresh(force: boolean): Promise<void> {
    if (this.updating) return;
    if (!force && this.fresh()) return;
    this.updating = true;
    this.onChange();
    try {
      const fetchImpl: ListFetch = (url) => net.fetch(url);
      const names = [...this.spec.lists, RESOURCES_LIST];
      const revisions = await latestRevisions(fetchImpl, names);
      const key = revisions.join(",");
      if (!force && this.meta.lists === this.spec.set && this.meta.revisions === key) {
        this.meta = { ...this.meta, checkedAt: Date.now() };
        this.writeMeta();
        return;
      }
      const texts = await Promise.all(names.map((name, i) => downloadList(fetchImpl, name, revisions[i]!)));
      const resources = texts.pop() ?? null;
      const { blocker, built } = await parseLists(texts.join("\n"), resources);
      this.blocker = blocker;
      const unfilteredBefore = replacesUnfiltered(this.meta, this.spec.set);
      const now = Date.now();
      this.meta = { updatedAt: now, source: "network", filterCount: built.filterCount, lists: this.spec.set, revisions: key, checkedAt: now };
      this.writeCache(built.bytes);
      this.onSwap(unfilteredBefore);
    } catch (err) {
      console.warn(`[corvus] adblock list refresh failed (${this.spec.set}): ${(err as Error).message}`);
      setTimeout(() => void this.refresh(false), RETRY_MS).unref();
    } finally {
      this.updating = false;
      this.onChange();
    }
  }

  /** Whether the engine in use comes from this set of lists, compared with the newest a moment ago. */
  private fresh(): boolean {
    return this.meta.source !== "bundled" && this.meta.lists === this.spec.set && this.meta.checkedAt !== undefined && Date.now() - this.meta.checkedAt < CHECK_MS;
  }

  private buildFallback(): { blocker: ElectronBlocker; meta: ListMeta } {
    const blocker = parseEngine(this.spec.fallback);
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
          ...(typeof meta.revisions === "string" ? { revisions: meta.revisions } : {}),
          ...(typeof meta.checkedAt === "number" ? { checkedAt: meta.checkedAt } : {}),
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
      this.writeMeta();
    } catch (err) {
      console.warn(`[corvus] adblock cache write failed (${this.spec.set}): ${(err as Error).message}`);
    }
  }

  private writeMeta(): void {
    try {
      const { updatedAt, filterCount, lists, revisions, checkedAt } = this.meta;
      fs.writeFileSync(path.join(this.cacheDir, this.spec.metaFile), JSON.stringify({ updatedAt, filterCount, lists, revisions, checkedAt }), "utf8");
    } catch (err) {
      console.warn(`[corvus] adblock cache write failed (${this.spec.set}): ${(err as Error).message}`);
    }
  }
}
