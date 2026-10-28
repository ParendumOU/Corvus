import type { GroupColor, SyncedTab } from '@corvus/shared';
import { useEffect, useMemo, useState } from 'react';
import { Platform, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';

import { Button } from '@/components/button';
import { Card, CardHeader, SectionHeader } from '@/components/card';
import { DefaultBrowserOffer } from '@/components/default-browser-card';
import { EmptyState, LoadingState } from '@/components/empty-state';
import { Favicon } from '@/components/favicon';
import { Banner } from '@/components/feedback';
import { SearchField } from '@/components/fields';
import { CorvusMark, Icon } from '@/components/icon';
import { IconTile, ListGroup, ListHeader, ListRow } from '@/components/list';
import { Screen } from '@/components/screen';
import { ThemedText } from '@/components/themed-text';
import { Layout, Radius, Space } from '@/constants/theme';
import { cancelSending, openReceived, refreshSession, useSession } from '@/hooks/use-session';
import { useTheme } from '@/hooks/use-theme';
import { t } from '@/lib/i18n';
import { ago } from '@/lib/format';
import { showBrowser, startBrowsing } from '@/lib/browser-nav';
import { useBrowser } from '@/lib/browser-store';
import { openInApp, openInBrowser } from '@/lib/open-url';
import { filterTabs, tabHost, type ComputerTabs } from '@/lib/replica';
import { changedRecently } from '@/lib/watches';
import { nav } from '@/lib/nav';

const OUTBOX_REFRESH_MS = 10_000;

/** Tab group colors as the desktop draws them. */
const GROUP_HEX: Record<GroupColor, string> = {
  grey: '#80868B',
  blue: '#4C8DF6',
  red: '#E8574C',
  yellow: '#F9AB00',
  green: '#2E9E55',
  pink: '#E0408F',
  purple: '#A35BF0',
  cyan: '#00A3AD',
  orange: '#FA903E',
};

/**
 * Home's header: the Corvus mark and name on a band of the app icon's indigo that fades into the
 * page. Larger, with the tagline, before the phone is paired.
 */
function HeaderBand({ welcome }: { welcome: boolean }) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  // The gradient is drawn at the band's measured size (percent sizes do not resolve on Android).
  const [size, setSize] = useState({ width: 0, height: 0 });
  return (
    <View
      style={[styles.band, { paddingTop: insets.top + (welcome ? Space.xxxl : Space.md) }, welcome && styles.bandWelcome]}
      onLayout={(e) => {
        const { width, height } = e.nativeEvent.layout;
        setSize((s) => (s.width === width && s.height === height ? s : { width, height }));
      }}>
      {size.width > 0 && (
        <Svg style={StyleSheet.absoluteFill} width={size.width} height={size.height} pointerEvents="none">
          <Defs>
            <LinearGradient id="home-band" x1="0" y1="0" x2="0" y2={size.height} gradientUnits="userSpaceOnUse">
              <Stop offset="0" stopColor={theme.heroFrom} />
              <Stop offset="1" stopColor={theme.heroTo} />
            </LinearGradient>
          </Defs>
          <Rect x={0} y={0} width={size.width} height={size.height} fill="url(#home-band)" />
        </Svg>
      )}
      <View style={[styles.brand, welcome && styles.brandWelcome]}>
        <CorvusMark size={welcome ? 72 : 36} />
        <View style={welcome ? styles.center : undefined}>
          <ThemedText type={welcome ? 'display' : 'title'} style={styles.wordmark} testID="home-title" accessibilityRole="header">
            Corvus
          </ThemedText>
          {welcome && (
            <ThemedText type="body" themeColor="textSecondary" style={styles.centerText}>
              {t("Your computer's Corvus, in your pocket.")}
            </ThemedText>
          )}
        </View>
      </View>
    </View>
  );
}

/** Home's address bar: opens the browser with a new tab, ready to type an address or a search. */
function BrowseEntry() {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="search"
      accessibilityLabel={t('Search or type a web address')}
      onPress={startBrowsing}
      android_ripple={{ color: theme.ripple }}
      style={({ pressed }) => [styles.askEntry, { backgroundColor: theme.surface, borderColor: theme.borderStrong }, pressed && Platform.OS !== 'android' && { opacity: 0.85 }]}
      testID="home-browse">
      <Icon name="search" size={22} color={theme.textSecondary} />
      <ThemedText type="body" themeColor="textTertiary" numberOfLines={1} style={styles.shrink}>
        {t('Search or type a web address')}
      </ThemedText>
    </Pressable>
  );
}

/** Home's way into a new Assist conversation: looks like the chat's message box, opens it. */
function AskEntry() {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t('Ask Corvus')}
      onPress={() => nav.push({ pathname: '/chat/[id]', params: { id: 'new' } })}
      android_ripple={{ color: theme.accentSoft }}
      style={({ pressed }) => [styles.askEntry, { backgroundColor: theme.surface, borderColor: theme.borderStrong }, pressed && Platform.OS !== 'android' && { opacity: 0.85 }]}
      testID="home-ask">
      <Icon name="sparkle" size={22} color={theme.accentText} />
      <ThemedText type="body" themeColor="textTertiary" numberOfLines={1} style={styles.shrink}>
        {t('Ask Corvus')}
      </ThemedText>
      <View style={[styles.askSend, { backgroundColor: theme.accentSoft }]}>
        <Icon name="send" size={18} color={theme.accentText} />
      </View>
    </Pressable>
  );
}

function TabRow({ tab }: { tab: SyncedTab }) {
  return (
    <ListRow
      leading={<Favicon url={tab.url} />}
      title={tab.title || tab.url}
      subtitle={
        <View style={styles.meta}>
          <ThemedText type="small" themeColor="textSecondary" numberOfLines={1} style={styles.shrink}>
            {tab.pinned ? `${t('Pinned')} · ` : ''}
            {tab.group ? (
              <>
                <ThemedText type="small" style={{ color: GROUP_HEX[tab.group.color] }}>
                  {'● '}
                </ThemedText>
                {`${tab.group.title || t('Group')} · `}
              </>
            ) : null}
            {tabHost(tab.url)}
          </ThemedText>
        </View>
      }
      accessibilityRole="link"
      accessibilityHint={t('Opens the page. Long press to open it in your browser app.')}
      onPress={() => void openInApp(tab.url)}
      onLongPress={() => void openInBrowser(tab.url)}
      testID={`tab-${tab.url}`}
    />
  );
}

function ComputerCard({ computer }: { computer: ComputerTabs }) {
  return (
    <ListGroup
      testID={`computer-${computer.device}`}
      header={
        <ListHeader
          leading={<IconTile name="screen" />}
          title={computer.device}
          subtitle={`${computer.tabs.length === 1 ? t('1 tab') : t('{n} tabs', { n: computer.tabs.length })} · ${t('updated {when}', { when: ago(computer.updatedAt) })}`}
        />
      }>
      {computer.tabs.map((tab, i) => (
        <TabRow key={`${i}-${tab.url}`} tab={tab} />
      ))}
    </ListGroup>
  );
}

export default function HomeScreen() {
  const theme = useTheme();
  const session = useSession();
  const [query, setQuery] = useState('');
  const shown = useMemo(() => filterTabs(session.tabs, query), [session.tabs, query]);
  const deviceName = (id: string): string => session.devices.find((d) => d.id === id)?.name ?? t('your computer');
  const waiting = session.outbox.length > 0;
  const paired = session.status === 'paired';
  const changed = changedRecently(session.watches);
  const browser = useBrowser();
  const phoneTabs = browser.tabs.tabs.filter((x) => x.url !== '');

  // While a sent page waits, look every few seconds for its computer to have opened it.
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => void refreshSession(), OUTBOX_REFRESH_MS);
    return () => clearInterval(timer);
  }, [waiting]);

  return (
    <Screen tab header={<HeaderBand welcome={session.status === 'unpaired'} />} refreshing={session.refreshing} onRefresh={paired ? () => void refreshSession() : undefined} contentStyle={styles.column}>
      <BrowseEntry />

      {phoneTabs.length > 0 && (
        <ListGroup testID="phone-tabs">
          <ListRow
            leading={<IconTile name="tabs" />}
            title={phoneTabs.length === 1 ? t('1 tab open on this phone') : t('{n} tabs open on this phone', { n: phoneTabs.length })}
            subtitle={phoneTabs[phoneTabs.length - 1]?.title || tabHost(phoneTabs[phoneTabs.length - 1]?.url ?? '')}
            chevron
            onPress={showBrowser}
            testID="home-phone-tabs"
          />
        </ListGroup>
      )}

      {session.status === 'unpaired' && (
        <Card testID="pairing-card">
          <CardHeader title={t('Not paired with a computer yet')} description={t('Pair it once and your tabs, pages and library follow you here.')} />
          <View style={styles.steps}>
            {[t('On your computer, open Corvus Settings, then Sync.'), t('Choose “Pair a device”: a code appears.'), t('Scan the code with this phone.')].map((step, i) => (
              <View key={step} style={styles.step}>
                <View style={[styles.stepNumber, { backgroundColor: theme.accentContainer }]}>
                  <ThemedText type="label" style={{ color: theme.onAccentContainer }}>
                    {i + 1}
                  </ThemedText>
                </View>
                <ThemedText type="body" style={styles.stepText}>
                  {step}
                </ThemedText>
              </View>
            ))}
          </View>
          <Button label={t('Pair with a computer')} icon="scan" onPress={() => nav.push('/pair')} testID="home-pair" />
        </Card>
      )}

      {session.error && <Banner tone="error" message={session.error} testID="home-error" />}
      {session.unreachable && <Banner tone="info" icon="laptop" message={session.unreachable} testID="home-unreachable" />}

      {paired && session.inbox.length > 0 && (
        <View style={styles.section}>
          <SectionHeader title={t('Sent to this phone')} />
          <ListGroup testID="inbox">
            {session.inbox.map((page) => (
              <ListRow
                key={page.id}
                leading={<Favicon url={page.url} />}
                title={page.title || page.url}
                subtitle={`${t('From {device}', { device: page.from || t('your computer') })} · ${ago(page.sentAt)}`}
                accessibilityRole="link"
                onPress={() => void openReceived(page.id)}
                trailing={<View style={[styles.dot, { backgroundColor: theme.accent }]} />}
                testID={`inbox-${page.url}`}
              />
            ))}
          </ListGroup>
        </View>
      )}

      {paired && <AskEntry />}

      {paired && session.outbox.length > 0 && (
        <ListGroup testID="outbox">
          {session.outbox.map((page) => (
            <ListRow
              key={page.id}
              leading={<IconTile name="send" />}
              title={page.title || page.url}
              subtitle={t('Waiting for {computer} to open it · sent {when}', { computer: deviceName(page.to), when: ago(page.sentAt) })}
              trailing={<Button label={t('Cancel')} kind="text" size="sm" onPress={() => void cancelSending(page.id)} testID={`outbox-cancel-${page.url}`} />}
              testID={`outbox-${page.url}`}
            />
          ))}
        </ListGroup>
      )}

      {paired && (
        <ListGroup>
          <ListRow
            leading={<IconTile name="send" />}
            title={t('Send a page to your computer')}
            subtitle={t('It opens there on its next sync.')}
            chevron
            onPress={() => nav.push('/send')}
            testID="home-send"
          />
          <ListRow
            leading={<IconTile name="eye" />}
            title={t('Watched pages')}
            subtitle={
              session.watches.length === 0
                ? t('Watch a page for changes or for a price to drop.')
                : t('{n} watched · {changed} changed in the last day', { n: session.watches.length, changed })
            }
            subtitleLines={2}
            chevron
            onPress={() => nav.push('/watches')}
            badge={changed > 0 ? <View style={[styles.dot, styles.flush, { backgroundColor: theme.accent }]} /> : undefined}
            testID="home-watches"
          />
        </ListGroup>
      )}

      <DefaultBrowserOffer paired={paired} />

      {paired && (
        <View style={styles.section}>
          <SectionHeader title={t('Tabs from your computers')} />
          {session.tabs.length > 0 && <SearchField testID="tabs-filter" value={query} onChangeText={setQuery} placeholder={t('Find a tab')} />}
        </View>
      )}

      {paired && shown.map((computer) => <ComputerCard key={computer.deviceId} computer={computer} />)}

      {paired && session.tabs.length > 0 && shown.length === 0 && <EmptyState icon="search" description={t('No tab matches “{query}”.', { query: query.trim() })} compact />}

      {paired &&
        session.tabs.length === 0 &&
        (session.refreshed ? (
          <Card testID="tabs-empty">
            <EmptyState icon="screen" description={t('No open tabs from your computers yet. Corvus shares a computer’s open tabs while Sync is on there; pull down to refresh.')} compact />
          </Card>
        ) : (
          <LoadingState testID="tabs-empty" />
        ))}
    </Screen>
  );
}

const styles = StyleSheet.create({
  band: {
    paddingHorizontal: Layout.gutter + Space.xs,
    paddingBottom: Space.md,
  },
  bandWelcome: {
    paddingBottom: Space.xl,
  },
  brand: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.md,
    minHeight: 48,
  },
  brandWelcome: {
    flexDirection: 'column',
    gap: Space.lg,
  },
  wordmark: {
    letterSpacing: -0.3,
  },
  center: {
    alignItems: 'center',
    gap: Space.xs,
  },
  centerText: {
    textAlign: 'center',
  },
  column: {
    paddingTop: Space.sm,
  },
  section: {
    gap: Space.sm,
  },
  askEntry: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.md,
    minHeight: 56,
    paddingLeft: Space.lg,
    paddingRight: Space.sm,
    borderRadius: Radius.pill,
    borderWidth: 1,
    overflow: 'hidden',
  },
  askSend: {
    marginLeft: 'auto',
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  meta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.xs,
  },
  shrink: {
    flexShrink: 1,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginRight: Space.md,
  },
  flush: {
    marginRight: 0,
  },
  steps: {
    gap: Space.md,
  },
  step: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Space.md,
  },
  stepNumber: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepText: {
    flex: 1,
    paddingTop: 2,
  },
});
