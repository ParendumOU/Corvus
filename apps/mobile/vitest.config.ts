import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Pure logic only (src/lib): screens are checked in a browser by scripts/web-smoke.mjs.
export default defineConfig({
  resolve: {
    // The app's own "@/" imports (tsconfig paths), for lib modules tested with their platform modules mocked.
    alias: { "@/": fileURLToPath(new URL("./src/", import.meta.url)) },
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
