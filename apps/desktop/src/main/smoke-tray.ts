import type { AppContext } from "./context";
import type { BrowserWindowCtl } from "./window";

interface Helpers {
  url: string;
  win: BrowserWindowCtl;
  check: (name: string, ok: boolean, detail?: unknown) => void;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, timeoutMs = 6000): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(80);
  }
  return cond();
}

/**
 * Settings > "Keep running in the notification area": closing a window that is not the last one
 * still closes it; closing the last one keeps it (and Corvus) running out of sight, where an agent
 * goes on working in it; the tray's Open brings it back. Leaves the setting off and `win` shown.
 */
export async function runTraySmoke(ctx: AppContext, { url, win, check }: Helpers): Promise<void> {
  ctx.settings.update({ startup: { closeToTray: true } });
  check("tray: the setting puts an icon in the notification area", ctx.tray.keepsRunning());
  if (!ctx.tray.keepsRunning()) {
    ctx.settings.update({ startup: { closeToTray: false } });
    return;
  }
  try {
    const other = ctx.windows.open(win.profile.profile.id, [url]);
    await sleep(500);
    other.close();
    check("tray: closing a window while another is open still closes it", await until(() => other.isDisposed()));

    // Windows earlier checks left open: only `win` may remain for the last-window case.
    for (const w of ctx.windows.all()) if (w !== win) w.close();
    await until(() => ctx.windows.all().length === 1);
    win.close();
    await sleep(800);
    check("tray: closing the last window keeps it, and Corvus, running", !win.isDisposed() && ctx.windows.all().includes(win), {
      disposed: win.isDisposed(),
      windows: ctx.windows.all().length,
      minimized: win.win.isMinimized(),
    });

    const tab = await ctx.controller.openTab(url, { background: true, agent: true });
    check("tray: an agent's tab opens in the window out of sight", win.hasTab(tab.id), { tab: tab.id });
    const shot = await ctx.controller.screenshot(tab.id);
    check("tray: an agent can still capture its page", shot.base64.length > 1000, { bytes: shot.base64.length });
    await ctx.controller.closeTab(tab.id);

    ctx.tray.open();
    check("tray: Open brings the window back", await until(() => win.win.isVisible() && !win.win.isMinimized()), {
      visible: win.win.isVisible(),
      minimized: win.win.isMinimized(),
    });
  } finally {
    ctx.settings.update({ startup: { closeToTray: false } });
    if (win.win.isMinimized()) win.present();
  }
  check("tray: turned off, Corvus quits with its last window again", !ctx.tray.keepsRunning());
}
