import Constants from 'expo-constants';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, Platform, RefreshControl, ScrollView, StyleSheet, Switch, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button } from '@/components/button';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { BottomTabInset, MaxContentWidth, Spacing } from '@/constants/theme';
import { refreshSession, unpairPhone, useSession } from '@/hooks/use-session';
import { enableNotifications } from '@/lib/background';
import { ago } from '@/lib/format';
import { t } from '@/lib/i18n';
import { notificationsOn } from '@/lib/notifications';

/** Asks before something that cannot be undone (a native alert, or the browser's on web). */
function confirmAction(title: string, message: string, action: string): Promise<boolean> {
  if (Platform.OS === 'web') return Promise.resolve(window.confirm(`${title}\n\n${message}`));
  return new Promise((resolve) =>
    Alert.alert(title, message, [
      { text: t('Cancel'), style: 'cancel', onPress: () => resolve(false) },
      { text: action, style: 'destructive', onPress: () => resolve(true) },
    ]),
  );
}

export default function SettingsScreen() {
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
    const ok = await confirmAction(
      t('Unpair this phone?'),
      t('It leaves the sync chain and forgets the recovery phrase. Your computer keeps all its data.'),
      t('Unpair'),
    );
    if (!ok) return;
    setBusy(true);
    await unpairPhone().finally(() => setBusy(false));
  };
  return (
    <ThemedView style={styles.container}>
      <SafeAreaView style={styles.safeArea}>
        <ScrollView
          contentContainerStyle={styles.content}
          refreshControl={
            session.pairing ? <RefreshControl refreshing={session.refreshing} onRefresh={() => void refreshSession()} /> : undefined
          }>
          <ThemedText type="subtitle">{t('Settings')}</ThemedText>

          <ThemedView type="backgroundElement" style={styles.card} testID="sync-card">
            <ThemedText type="smallBold">{t('Sync')}</ThemedText>
            {session.pairing ? (
              <>
                <ThemedText type="small" themeColor="textSecondary">
                  {t('Paired as “{name}” with {server}.', { name: session.pairing.deviceName, server: session.pairing.serverUrl })}
                </ThemedText>
                <ThemedText type="smallBold" style={styles.subhead}>
                  {t('Devices on this sync chain')}
                </ThemedText>
                {session.devices.length === 0 && (
                  <ThemedText type="small" themeColor="textSecondary">
                    {session.refreshed ? t('Could not list them right now.') : t('Loading…')}
                  </ThemedText>
                )}
                {session.devices.map((d) => (
                  <View key={d.id} testID={`device-${d.name}`}>
                    <ThemedText type="small">
                      {d.name}
                      {d.id === session.self ? ` ${t('(this phone)')}` : ''}
                    </ThemedText>
                    <ThemedText type="small" themeColor="textSecondary">
                      {d.platform} · {t('seen {when}', { when: ago(d.lastSeen) })}
                    </ThemedText>
                  </View>
                ))}
                <Button label={t('Unpair this phone')} kind="danger" busy={busy} onPress={() => void unpair()} testID="settings-unpair" />
              </>
            ) : (
              <>
                <ThemedText type="small" themeColor="textSecondary">
                  {t('Not paired. What the phone and your computer share is end-to-end encrypted: the sync server only stores ciphertext.')}
                </ThemedText>
                <Button label={t('Pair with a computer')} onPress={() => router.push('/pair')} testID="settings-pair" />
              </>
            )}
          </ThemedView>

          {session.pairing && Platform.OS !== 'web' && (
            <ThemedView type="backgroundElement" style={styles.card} testID="notify-card">
              <View style={styles.row}>
                <ThemedText type="smallBold" style={styles.grow}>
                  {t('Notifications')}
                </ThemedText>
                <Switch value={notify} onValueChange={(v) => void toggleNotify(v)} accessibilityLabel={t('Notifications')} />
              </View>
              <ThemedText type="small" themeColor="textSecondary">
                {t('Pages your computer sends to this phone, and watched pages that change. The phone checks about every 15 minutes in the background, when the system allows it.')}
              </ThemedText>
              {notifyDenied && (
                <ThemedText type="small" themeColor="textSecondary">
                  {t('Notifications are blocked for Corvus: allow them in the system settings, then turn this on again.')}
                </ThemedText>
              )}
            </ThemedView>
          )}

          <ThemedView type="backgroundElement" style={styles.card}>
            <ThemedText type="smallBold">{t('About')}</ThemedText>
            <ThemedText type="small" themeColor="textSecondary" testID="app-version">
              {t('Corvus for mobile {version}', { version })}
            </ThemedText>
          </ThemedView>
        </ScrollView>
      </SafeAreaView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    flexDirection: 'row',
    justifyContent: 'center',
  },
  safeArea: {
    flex: 1,
    maxWidth: MaxContentWidth,
  },
  content: {
    padding: Spacing.four,
    paddingBottom: BottomTabInset + Spacing.four,
    gap: Spacing.three,
  },
  card: {
    gap: Spacing.two,
    padding: Spacing.four,
    borderRadius: Spacing.four,
  },
  subhead: {
    marginTop: Spacing.two,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  grow: {
    flex: 1,
  },
});
