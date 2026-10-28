/**
 * Links from a page to another app (intent:, market:, tel:, mailto:…): they never open by
 * themselves. The person is asked first; on Android the link then goes through the native module,
 * which opens only another app's browsable activity, or loads the link's own web fallback in the tab.
 */
import { Linking, Platform } from 'react-native';

import { confirm, showToast } from '@/components/feedback';
import { BrowserKit } from '../../modules/browser-kit';
import { loadInTab } from './browser-store';
import { t } from './i18n';

/** What the link opens, in a few words. */
export function describeLink(url: string): string {
  const scheme = (/^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1] ?? '').toLowerCase();
  const rest = url.slice(scheme.length + 1).replace(/^\/\//, '');
  if (scheme === 'tel') return t('a call to {number}', { number: decodeURIComponent(rest.split('?')[0] ?? '') });
  if (scheme === 'mailto') return t('an email to {address}', { address: decodeURIComponent(rest.split('?')[0] ?? '') });
  if (scheme === 'sms' || scheme === 'smsto') return t('a text message');
  if (scheme === 'market') return t('Google Play');
  if (scheme === 'geo') return t('a map');
  const pkg = /;package=([\w.]+)/.exec(url)?.[1];
  return pkg ? t('the app {app}', { app: pkg }) : t('another app');
}

let asking = false;

/** Asks before opening a page's link to another app; `tabId` gets its web fallback, if it has one. */
export async function offerExternalLink(url: string, tabId: string | null): Promise<void> {
  if (asking) return;
  asking = true;
  try {
    const ok = await confirm({
      title: t('Open another app?'),
      message: t('This page wants to open {what}.', { what: describeLink(url) }),
      confirmLabel: t('Open'),
    });
    if (!ok) return;
    if (Platform.OS === 'android' && BrowserKit) {
      const result = await BrowserKit.openExternal(url);
      if (result.startsWith('web:') && tabId) loadInTab(tabId, result.slice(4));
      else if (result === 'none') showToast(t('No app on this phone opens this link.'), 'warning');
      return;
    }
    await Linking.openURL(url).catch(() => showToast(t('No app on this phone opens this link.'), 'warning'));
  } finally {
    asking = false;
  }
}
