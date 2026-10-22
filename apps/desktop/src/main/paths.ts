import path from "node:path";

const here = import.meta.dirname;

export const paths = {
  chromePreload: path.join(here, "../preload/chrome.cjs"),
  internalPreload: path.join(here, "../preload/internal.cjs"),
  splitPreload: path.join(here, "../preload/split.cjs"),
  assistPreload: path.join(here, "../preload/assist.cjs"),
  extensionWorkerPreload: path.join(here, "../preload/extension-sw.cjs"),
  extensionApiPreload: path.join(here, "../preload/extension-api.cjs"),
  rendererDir: path.join(here, "../renderer"),
  icon: path.join(here, "../../build/icon.png"),
};

/** Set by electron-vite in `dev` mode: the renderer dev server URL. */
export const rendererDevUrl: string | undefined = process.env.ELECTRON_RENDERER_URL;
