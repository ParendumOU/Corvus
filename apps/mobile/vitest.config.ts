import { defineConfig } from "vitest/config";

// Pure logic only (src/lib): screens are checked in a browser by scripts/web-smoke.mjs.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
