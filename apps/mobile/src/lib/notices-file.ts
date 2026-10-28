import { File } from 'expo-file-system';

import { isNotices, type Notices } from './notices';

/** The notices a release build carries in its assets (scripts/third-party-notices.mjs), or null (a development build). */
export async function loadNotices(): Promise<Notices | null> {
  try {
    const file = new File('asset:///third-party-notices.json');
    const value: unknown = JSON.parse(await file.text());
    return isNotices(value) ? value : null;
  } catch {
    return null;
  }
}
