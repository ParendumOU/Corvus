import { systemPath } from '@/lib/links';

/**
 * A link shared to Corvus from another app (Android share sheet) opens the Send screen; a web link
 * Corvus is asked to open as the phone's browser opens the Open screen.
 */
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  return systemPath(path);
}
