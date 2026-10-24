import Constants from 'expo-constants';
import { router } from 'expo-router';
import { useState } from 'react';
import { Alert, Platform, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button } from '@/components/button';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { BottomTabInset, MaxContentWidth, Spacing } from '@/constants/theme';
import { refreshSession, unpairPhone, useSession } from '@/hooks/use-session';
import { ago } from '@/lib/format';

/** Asks before something that cannot be undone (a native alert, or the browser's on web). */
function confirmAction(title: string, message: string, action: string): Promise<boolean> {
  if (Platform.OS === 'web') return Promise.resolve(window.confirm(`${title}\n\n${message}`));
  return new Promise((resolve) =>
    Alert.alert(title, message, [
      { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
      { text: action, style: 'destructive', onPress: () => resolve(true) },
    ]),
  );
}

export default function SettingsScreen() {
  const session = useSession();
  const [busy, setBusy] = useState(false);
  const version = Constants.expoConfig?.version ?? '';
  const unpair = async (): Promise<void> => {
    const ok = await confirmAction(
      'Unpair this phone?',
      'It leaves the sync chain and forgets the recovery phrase. Your computer keeps all its data.',
      'Unpair',
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
          <ThemedText type="subtitle">Settings</ThemedText>

          <ThemedView type="backgroundElement" style={styles.card} testID="sync-card">
            <ThemedText type="smallBold">Sync</ThemedText>
            {session.pairing ? (
              <>
                <ThemedText type="small" themeColor="textSecondary">
                  Paired as “{session.pairing.deviceName}” with {session.pairing.serverUrl}.
                </ThemedText>
                <ThemedText type="smallBold" style={styles.subhead}>
                  Devices on this sync chain
                </ThemedText>
                {session.devices.length === 0 && (
                  <ThemedText type="small" themeColor="textSecondary">
                    {session.refreshed ? 'Could not list them right now.' : 'Loading…'}
                  </ThemedText>
                )}
                {session.devices.map((d) => (
                  <View key={d.id} testID={`device-${d.name}`}>
                    <ThemedText type="small">
                      {d.name}
                      {d.id === session.self ? ' (this phone)' : ''}
                    </ThemedText>
                    <ThemedText type="small" themeColor="textSecondary">
                      {d.platform} · seen {ago(d.lastSeen)}
                    </ThemedText>
                  </View>
                ))}
                <Button label="Unpair this phone" kind="danger" busy={busy} onPress={() => void unpair()} testID="settings-unpair" />
              </>
            ) : (
              <>
                <ThemedText type="small" themeColor="textSecondary">
                  Not paired. What the phone and your computer share is end-to-end encrypted: the sync server only stores ciphertext.
                </ThemedText>
                <Button label="Pair with a computer" onPress={() => router.push('/pair')} testID="settings-pair" />
              </>
            )}
          </ThemedView>

          <ThemedView type="backgroundElement" style={styles.card}>
            <ThemedText type="smallBold">About</ThemedText>
            <ThemedText type="small" themeColor="textSecondary" testID="app-version">
              Corvus for mobile {version}
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
});
