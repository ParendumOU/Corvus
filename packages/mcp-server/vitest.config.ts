import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@corvus/shared": resolve(import.meta.dirname, "../shared/src/index.ts"),
      "@corvus/webscope": resolve(import.meta.dirname, "../webscope/src/index.ts"),
    },
  },
  test: { include: ["test/**/*.test.ts"], testTimeout: 15000 },
});
