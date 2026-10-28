// Electron main for scripts/make-tab-icons.mjs: strokes each icon's paths on a canvas and saves it.
const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow } = require("electron");

/** The icons' shapes, as in src/components/icon.tsx (home, sparkle, bookmark, settings). */
const ICONS = {
  home: { paths: ["M3 10.5 12 3l9 7.5", "M5 9v11h5v-6h4v6h5V9"] },
  assist: { paths: ["M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z", "M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"] },
  library: { paths: ["M19 21l-7-4.5L5 21V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"] },
  settings: {
    circles: [[12, 12, 3]],
    paths: [
      "M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
    ],
  },
};

const dir = path.resolve(__dirname, "../assets/images/tabIcons");

app.whenReady().then(async () => {
  let ok = true;
  try {
    const win = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
    await win.loadURL("data:text/html,<!doctype html><title>icons</title>");
    for (const [name, icon] of Object.entries(ICONS)) {
      for (const [suffix, size] of [["", 24], ["@2x", 48], ["@3x", 72]]) {
        const url = await win.webContents.executeJavaScript(`(() => {
          const c = document.createElement('canvas');
          c.width = ${size};
          c.height = ${size};
          const g = c.getContext('2d');
          g.scale(${size / 24}, ${size / 24});
          g.lineWidth = 2;
          g.lineCap = 'round';
          g.lineJoin = 'round';
          g.strokeStyle = '#000';
          for (const d of ${JSON.stringify(icon.paths ?? [])}) g.stroke(new Path2D(d));
          for (const [x, y, r] of ${JSON.stringify(icon.circles ?? [])}) { g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.stroke(); }
          return c.toDataURL('image/png');
        })()`);
        fs.writeFileSync(path.join(dir, `${name}${suffix}.png`), Buffer.from(url.split(",")[1], "base64"));
      }
      console.log(`wrote the ${name} tab icon at 1x, 2x and 3x`);
    }
  } catch (err) {
    ok = false;
    console.error(err);
  } finally {
    app.exit(ok ? 0 : 1);
  }
});
