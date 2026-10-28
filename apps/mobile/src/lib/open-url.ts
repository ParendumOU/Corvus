/**
 * Every web page the app opens goes through here. Pages open in Corvus's own browser (Android and
 * iOS), unless the person opens pages in another browser app (Settings → Open pages in). While Corvus
 * is the phone's default browser (Android), a page handed to the system would come straight back to
 * Corvus, so a page for another browser goes to the one picked in Settings by its package instead.
 */
import * as WebBrowser from 'expo-web-browser';
import { Alert, Linking, Platform } from 'react-native';

import { DefaultBrowser } from '../../modules/default-browser';
import { openInCorvus } from './browser-nav';
import { browserState, loadBrowser } from './browser-store';
import { openRoute, type OpenRoute } from './browser-choice';
import { defaultBrowserState } from './default-browser';
import { t } from './i18n';

/** How a page leaves the app now; `incoming` for a link Corvus was asked to open as the browser. */
async function route(incoming: boolean): Promise<OpenRoute> {
  if (Platform.OS !== 'android') return openRoute(Platform.OS, false, null);
  const now = await defaultBrowserState();
  // A page opened from the app asks the system whether Corvus is the default right now.
  const isDefault = incoming || (await DefaultBrowser?.getStatusAsync().then((s) => s.isDefault, () => now.isDefault)) || false;
  return openRoute(Platform.OS, isDefault, now.browser);
}

function noBrowser(): void {
  Alert.alert(t('No browser app'), t('Corvus opens pages in another browser app. Install one, then pick it in Settings → Default browser.'));
}

/**
 * Opens a page in the app: Corvus's browser, or with "Open pages in" set to another browser app, that
 * browser's in-app view (Custom Tabs on Android, Safari View Controller on iOS).
 */
export async function openInApp(url: string): Promise<void> {
  if (Platform.OS !== 'web') {
    await loadBrowser().catch(() => undefined);
    if (browserState().prefs.openIn === 'corvus') {
      openInCorvus(url);
      return;
    }
  }
  const how = await route(false);
  if (how.via === 'window') {
    window.open(url, '_blank', 'noopener,noreferrer');
  } else if (how.via === 'system') {
    await WebBrowser.openBrowserAsync(url);
  } else if (how.via === 'package') {
    // Custom Tabs of that browser; one without Custom Tabs gets the page as a plain link.
    await WebBrowser.openBrowserAsync(url, { browserPackage: how.packageName }).catch(() => DefaultBrowser?.openUrlAsync(url, how.packageName, false));
  } else {
    noBrowser();
  }
}

/** Opens a page in the phone's browser app. */
export async function openInBrowser(url: string): Promise<void> {
  const how = await route(false);
  if (how.via === 'window') window.open(url, '_blank', 'noopener,noreferrer');
  else if (how.via === 'system') await Linking.openURL(url);
  else if (how.via === 'package') await DefaultBrowser?.openUrlAsync(url, how.packageName, false);
  else noBrowser();
}

/**
 * Opens a link Corvus was asked to open as the browser, in the browser app picked in Settings (never
 * the system's pick, which could be Corvus again), then steps back so that going back from the
 * browser returns to the app the link came from. Returns whether it opened.
 */
export async function openIncoming(url: string): Promise<boolean> {
  const how = await route(true);
  if (how.via === 'window') {
    window.open(url, '_blank', 'noopener,noreferrer');
    return true;
  }
  if (how.via === 'system') {
    await Linking.openURL(url);
    return true;
  }
  if (how.via === 'package' && DefaultBrowser) {
    await DefaultBrowser.openUrlAsync(url, how.packageName, true);
    return true;
  }
  noBrowser();
  return false;
}
