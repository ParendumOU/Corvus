import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

const shared = {
  "@corvus/shared": resolve(import.meta.dirname, "../../packages/shared/src/index.ts"),
  "@corvus/webscope": resolve(import.meta.dirname, "../../packages/webscope/src/index.ts"),
};

const pages = ["chrome", "newtab", "search", "settings", "bookmarks", "history", "extensions", "downloads", "assist", "agent-overlay", "webscope", "watches", "schedules", "reader", "reading", "passwords", "pdf", "find", "crash", "devices", "agent-runs", "flows", "welcome", "annotations", "site-profiles"];

export default defineConfig({
  main: {
    resolve: { alias: shared },
    build: {
      outDir: "out/main",
      rolldownOptions: {
        input: { index: resolve(import.meta.dirname, "src/main/index.ts") },
        // Keep the Ghostery adblocker external: it resolves its content-script preload from disk at
        // runtime (require.resolve), which bundling would break.
        external: [/^@ghostery\//, /^tldts/],
      },
    },
  },
  preload: {
    resolve: { alias: shared },
    build: {
      outDir: "out/preload",
      // Sandboxed preloads must be self-contained CommonJS bundles.
      externalizeDeps: false,
      isolatedEntries: true,
      rolldownOptions: {
        input: {
          chrome: resolve(import.meta.dirname, "src/preload/chrome.ts"),
          internal: resolve(import.meta.dirname, "src/preload/internal.ts"),
          split: resolve(import.meta.dirname, "src/preload/split.ts"),
          assist: resolve(import.meta.dirname, "src/preload/assist.ts"),
          "extension-sw": resolve(import.meta.dirname, "src/preload/extension-sw.ts"),
          "extension-api": resolve(import.meta.dirname, "src/preload/extension-api.ts"),
        },
        output: { format: "cjs", entryFileNames: "[name].cjs" },
      },
    },
  },
  renderer: {
    root: "src/renderer",
    base: "./",
    resolve: { alias: shared },
    plugins: [react()],
    server: { hmr: { host: "localhost" } },
    build: {
      outDir: resolve(import.meta.dirname, "out/renderer"),
      // Minify the renderer. An older rolldown/oxc minifier miscompiled RunPanel (mangled a local
      // reference to undefined -> "c is not a function" at render, caught by DebugBoundary). The
      // current toolchain renders it cleanly; the agent smoke asserts the RunPanel mounts (not the
      // DebugBoundary fallback) so a future minifier regression fails CI instead of shipping.
      minify: true,
      rolldownOptions: {
        input: Object.fromEntries(pages.map((p) => [p, resolve(import.meta.dirname, `src/renderer/${p}.html`)])),
      },
    },
  },
});
