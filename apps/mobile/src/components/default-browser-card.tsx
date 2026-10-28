import { useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';

import { Button, IconButton } from '@/components/button';
import { Card, SectionHeader } from '@/components/card';
import { Banner } from '@/components/feedback';
import { IconTile, ListGroup, ListRow, RadioMark } from '@/components/list';
import { ThemedText } from '@/components/themed-text';
import { Space } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { offerDefaultBrowser } from '@/lib/browser-choice';
import { setBrowserPrefs, useBrowser } from '@/lib/browser-store';
import {
  chooseBrowser,
  dismissDefaultBrowserOffer,
  openDefaultAppsSettings,
  requestDefaultBrowser,
  useDefaultBrowser,
} from '@/lib/default-browser';
import { t } from '@/lib/i18n';

/** Shows the system's dialog; true when the person closed it without choosing Corvus. */
async function askToBeDefault(): Promise<boolean> {
  const result = await requestDefaultBrowser().catch(() => 'unavailable' as const);
  return result === 'dismissed' || result === 'unavailable';
}

/** Settings → Default browser (Android): whether Corvus is, the system dialog, and the browser that opens pages. */
export function DefaultBrowserSettings() {
  const theme = useTheme();
  const state = useDefaultBrowser();
  const browser = useBrowser();
  const [busy, setBusy] = useState(false);
  const [declined, setDeclined] = useState(false);
  if (!state.supported) return null;
  const inCorvus = browser.prefs.openIn === 'corvus';

  const ask = async (): Promise<void> => {
    setBusy(true);
    setDeclined(await askToBeDefault().finally(() => setBusy(false)));
  };

  return (
    <>
      <View style={styles.section}>
        <SectionHeader title={t('Default browser')} />
        <Card testID="default-browser-card">
          <View style={styles.status}>
            <IconTile
              name={state.isDefault ? 'checkCircle' : 'globe'}
              color={state.isDefault ? theme.success : undefined}
              background={state.isDefault ? theme.successSoft : undefined}
            />
            <View style={styles.grow}>
              <ThemedText type="heading">{state.isDefault ? t('Corvus is your default browser') : t('Corvus is not your default browser')}</ThemedText>
              <ThemedText type="small" themeColor="textSecondary">
                {inCorvus ? t('As your default browser, Corvus opens the links of every app itself, with ads and trackers blocked.') : t('As your default browser, Corvus opens each link in the browser below, and lets you send it to a computer or save it first.')}
              </ThemedText>
            </View>
          </View>
          {!state.isDefault && (
            <Button label={t('Set as default browser')} busy={busy} disabled={!state.loaded} onPress={() => void ask()} testID="default-browser-set" />
          )}
          {declined && !state.isDefault && <Banner message={t('You can also choose it in the system settings, under Default apps → Browser app.')} />}
          {(state.isDefault || declined) && (
            <Button label={t('Open default apps settings')} kind="outline" icon="settings" onPress={() => void openDefaultAppsSettings()} testID="default-browser-system" />
          )}
        </Card>
      </View>

      <View style={styles.section}>
        <SectionHeader title={t('Open pages in')} />
        <ListGroup inset={Space.lg}>
          <ListRow
            title={t('Corvus')}
            subtitle={t('Its own browser, with your tabs, history and bookmarks synced')}
            accessibilityRole="radio"
            accessibilityState={{ checked: inCorvus }}
            onPress={() => void setBrowserPrefs({ openIn: 'corvus' })}
            trailing={<RadioMark checked={inCorvus} />}
            testID="browser-corvus"
          />
          {state.browsers.map((b) => {
            const chosen = !inCorvus && b.packageName === state.browser?.packageName;
              return (
                <ListRow
                  key={b.packageName}
                  title={b.label}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: chosen }}
                  onPress={() => {
                    void chooseBrowser(b.packageName);
                    void setBrowserPrefs({ openIn: 'other' });
                  }}
                  trailing={<RadioMark checked={chosen} />}
                  testID={`browser-${b.packageName}`}
                />
              );
            })}
        </ListGroup>
        {inCorvus && state.browser ? (
          <ThemedText type="small" themeColor="textSecondary" style={styles.note}>
            {t('“Open in…” in the page menu hands a page to {browser}.', { browser: state.browser.label })}
          </ThemedText>
        ) : null}
      </View>
    </>
  );
}

/** Home's one-time offer to make Corvus the default browser (Android, paired); "Not now" hides it for good. */
export function DefaultBrowserOffer({ paired }: { paired: boolean }) {
  const state = useDefaultBrowser();
  const [busy, setBusy] = useState(false);
  const show = offerDefaultBrowser({ platform: Platform.OS, paired, canAsk: state.supported && state.loaded, isDefault: state.isDefault, dismissed: state.offerDismissed });
  if (!show) return null;

  const ask = async (): Promise<void> => {
    setBusy(true);
    await askToBeDefault().finally(() => setBusy(false));
  };

  return (
    <Card testID="default-browser-offer">
      <View style={styles.offerHead}>
        <IconTile name="globe" />
        <View style={styles.grow}>
          <ThemedText type="heading">{t('Make Corvus your default browser')}</ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            {t('Links you open on this phone open in Corvus, with ads and trackers blocked, and you can send them to a computer or save them.')}
          </ThemedText>
        </View>
        <View style={styles.dismiss}>
          <IconButton icon="close" size={20} accessibilityLabel={t('Not now')} disabled={busy} onPress={() => void dismissDefaultBrowserOffer()} testID="default-browser-offer-dismiss" />
        </View>
      </View>
      <Button label={t('Set as default browser')} kind="tonal" busy={busy} onPress={() => void ask()} testID="default-browser-offer-set" />
    </Card>
  );
}

const styles = StyleSheet.create({
  section: {
    gap: Space.sm,
  },
  note: {
    paddingHorizontal: Space.lg,
  },
  status: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Space.lg,
  },
  grow: {
    flex: 1,
    gap: 2,
  },
  offerHead: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Space.md,
  },
  dismiss: {
    marginTop: -Space.md,
    marginRight: -Space.md,
  },
});
