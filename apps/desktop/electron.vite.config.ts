import fs from "node:fs";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";
import type { Plugin } from "vite";
import { packageRootOf } from "./scripts/license-policy.mjs";

/**
 * Records which third-party packages a build bundles into out/ (out/.licenses/<target>.json), so
 * scripts/third-party-notices.mjs can list exactly what ships and check its licences.
 */
function bundledPackages(target: string): Plugin {
  return {
    name: "corvus-bundled-packages",
    generateBundle(_options, bundle) {
      const roots = new Set<string>();
      for (const item of Object.values(bundle)) {
        if (item.type !== "chunk") continue;
        const ids = (item as { moduleIds?: string[] }).moduleIds ?? Object.keys(item.modules ?? {});
        for (const id of ids) {
          const root = packageRootOf(id);
          if (root) roots.add(root);
        }
      }
      const dir = resolve(import.meta.dirname, "out/.licenses");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(resolve(dir, `${target}.json`), JSON.stringify([...roots].sort(), null, 2));
    },
  };
}

const shared = {
  "@corvus/shared": resolve(import.meta.dirname, "../../packages/shared/src/index.ts"),
  "@corvus/webscope": resolve(import.meta.dirname, "../../packages/webscope/src/index.ts"),
};

const pages = ["chrome", "newtab", "search", "settings", "bookmarks", "history", "extensions", "downloads", "assist", "agent-overlay", "webscope", "watches", "schedules", "reader", "reading", "passwords", "pdf", "find", "crash", "devices", "agent-runs", "flows", "welcome", "annotations", "site-profiles"];

export default defineConfig({
  main: {
    resolve: { alias: shared },
    plugins: [bundledPackages("main")],
    build: {
      outDir: "out/main",
      rolldownOptions: {
        input: {
          index: resolve(import.meta.dirname, "src/main/index.ts"),
          // The filter list parser runs as its own utility process.
          "adblock-parser": resolve(import.meta.dirname, "src/main/adblock-parser.ts"),
          // So does the archive extractor (7-Zip).
          "archive-worker": resolve(import.meta.dirname, "src/main/archive-worker.ts"),
        },
        // Keep the Ghostery adblocker external: it resolves its content-script preload from disk at
        // runtime (require.resolve), which bundling would break. 7-Zip loads its .wasm next to itself.
        external: [/^@ghostery\//, /^tldts/, /^7z-wasm/],
      },
    },
  },
  preload: {
    resolve: { alias: shared },
    plugins: [bundledPackages("preload")],
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
          "adblock-scriptlets": resolve(import.meta.dirname, "src/preload/adblock-scriptlets.ts"),
          "cookie-consent": resolve(import.meta.dirname, "src/preload/cookie-consent.ts"),
        },
        output: { format: "cjs", entryFileNames: "[name].cjs" },
      },
    },
  },
  renderer: {
    root: "src/renderer",
    base: "./",
    resolve: { alias: shared },
    plugins: [react(), bundledPackages("renderer")],
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
