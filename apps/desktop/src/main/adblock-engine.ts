import { ElectronBlocker } from "@ghostery/adblocker-electron";

export const ENGINE_CONFIG = { enableMutationObserver: true, guessRequestTypeFromUrl: true, loadExtendedSelectors: true, loadPreprocessors: true } as const;

/**
 * What the lists' `!#if` blocks ask of the browser, as uBlock Origin answers on Chromium (anything else
 * is false). Without it rules meant for Firefox, phones or uBlock Origin Lite run too, and they fight
 * the ones meant for this browser.
 */
const LIST_ENV = new Map([
  ["env_chromium", true],
  ["cap_user_stylesheet", true],
  ["ext_ublock", true],
]);

/** Parses rules into an engine that applies only those meant for this browser. */
export function parseEngine(lists: string): ElectronBlocker {
  const blocker = ElectronBlocker.parse(lists, ENGINE_CONFIG);
  blocker.updateEnv(LIST_ENV);
  return blocker;
}

/** What the list parser hands back: the engine, serialized, and how many rules it holds. */
export interface BuiltEngine {
  bytes: Uint8Array;
  filterCount: number;
}

/** Network plus cosmetic rules of an engine. */
export function countFilters(blocker: ElectronBlocker): number {
  const f = blocker.getFilters();
  return f.networkFilters.length + f.cosmeticFilters.length;
}

/**
 * Parses downloaded filter lists (and uBlock Origin's resources, for scriptlets and redirects) into
 * a serialized engine. The slow part of a list refresh: it runs in the list parser process.
 */
export function buildEngine(lists: string, resources: string | null): BuiltEngine {
  const blocker = parseEngine(lists);
  if (resources) blocker.updateResources(resources, `${resources.length}`);
  return { bytes: blocker.serialize(), filterCount: countFilters(blocker) };
}
