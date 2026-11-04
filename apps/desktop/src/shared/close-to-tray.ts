/**
 * "Keep running in the notification area" (main/tray.ts). macOS keeps an app with no window in the
 * Dock already, so the setting is for Windows and Linux.
 */
export function trayAvailable(platform: string): boolean {
  return platform === "win32" || platform === "linux";
}

/**
 * Whether closing a window tucks it away in the notification area instead of closing it: only the
 * last one, with its tabs. A private window still closes (its pages and data must go), and so does
 * one whose last tab was just closed; Corvus then keeps running with no window.
 */
export function keepWindowOnClose(s: { enabled: boolean; isPrivate: boolean; tabCount: number; otherWindows: number }): boolean {
  return s.enabled && !s.isPrivate && s.tabCount > 0 && s.otherWindows === 0;
}
