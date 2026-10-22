import * as aiEngine from "@corvus/ai-engine";
import * as mcpServer from "@corvus/mcp-server";
import * as syncCore from "@corvus/sync-core";

/**
 * Workspace packages are bundled into the main process by electron-vite, so they are always
 * present in packaged builds. The async, nullable signature is kept so services can still
 * degrade gracefully if a package fails to initialise.
 */
const modules: Record<string, unknown> = {
  "@corvus/ai-engine": aiEngine,
  "@corvus/mcp-server": mcpServer,
  "@corvus/sync-core": syncCore,
};

export function loadOptionalModule<T>(pkg: string, _workspaceDir: string): Promise<T | null> {
  return Promise.resolve((modules[pkg] as T | undefined) ?? null);
}
