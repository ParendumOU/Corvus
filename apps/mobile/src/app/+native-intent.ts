import { rebuilding, restoredPath } from '@/hooks/use-route-memory';
import { openInPref } from '@/lib/browser-store';
import { systemPath, webLink } from '@/lib/links';

/**
 * A link shared to Corvus from another app (Android share sheet) opens the Send screen; a web link
 * Corvus is asked to open as the phone's browser opens in Corvus's browser, or on the Open screen
 * when pages open in another browser app (Settings → Open pages in). When Android builds Corvus's
 * screen again (plugins/with-restore-link.js), the app opens where the person was.
 */
export async function redirectSystemPath({ path, initial }: { path: string; initial: boolean }): Promise<string> {
  if (initial && rebuilding(path)) return restoredPath();
  if (!webLink(path)) return systemPath(path);
  return systemPath(path, await openInPref().catch(() => 'corvus' as const));
}
