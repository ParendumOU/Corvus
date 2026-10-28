import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@corvus/shared": fileURLToPath(new URL("../../packages/shared/src/index.ts", import.meta.url)),
      "@corvus/sync-server/embedded": fileURLToPath(new URL("../../services/sync-server/src/embedded.ts", import.meta.url)),
      // Sources, so tests never run against a stale dist/ build.
      "@corvus/sync-core": fileURLToPath(new URL("../../packages/sync-core/src/index.ts", import.meta.url)),
      "@corvus/mcp-server/access": fileURLToPath(new URL("../../packages/mcp-server/src/access.ts", import.meta.url)),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
