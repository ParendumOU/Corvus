/** Opening pages in Corvus's own browser from anywhere in the app. */
import { router } from 'expo-router';

import { openTab } from './browser-store';

/** Opens a page in a new tab of Corvus's browser and shows it. */
export function openInCorvus(url: string): void {
  openTab(url);
  router.push('/browser');
}

/** Shows the browser with a new tab, ready to type an address or a search. */
export function startBrowsing(): void {
  router.push({ pathname: '/browser', params: { edit: '1' } });
}

/** Shows the browser on the tab that was on screen last. */
export function showBrowser(): void {
  router.push('/browser');
}
