import type { GroupColor, SyncedTab } from '@corvus/shared';
import { router } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button } from '@/components/button';
import { Favicon } from '@/components/favicon';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { BottomTabInset, MaxContentWidth, Spacing } from '@/constants/theme';
import { cancelSending, openReceived, refreshSession, useSession } from '@/hooks/use-session';
import { useTheme } from '@/hooks/use-theme';
import { t } from '@/lib/i18n';
import { ago } from '@/lib/format';
import { openInApp, openInBrowser } from '@/lib/open-url';
import { filterTabs, tabHost, type ComputerTabs } from '@/lib/replica';
import { changedRecently } from '@/lib/watches';

const OUTBOX_REFRESH_MS = 10_000;

/** Tab group colors as the desktop draws them. */
const GROUP_HEX: Record<GroupColor, string> = {
  grey: '#5F6368',
  blue: '#1A73E8',
  red: '#D93025',
  yellow: '#F9AB00',
  green: '#188038',
  pink: '#D01884',
  purple: '#A142F4',
  cyan: '#007B83',
  orange: '#FA903E',
};

function TabRow({ tab }: { tab: SyncedTab }) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityHint={t('Opens the page. Long press to open it in your browser app.')}
      onPress={() => void openInApp(tab.url)}
      onLongPress={() => void openInBrowser(tab.url)}
      style={({ pressed }) => [styles.tab, pressed && { backgroundColor: theme.backgroundSelected }]}
      testID={`tab-${tab.url}`}>
      <Favicon url={tab.url} />
      <View style={styles.tabText}>
        <ThemedText type="small" numberOfLines={1}>
          {tab.title || tab.url}
        </ThemedText>
        <ThemedText type="small" themeColor="textSecondary" numberOfLines={1}>
          {tab.pinned ? `${t('Pinned')} · ` : ''}
          {tab.group ? (
            <ThemedText type="small" style={{ color: GROUP_HEX[tab.group.color] }}>
              {tab.group.title || t('Group')} ·{' '}
            </ThemedText>
          ) : null}
          {tabHost(tab.url)}
        </ThemedText>
      </View>
    </Pressable>
  );
}

function ComputerCard({ computer }: { computer: ComputerTabs }) {
  return (
    <ThemedView type="backgroundElement" style={styles.card} testID={`computer-${computer.device}`}>
      <View>
        <ThemedText type="smallBold">{computer.device}</ThemedText>
        <ThemedText type="small" themeColor="textSecondary">
          {computer.tabs.length === 1 ? t('1 tab') : t('{n} tabs', { n: computer.tabs.length })} · {t('updated {when}', { when: ago(computer.updatedAt) })}
        </ThemedText>
      </View>
      {computer.tabs.map((tab, i) => (
        <TabRow key={`${i}-${tab.url}`} tab={tab} />
      ))}
    </ThemedView>
  );
}

export default function HomeScreen() {
  const theme = useTheme();
  const session = useSession();
  const [query, setQuery] = useState('');
  const shown = useMemo(() => filterTabs(session.tabs, query), [session.tabs, query]);
  const deviceName = (id: string): string => session.devices.find((d) => d.id === id)?.name ?? t('your computer');
  const waiting = session.outbox.length > 0;

  // While a sent page waits, look every few seconds for its computer to have opened it.
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => void refreshSession(), OUTBOX_REFRESH_MS);
    return () => clearInterval(timer);
  }, [waiting]);
  return (
    <ThemedView style={styles.container}>
      <SafeAreaView style={styles.safeArea}>
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          refreshControl={
            session.status === 'paired' ? <RefreshControl refreshing={session.refreshing} onRefresh={() => void refreshSession()} /> : undefined
          }>
          <ThemedView style={styles.hero}>
            <ThemedText type="title" testID="home-title">
              Corvus
            </ThemedText>
            <ThemedText themeColor="textSecondary">
              {session.status === 'paired' ? t('Tabs from your computers') : t("Your computer's Corvus, in your pocket.")}
            </ThemedText>
          </ThemedView>

          {session.status === 'unpaired' && (
            <ThemedView type="backgroundElement" style={styles.card} testID="pairing-card">
              <ThemedText type="smallBold">{t('Not paired with a computer yet')}</ThemedText>
              <ThemedText type="small" themeColor="textSecondary">
                {t('On your computer, open Corvus Settings, then Sync, and choose “Pair a phone”. Then scan the code here.')}
              </ThemedText>
              <Button label={t('Pair with a computer')} onPress={() => router.push('/pair')} testID="home-pair" />
            </ThemedView>
          )}

          {session.status === 'paired' && session.inbox.length > 0 && (
            <ThemedView type="backgroundElement" style={styles.card} testID="inbox">
              <ThemedText type="smallBold">{t('Sent to this phone')}</ThemedText>
              {session.inbox.map((page) => (
                <Pressable
                  key={page.id}
                  accessibilityRole="link"
                  onPress={() => void openReceived(page.id)}
                  style={({ pressed }) => [styles.tab, pressed && { backgroundColor: theme.backgroundSelected }]}
                  testID={`inbox-${page.url}`}>
                  <Favicon url={page.url} />
                  <View style={styles.tabText}>
                    <ThemedText type="small" numberOfLines={1}>
                      {page.title || page.url}
                    </ThemedText>
                    <ThemedText type="small" themeColor="textSecondary" numberOfLines={1}>
                      {t('From {device}', { device: page.from || t('your computer') })} · {ago(page.sentAt)}
                    </ThemedText>
                  </View>
                </Pressable>
              ))}
            </ThemedView>
          )}

          {session.status === 'paired' && (
            <ThemedView type="backgroundElement" style={styles.card} testID="outbox">
              <Button label={t('Ask Corvus')} onPress={() => router.push('/ask')} testID="home-ask" />
              <Button label={t('Send a page to your computer')} kind="secondary" onPress={() => router.push('/send')} testID="home-send" />
              {session.outbox.map((page) => (
                <View key={page.id} style={styles.pending} testID={`outbox-${page.url}`}>
                  <View style={styles.tabText}>
                    <ThemedText type="small" numberOfLines={1}>
                      {page.title || page.url}
                    </ThemedText>
                    <ThemedText type="small" themeColor="textSecondary" numberOfLines={1}>
                      {t('Waiting for {computer} to open it · sent {when}', { computer: deviceName(page.to), when: ago(page.sentAt) })}
                    </ThemedText>
                  </View>
                  <Pressable accessibilityRole="button" onPress={() => void cancelSending(page.id)} hitSlop={8} testID={`outbox-cancel-${page.url}`}>
                    <ThemedText type="smallBold" themeColor="textSecondary">
                      {t('Cancel')}
                    </ThemedText>
                  </Pressable>
                </View>
              ))}
            </ThemedView>
          )}

          {session.status === 'paired' && (
            <Pressable accessibilityRole="button" onPress={() => router.push('/watches')} testID="home-watches">
              <ThemedView type="backgroundElement" style={[styles.card, styles.watchCard]}>
                <View style={styles.tabText}>
                  <ThemedText type="smallBold">{t('Watched pages')}</ThemedText>
                  <ThemedText type="small" themeColor="textSecondary">
                    {session.watches.length === 0
                      ? t('Watch a page for changes or for a price to drop.')
                      : t('{n} watched · {changed} changed in the last day', { n: session.watches.length, changed: changedRecently(session.watches) })}
                  </ThemedText>
                </View>
                <ThemedText type="smallBold" themeColor="textSecondary">
                  ›
                </ThemedText>
              </ThemedView>
            </Pressable>
          )}

          {session.status === 'paired' && session.tabs.length > 0 && (
            <TextInput
              testID="tabs-filter"
              style={[styles.filter, { color: theme.text, backgroundColor: theme.backgroundElement }]}
              value={query}
              onChangeText={setQuery}
              placeholder={t('Find a tab')}
              placeholderTextColor={theme.textSecondary}
              autoCapitalize="none"
              autoCorrect={false}
              clearButtonMode="while-editing"
            />
          )}

          {session.status === 'paired' && shown.map((computer) => <ComputerCard key={computer.deviceId} computer={computer} />)}

          {session.status === 'paired' && session.tabs.length > 0 && shown.length === 0 && (
            <ThemedText type="small" themeColor="textSecondary" style={styles.center}>
              {t('No tab matches “{query}”.', { query: query.trim() })}
            </ThemedText>
          )}

          {session.status === 'paired' && session.tabs.length === 0 && (
            <ThemedView type="backgroundElement" style={styles.card} testID="tabs-empty">
              <ThemedText type="small" themeColor="textSecondary">
                {session.refreshed
                  ? t('No open tabs from your computers yet. Corvus shares a computer’s open tabs while Sync is on there; pull down to refresh.')
                  : t('Loading…')}
              </ThemedText>
            </ThemedView>
          )}

          {session.error && (
            <ThemedText type="small" style={styles.error} testID="home-error">
              {session.error}
            </ThemedText>
          )}
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
  hero: {
    alignItems: 'center',
    gap: Spacing.two,
    paddingVertical: Spacing.four,
  },
  card: {
    gap: Spacing.one,
    padding: Spacing.three,
    borderRadius: Spacing.four,
  },
  tab: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    paddingVertical: Spacing.two,
    paddingHorizontal: Spacing.one,
    borderRadius: Spacing.two,
  },
  tabText: {
    flex: 1,
  },
  watchCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
  },
  pending: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    paddingTop: Spacing.two,
  },
  filter: {
    minHeight: 44,
    paddingHorizontal: Spacing.three,
    borderRadius: Spacing.three,
    fontSize: 16,
  },
  center: {
    textAlign: 'center',
  },
  error: {
    color: '#D93025',
  },
});
