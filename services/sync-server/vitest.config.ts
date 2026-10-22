import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Run against sync-core sources so tests never depend on a stale dist/ build.
export default defineConfig({
  resolve: {
    alias: {
      "@corvus/sync-core": fileURLToPath(new URL("../../packages/sync-core/src/index.ts", import.meta.url)),
    },
  },
});
