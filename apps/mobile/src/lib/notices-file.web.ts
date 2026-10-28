import type { Notices } from './notices';

/** The web build carries no notices: they ship with the Android app. */
export async function loadNotices(): Promise<Notices | null> {
  return null;
}
