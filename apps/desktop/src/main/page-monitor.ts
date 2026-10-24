/**
 * Background page-change monitoring. A single timer polls every profile's watches on their own
 * interval (with a global concurrency cap), re-fetches each page in the main process (never inside a
 * renderer) under the same SSRF guard as ai-engine deep mode, extracts and normalizes the main text,
 * and when it meaningfully changed asks the AI engine for a short summary, then notifies and badges.
 */
import { Notification } from "electron";
import {
  defaultLookup,
  extractReadableText,
  fetchWithTimeout,
  readTextCapped,
  resolvesToPublic,
  USER_AGENT,
} from "@corvus/ai-engine";
import {
  BASELINE_CHARS,
  DEFAULT_MAX_CONCURRENT,
  diffForPrompt,
  diffNormalized,
  fingerprint,
  isWatchableUrl,
  normalizeWatchText,
  conditionNotifies,
  selectDue,
  type Watch,
} from "../shared/page-watch";
import type { WatchBarState } from "../shared/watch-ipc";
import type { AppContext } from "./context";
import type { ProfileRuntime } from "./profiles";
import { WatchStore } from "./watch-store";
import type { BrowserWindowCtl } from "./window";

const TICK_MS = 60_000;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const WATCHES_URL = "corvus://watches/";

function errorText(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.length > 200 ? `${message.slice(0, 197)}…` : message;
}

/** Fallback summary (no AI provider) built from the raw diff lines. */
function fallbackSummary(diff: { added: string[]; removed: string[] }): string {
  const parts: string[] = [];
  if (diff.added.length) parts.push(`${diff.added.length} line(s) added`);
  if (diff.removed.length) parts.push(`${diff.removed.length} line(s) removed`);
  const preview = diff.added[0] ?? diff.removed[0] ?? "";
  const snippet = preview ? ` — e.g. "${preview.slice(0, 120)}"` : "";
  return `${parts.join(", ") || "Content changed"}${snippet}`;
}

export class PageMonitor {
  private readonly stores = new Map<string, WatchStore>();
  private timer: NodeJS.Timeout | null = null;
  /** Watch ids being fetched right now (global, ids are unique uuids). */
  private readonly running = new Set<string>();
  /** Smoke tests inject a fetcher to exercise the pipeline against the loopback server the SSRF guard blocks. */
  private testFetch: ((url: string) => Promise<string>) | undefined;
  /** The notifications shown, newest last (the smoke test reads them; a few are kept). */
  readonly notified: Array<{ profileId: string; title: string; body: string }> = [];

  constructor(private readonly ctx: AppContext) {}

  setTestFetcher(fetcher: ((url: string) => Promise<string>) | undefined): void {
    this.testFetch = fetcher;
  }

  /** Called for every profile runtime as it is created. */
  attach(runtime: ProfileRuntime): void {
    this.storeFor(runtime);
  }

  storeFor(runtime: ProfileRuntime): WatchStore {
    let store = this.stores.get(runtime.profile.id);
    if (!store) {
      store = new WatchStore(runtime.dataDir, () => this.ctx.settings.get().monitor.maxWatches);
      this.stores.set(runtime.profile.id, store);
      store.onChange(() => this.pushTo(runtime.profile.id));
    }
    return store;
  }

  barState(runtime: ProfileRuntime): WatchBarState {
    const store = this.storeFor(runtime);
    return { total: store.list().length, unseen: store.unseenCount(), enabled: this.ctx.settings.get().monitor.enabled };
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.flush();
  }

  flush(): void {
    for (const store of this.stores.values()) store.flush();
  }

  /** Chrome UI: start watching the active tab, then open the manager. */
  addActive(win: BrowserWindowCtl): void {
    const tab = win.activeTab();
    if (tab) this.watchTab(win, { url: tab.url, title: tab.title, ...(tab.faviconUrl ? { faviconUrl: tab.faviconUrl } : {}) });
    else win.openSingleton(WATCHES_URL);
  }

  /** Start watching a specific page (tab/omnibox/menu), then open the manager. */
  watchTab(win: BrowserWindowCtl, page: { url: string; title: string; faviconUrl?: string }): void {
    if (isWatchableUrl(page.url)) {
      const store = this.storeFor(win.profile);
      const watch = store.add({
        url: page.url,
        title: page.title || page.url,
        ...(page.faviconUrl ? { faviconUrl: page.faviconUrl } : {}),
        intervalMinutes: this.ctx.settings.get().monitor.defaultIntervalMinutes,
      });
      if (watch) void this.check(win.profile.profile.id, watch);
    }
    win.openSingleton(WATCHES_URL);
  }

  /** corvus://watches "Check now": run a check immediately, ignoring the interval. */
  checkNow(runtime: ProfileRuntime, id: string): void {
    const watch = this.storeFor(runtime).get(id);
    if (watch && !this.running.has(id)) void this.check(runtime.profile.id, watch);
  }

  private tick(): void {
    // Reuse this single poll timer to drive scheduled agents too (no second timer system).
    this.ctx.scheduledAgents.tick();
    if (!this.ctx.settings.get().monitor.enabled) return;
    const owners = new Map<string, string>();
    const all: Watch[] = [];
    for (const [profileId, store] of this.stores) {
      for (const w of store.list()) {
        owners.set(w.id, profileId);
        all.push(w);
      }
    }
    const due = selectDue(all, { now: Date.now(), running: this.running, maxConcurrent: DEFAULT_MAX_CONCURRENT });
    for (const w of due) {
      const profileId = owners.get(w.id);
      if (profileId) void this.check(profileId, w);
    }
  }

  private async check(profileId: string, watch: Watch): Promise<void> {
    const store = this.stores.get(profileId);
    if (!store || this.running.has(watch.id)) return;
    this.running.add(watch.id);
    store.setChecking(watch.id, true);
    try {
      const extracted = this.testFetch ? await this.testFetch(watch.url) : await this.fetchExtracted(watch.url);
      const normalized = normalizeWatchText(extracted);
      const checkedAt = Date.now();
      const fp = fingerprint(normalized);
      const baseline = normalized.slice(0, BASELINE_CHARS);
      if (watch.condition && (await this.checkCondition(profileId, store, watch, extracted, normalized, fp, baseline, checkedAt))) return;
      if (watch.fingerprint === null) {
        store.update(watch.id, { fingerprint: fp, baseline, lastCheckedAt: checkedAt, lastResult: "ok", lastError: undefined });
        return;
      }
      if (fp === watch.fingerprint) {
        store.update(watch.id, { lastCheckedAt: checkedAt, lastResult: "ok", lastError: undefined });
        return;
      }
      const diff = diffNormalized(watch.baseline, normalized);
      if (!diff.changed) {
        store.update(watch.id, { fingerprint: fp, baseline, lastCheckedAt: checkedAt, lastResult: "ok", lastError: undefined });
        return;
      }
      const summary = await this.ctx.assist
        .summarizeWatchChange({ url: watch.url, title: watch.title, diff: diffForPrompt(diff) })
        .catch(() => null);
      const text = summary?.text || fallbackSummary(diff);
      store.update(watch.id, {
        fingerprint: fp,
        baseline,
        lastCheckedAt: checkedAt,
        lastChangedAt: checkedAt,
        lastResult: "changed",
        changeSummary: text,
        unseen: true,
        lastError: undefined,
      });
      this.onChanged(profileId, watch, text);
    } catch (err) {
      store.update(watch.id, { lastCheckedAt: Date.now(), lastResult: "error", lastError: errorText(err) });
    } finally {
      this.running.delete(watch.id);
      store.setChecking(watch.id, false);
    }
  }

  /**
   * A watch with a "Notify me when…" condition: when the page is new or meaningfully changed (or
   * the condition's state is not known yet), the AI says whether the condition holds, and only its
   * becoming true notifies. Returns false when there is no AI to judge it, so the caller falls back
   * to notifying on any change.
   */
  private async checkCondition(
    profileId: string,
    store: WatchStore,
    watch: Watch,
    extracted: string,
    normalized: string,
    fp: string,
    baseline: string,
    checkedAt: number,
  ): Promise<boolean> {
    const known = watch.conditionMet === true || watch.conditionMet === false;
    const unchanged = watch.fingerprint !== null && (fp === watch.fingerprint || !diffNormalized(watch.baseline, normalized).changed);
    if (known && unchanged) {
      store.update(watch.id, { fingerprint: fp, baseline, lastCheckedAt: checkedAt, lastResult: "ok", lastError: undefined });
      return true;
    }
    const verdict = await this.ctx.assist
      // The page as extracted (case, prices and dates intact), not the normalized text used for diffing.
      .evaluateWatchCondition({ url: watch.url, title: watch.title, condition: watch.condition ?? "", text: extracted })
      .catch(() => null);
    if (!verdict) {
      store.update(watch.id, { conditionDetail: "Checking a condition needs an AI provider: every change is reported instead." });
      return false;
    }
    const notify = conditionNotifies(watch.conditionMet, verdict.met);
    store.update(watch.id, {
      fingerprint: fp,
      baseline,
      lastCheckedAt: checkedAt,
      lastResult: notify ? "changed" : "ok",
      lastError: undefined,
      conditionMet: verdict.met,
      conditionDetail: verdict.detail,
      ...(notify ? { lastChangedAt: checkedAt, changeSummary: verdict.detail || watch.condition || "", unseen: true } : {}),
    });
    if (notify) this.onChanged(profileId, watch, verdict.detail || `Now true: ${watch.condition}`, `Now true: ${watch.condition}`);
    return true;
  }

  /** Read-only GET of a public http(s) page, re-checking the public-address guard on every redirect. */
  private async fetchExtracted(url: string): Promise<string> {
    if (!isWatchableUrl(url)) throw new Error("Only public http(s) pages can be watched");
    let current = url;
    let res: Response | undefined;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (!isWatchableUrl(current)) throw new Error("Refusing to follow a non-public redirect");
      if (!(await resolvesToPublic(current, defaultLookup))) throw new Error("Refusing to fetch a private or loopback address");
      res = await fetchWithTimeout(
        fetch,
        current,
        { headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml" }, redirect: "manual" },
        FETCH_TIMEOUT_MS,
      );
      const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
      if (!location) break;
      await res.body?.cancel();
      current = new URL(location, current).toString();
      res = undefined;
    }
    if (!res) throw new Error("Too many redirects");
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`Server returned HTTP ${res.status}`);
    }
    const type = res.headers.get("content-type") ?? "";
    if (!/text\/html|application\/xhtml\+xml/i.test(type)) {
      await res.body?.cancel();
      throw new Error("The page is not HTML");
    }
    const html = await readTextCapped(res, MAX_BYTES);
    if (html === null) throw new Error("The page is too large to monitor");
    const text = extractReadableText(html);
    if (!text) throw new Error("No readable text found on the page");
    return text;
  }

  private onChanged(profileId: string, watch: Watch, summary: string, heading = `Changed: ${watch.title}`): void {
    this.notified.push({ profileId, title: heading, body: summary });
    if (this.notified.length > 20) this.notified.shift();
    if (Notification.isSupported()) {
      const notification = new Notification({ title: heading.slice(0, 120), body: summary.slice(0, 200) });
      notification.on("click", () => {
        const win = this.ctx.windows.forProfile(profileId)[0] ?? this.ctx.windows.focused();
        win?.openSingleton(WATCHES_URL);
      });
      notification.show();
    }
    this.pushTo(profileId);
  }

  private pushTo(profileId: string): void {
    for (const win of this.ctx.windows.forProfile(profileId)) {
      win.pushState();
      win.notifyInternalPages({ type: "watches-changed" }, ["watches"]);
    }
  }
}
