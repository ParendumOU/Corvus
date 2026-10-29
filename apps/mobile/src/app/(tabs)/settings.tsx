import Constants from 'expo-constants';
import { useEffect, useState } from 'react';
import { Platform, StyleSheet, Switch, View } from 'react-native';

import { Button } from '@/components/button';
import { Card, CardHeader, SectionHeader } from '@/components/card';
import { BrowserSettings } from '@/components/browser-settings';
import { DefaultBrowserSettings } from '@/components/default-browser-card';
import { LoadingState } from '@/components/empty-state';
import { Banner, confirm } from '@/components/feedback';
import { IconTile, ListGroup, ListRow } from '@/components/list';
import { Screen, ScreenTitle } from '@/components/screen';
import { ThemedText } from '@/components/themed-text';
import { Space } from '@/constants/theme';
import { refreshSession, unpairPhone, useSession } from '@/hooks/use-session';
import { useTheme } from '@/hooks/use-theme';
import { enableNotifications } from '@/lib/background';
import { ago, platformName } from '@/lib/format';
import { t } from '@/lib/i18n';
import { notificationsOn } from '@/lib/notifications';
import { nav } from '@/lib/nav';

const PHONES = new Set(['android', 'ios', 'web']);

export default function SettingsScreen() {
  const theme = useTheme();
  const session = useSession();
  const [busy, setBusy] = useState(false);
  const version = Constants.expoConfig?.version ?? '';
  const [notify, setNotify] = useState(false);
  const [notifyDenied, setNotifyDenied] = useState(false);
  useEffect(() => {
    void notificationsOn().then(setNotify);
  }, []);
  const toggleNotify = async (on: boolean): Promise<void> => {
    const enabled = await enableNotifications(on).catch(() => false);
    setNotify(enabled);
    setNotifyDenied(on && !enabled);
  };
  const unpair = async (): Promise<void> => {
    const ok = await confirm({
      title: t('Unpair this phone?'),
      message: t('It leaves the sync chain and forgets the recovery phrase. Your computer keeps all its data.'),
      confirmLabel: t('Unpair'),
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    await unpairPhone().finally(() => setBusy(false));
  };
  return (
    <Screen tab refreshing={session.refreshing} onRefresh={session.pairing ? () => void refreshSession() : undefined}>
      <ScreenTitle title={t('Settings')} />

      <View style={styles.section}>
        <SectionHeader title={t('Sync')} />
        {session.pairing ? (
          <Card testID="sync-card">
            <View style={styles.status}>
              <IconTile name="checkCircle" color={theme.success} background={theme.successSoft} />
              <View style={styles.grow}>
                <ThemedText type="heading">{t('Paired')}</ThemedText>
                <ThemedText type="small" themeColor="textSecondary">
                  {t('Paired as “{name}” with {server}.', { name: session.pairing.deviceName, server: session.pairing.serverUrl })}
                </ThemedText>
              </View>
            </View>
            <Button label={t('Unpair this phone')} kind="danger" icon="unlink" busy={busy} onPress={() => void unpair()} testID="settings-unpair" />
          </Card>
        ) : (
          <Card testID="sync-card">
            <CardHeader
              title={t('Not paired')}
              description={t('What the phone and your computer share is end-to-end encrypted: the sync server only stores ciphertext.')}
            />
            <Button label={t('Pair with a computer')} icon="scan" onPress={() => nav.push('/pair')} testID="settings-pair" />
          </Card>
        )}
      </View>

      {session.pairing && (
        <View style={styles.section}>
          <SectionHeader title={t('Devices on this sync chain')} />
          {session.devices.length === 0 ? (
            session.refreshed ? (
              <Banner tone="warning" message={t('Could not list them right now.')} />
            ) : (
              <LoadingState />
            )
          ) : (
            <ListGroup>
              {session.devices.map((d) => (
                <ListRow
                  key={d.id}
                  leading={<IconTile name={PHONES.has(d.platform) ? 'phone' : 'screen'} />}
                  title={`${d.name}${d.id === session.self ? ` ${t('(this phone)')}` : ''}`}
                  subtitle={`${platformName(d.platform)} · ${t('seen {when}', { when: ago(d.lastSeen) })}`}
                  wrap
                  testID={`device-${d.name}`}
                />
              ))}
            </ListGroup>
          )}
        </View>
      )}

      {session.pairing && Platform.OS !== 'web' && (
        <View style={styles.section}>
          <SectionHeader title={t('Notifications')} />
          <ListGroup testID="notify-card">
            <ListRow
              leading={<IconTile name="bell" />}
              title={t('Notifications')}
              subtitle={t('Pages your computer sends to this phone, and watched pages that change. The phone checks about every 15 minutes in the background, when the system allows it.')}
              wrap
              trailing={
                <View style={styles.switch}>
                  <Switch
                    value={notify}
                    onValueChange={(v) => void toggleNotify(v)}
                    accessibilityLabel={t('Notifications')}
                    trackColor={{ false: theme.borderStrong, true: theme.accent }}
                    thumbColor={notify ? theme.onAccent : theme.textSecondary}
                    ios_backgroundColor={theme.borderStrong}
                  />
                </View>
              }
            />
          </ListGroup>
          {notifyDenied && <Banner tone="warning" message={t('Notifications are blocked for Corvus: allow them in the system settings, then turn this on again.')} />}
        </View>
      )}

      <BrowserSettings />

      <DefaultBrowserSettings />

      <View style={styles.section}>
        <SectionHeader title={t('About')} />
        <ListGroup>
          <ListRow
            leading={<IconTile name="info" />}
            title={t('Version')}
            wrap
            trailing={
              <ThemedText type="body" themeColor="textSecondary" style={styles.value} testID="app-version" accessibilityLabel={t('Corvus for mobile {version}', { version })}>
                {version}
              </ThemedText>
            }
          />
          <ListRow
            leading={<IconTile name="book" />}
            title={t('Third-party licences')}
            subtitle={t('The open-source software in Corvus')}
            wrap
            chevron
            onPress={() => nav.push('/licenses')}
            testID="settings-licenses"
          />
        </ListGroup>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  section: {
    gap: Space.sm,
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
  switch: {
    paddingRight: Space.md,
  },
  value: {
    paddingRight: Space.lg,
  },
});
