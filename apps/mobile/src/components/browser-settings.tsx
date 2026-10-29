import { Platform, StyleSheet, Switch, View } from 'react-native';

import { Button, IconButton } from '@/components/button';
import { SectionHeader } from '@/components/card';
import { confirm, showToast } from '@/components/feedback';
import { IconTile, ListGroup, ListRow, RadioMark } from '@/components/list';
import { ThemedText } from '@/components/themed-text';
import { Space } from '@/constants/theme';
import { useSession } from '@/hooks/use-session';
import { useTheme } from '@/hooks/use-theme';
import { SEARCH_ENGINES, pickEngine } from '@/lib/address';
import { LIST_REFRESH_MS } from '@/lib/blocklist';
import { allowCookieBanner, allowSite, clearLocalHistory, setBrowserPrefs, useBrowser } from '@/lib/browser-store';
import { refreshLists, useBlockingStatus } from '@/lib/content-blocking';
import { ago } from '@/lib/format';
import { t } from '@/lib/i18n';
import { BrowserKit, ConsentKit } from '../../modules/browser-kit';

function PrefSwitch({ value, onChange, label }: { value: boolean; onChange: (on: boolean) => void; label: string }) {
  const theme = useTheme();
  return (
    <View style={styles.switch}>
      <Switch
        value={value}
        onValueChange={onChange}
        accessibilityLabel={label}
        trackColor={{ false: theme.borderStrong, true: theme.accent }}
        thumbColor={value ? theme.onAccent : theme.textSecondary}
        ios_backgroundColor={theme.borderStrong}
      />
    </View>
  );
}

/**
 * Settings → Browser: the search engine, ad and tracker blocking, cookie banners and Global Privacy
 * Control, and forgetting what sites stored.
 */
export function BrowserSettings() {
  const theme = useTheme();
  const browser = useBrowser();
  const session = useSession();
  const blocking = useBlockingStatus();
  const engine = pickEngine(browser.prefs.engine, session.homePage);
  const fromComputers = browser.prefs.engine === null && engine !== 'duckduckgo';

  const clear = async (): Promise<void> => {
    const ok = await confirm({
      title: t('Clear cookies and site data?'),
      message: t('Every site forgets this phone: you are signed out of them, and their stored data and cached files go. Tabs, history and bookmarks stay.'),
      confirmLabel: t('Clear'),
      destructive: true,
    });
    if (!ok) return;
    await BrowserKit?.clearBrowsingData().catch(() => false);
    await clearLocalHistory();
    showToast(t('Cookies and site data cleared'));
  };

  const listsLine = blocking.updating
    ? t('Downloading the filter lists…')
    : blocking.updatedAt
      ? t('{n} rules from the lists your computers use, updated {when}.', { n: blocking.rules.toLocaleString(), when: ago(blocking.updatedAt) })
      : t('The built-in list blocks the best-known ad and tracker hosts until the full lists download.');

  return (
    <View style={styles.section}>
      <SectionHeader title={t('Browser')} />
      <ListGroup inset={Space.lg} testID="browser-settings-engine">
        {SEARCH_ENGINES.map((e) => {
          const chosen = e.id === engine;
          return (
            <ListRow
              key={e.id}
              title={e.name}
              wrap
              subtitle={chosen && fromComputers ? t('As on your computers') : e.id === 'duckduckgo' ? t('Default: does not track your searches') : undefined}
              accessibilityRole="radio"
              accessibilityState={{ checked: chosen }}
              onPress={() => void setBrowserPrefs({ engine: e.id })}
              trailing={<RadioMark checked={chosen} />}
              testID={`engine-${e.id}`}
            />
          );
        })}
      </ListGroup>
      <ThemedText type="small" themeColor="textSecondary" style={styles.note}>
        {t('The address bar searches with it. What you type is not sent anywhere until you search.')}
      </ThemedText>

      {blocking.supported ? (
        <ListGroup testID="browser-settings-blocking">
          <ListRow
            leading={<IconTile name="shield" />}
            title={t('Block ads and trackers')}
            subtitle={listsLine}
            wrap
            trailing={
              <PrefSwitch
                value={browser.prefs.blocking}
                onChange={(on) => {
                  void setBrowserPrefs({ blocking: on });
                  // Turned on with lists never downloaded, or a week old: fetch them now.
                  if (on && (!blocking.updatedAt || Date.now() - blocking.updatedAt > LIST_REFRESH_MS)) void refreshLists();
                }}
                label={t('Block ads and trackers')}
              />
            }
            testID="blocking-switch"
          />
          {browser.prefs.allowedSites.map((site) => (
            <ListRow
              key={site}
              leading={<IconTile name="shieldOff" />}
              title={site}
              subtitle={t('Blocking off on this site')}
              wrap
              trailing={<IconButton icon="close" size={18} accessibilityLabel={t('Block on this site again')} onPress={() => void allowSite(site, false)} />}
              testID={`allowed-${site}`}
            />
          ))}
        </ListGroup>
      ) : null}
      {blocking.supported && browser.prefs.blocking ? (
        <View style={styles.actions}>
          <Button label={t('Update the lists now')} kind="text" size="sm" icon="refresh" busy={blocking.updating} onPress={() => void refreshLists()} testID="blocking-update" />
          {blocking.error ? <ThemedText type="small" style={{ color: theme.danger }}>{t('The lists could not be downloaded: {error}', { error: blocking.error })}</ThemedText> : null}
        </View>
      ) : null}

      {Platform.OS !== 'web' ? (
        <ListGroup testID="browser-settings-privacy">
          {ConsentKit ? (
            <ListRow
              leading={<IconTile name="cookie" />}
              title={t('Reject cookie banners')}
              subtitle={t('Answers cookie consent banners for you with DuckDuckGo’s Autoconsent rules: rejects everything, or unticks every purpose and saves. A banner it cannot answer is hidden.')}
              wrap
              trailing={<PrefSwitch value={browser.prefs.cookieConsent} onChange={(on) => void setBrowserPrefs({ cookieConsent: on })} label={t('Reject cookie banners')} />}
              testID="consent-switch"
            />
          ) : null}
          {ConsentKit && browser.prefs.cookieConsent
            ? browser.prefs.consentAllowedSites.map((site) => (
                <ListRow
                  key={site}
                  leading={<IconTile name="cookie" />}
                  title={site}
                  subtitle={t('Keeps its cookie banner')}
                  wrap
                  trailing={<IconButton icon="close" size={18} accessibilityLabel={t('Reject its cookie banner again')} onPress={() => void allowCookieBanner(site, false)} />}
                  testID={`consent-allowed-${site}`}
                />
              ))
            : null}
          <ListRow
            leading={<IconTile name="shieldCheck" />}
            title={t('Send Global Privacy Control')}
            subtitle={t('Tells sites not to sell or share your data. In some places, such as California, sites must honour it.')}
            wrap
            trailing={<PrefSwitch value={browser.prefs.gpc} onChange={(on) => void setBrowserPrefs({ gpc: on })} label={t('Send Global Privacy Control')} />}
            testID="gpc-switch"
          />
        </ListGroup>
      ) : null}

      {Platform.OS !== 'web' ? (
        <ListGroup>
          <ListRow leading={<IconTile name="trash" />} title={t('Clear cookies and site data')} subtitle={t('Signs you out of every site')} wrap onPress={() => void clear()} testID="browser-clear-data" />
        </ListGroup>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    gap: Space.sm,
  },
  note: {
    paddingHorizontal: Space.lg,
  },
  switch: {
    paddingRight: Space.md,
  },
  actions: {
    alignItems: 'flex-start',
    gap: Space.xs,
    paddingHorizontal: Space.xs,
  },
});
