import { ElectronBlocker } from "@ghostery/adblocker-electron";

export const ENGINE_CONFIG = { enableMutationObserver: true, guessRequestTypeFromUrl: true } as const;

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
  const blocker = ElectronBlocker.parse(lists, ENGINE_CONFIG);
  if (resources) blocker.updateResources(resources, `${resources.length}`);
  return { bytes: blocker.serialize(), filterCount: countFilters(blocker) };
}
