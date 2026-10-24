import path from "node:path";

const here = import.meta.dirname;

export const paths = {
  chromePreload: path.join(here, "../preload/chrome.cjs"),
  internalPreload: path.join(here, "../preload/internal.cjs"),
  splitPreload: path.join(here, "../preload/split.cjs"),
  assistPreload: path.join(here, "../preload/assist.cjs"),
  extensionWorkerPreload: path.join(here, "../preload/extension-sw.cjs"),
  extensionApiPreload: path.join(here, "../preload/extension-api.cjs"),
  adblockScriptletsPreload: path.join(here, "../preload/adblock-scriptlets.cjs"),
  /** Entry of the filter list parser utility process (built next to index.js). */
  adblockParser: path.join(here, "adblock-parser.js"),
  /** Entry of the archive extractor utility process (7-Zip for downloaded packages). */
  archiveWorker: path.join(here, "archive-worker.js"),
  rendererDir: path.join(here, "../renderer"),
  icon: path.join(here, "../../build/icon.png"),
};

/** Set by electron-vite in `dev` mode: the renderer dev server URL. */
export const rendererDevUrl: string | undefined = process.env.ELECTRON_RENDERER_URL;
