import * as aiEngine from "@corvus/ai-engine";
import * as syncCore from "@corvus/sync-core";

/**
 * Workspace packages are bundled into the main process by electron-vite, so they are always
 * present in packaged builds. The async, nullable signature is kept so services can still
 * degrade gracefully if a package fails to initialise. The MCP server (with the MCP SDK) is its
 * own chunk, loaded when the server first starts: most starts never need it.
 */
const modules: Record<string, () => Promise<unknown>> = {
  "@corvus/ai-engine": async () => aiEngine,
  "@corvus/mcp-server": () => import("@corvus/mcp-server"),
  "@corvus/sync-core": async () => syncCore,
};

export function loadOptionalModule<T>(pkg: string, _workspaceDir: string): Promise<T | null> {
  const load = modules[pkg];
  if (!load) return Promise.resolve(null);
  return load().then(
    (mod) => mod as T,
    (err: unknown) => {
      console.error(`[corvus] could not load ${pkg}:`, err);
      return null;
    },
  );
}
