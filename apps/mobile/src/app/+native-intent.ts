import { openInPref } from '@/lib/browser-store';
import { systemPath, webLink } from '@/lib/links';

/**
 * A link shared to Corvus from another app (Android share sheet) opens the Send screen; a web link
 * Corvus is asked to open as the phone's browser opens in Corvus's browser, or on the Open screen
 * when pages open in another browser app (Settings → Open pages in).
 */
export async function redirectSystemPath({ path }: { path: string; initial: boolean }): Promise<string> {
  if (!webLink(path)) return systemPath(path);
  return systemPath(path, await openInPref().catch(() => 'corvus' as const));
}
