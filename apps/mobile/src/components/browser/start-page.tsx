import { BAR_FOLDER_ID, type Bookmark, type SyncedHistoryEntry } from '@corvus/shared';
import { useMemo } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { SectionHeader } from '@/components/card';
import { Favicon } from '@/components/favicon';
import { Icon, type IconName } from '@/components/icon';
import { ListGroup, ListRow } from '@/components/list';
import { ThemedText } from '@/components/themed-text';
import { Layout, Radius, Space } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { classifyAddress, displayAddress, type SearchEngine } from '@/lib/address';
import { t } from '@/lib/i18n';
import { tabHost } from '@/lib/replica';
import { suggest, type Suggestion } from '@/lib/suggest';

const KIND_ICON: Record<Suggestion['kind'], IconName> = { tab: 'tabs', bookmark: 'star', history: 'history' };

/**
 * Under the address bar while it is edited (suggestions for what is typed), and the page of a new
 * tab: the bookmarks bar as tiles, and the pages visited last.
 */
export function StartPage({
  draft,
  engine,
  tabs,
  bookmarks,
  history,
  onOpen,
  onSwitch,
  onSearch,
}: {
  draft: string;
  engine: SearchEngine;
  tabs: ReadonlyArray<{ id: string; url: string; title: string }>;
  bookmarks: readonly Bookmark[];
  history: readonly SyncedHistoryEntry[];
  onOpen: (url: string) => void;
  onSwitch: (tabId: string) => void;
  onSearch: () => void;
}) {
  const theme = useTheme();
  const rows = useMemo(() => suggest(draft, { tabs, bookmarks, history }), [draft, tabs, bookmarks, history]);
  const tiles = useMemo(() => bookmarks.filter((b) => b.parentId === BAR_FOLDER_ID && b.kind === 'bookmark' && b.url).sort((a, b) => a.position - b.position).slice(0, 8), [bookmarks]);
  const recent = useMemo(() => history.slice(0, 6), [history]);
  const typed = draft.trim();
  const intent = typed ? classifyAddress(typed) : null;

  return (
    <ScrollView style={[styles.fill, { backgroundColor: theme.background }]} contentContainerStyle={styles.column} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" testID="browser-start">
      {intent ? (
        <ListGroup>
          <ListRow
            leading={<Icon name={intent.kind === 'url' ? 'globe' : 'search'} size={22} color={theme.accentText} />}
            title={intent.kind === 'url' ? intent.url : typed}
            subtitle={intent.kind === 'url' ? t('Open this address') : t('Search with {engine}', { engine: engine.name })}
            onPress={onSearch}
            testID="browser-suggest-go"
          />
          {rows.map((row) => (
            <ListRow
              key={`${row.kind}-${row.url}`}
              leading={<Favicon url={row.url} size={28} />}
              title={row.title || displayAddress(row.url)}
              subtitle={row.kind === 'tab' ? t('Switch to this tab') : row.url.replace(/^https?:\/\/(www\.)?/, '')}
              trailing={<View style={styles.kind}><Icon name={KIND_ICON[row.kind]} size={16} color={theme.textTertiary} /></View>}
              onPress={() => (row.tabId ? onSwitch(row.tabId) : onOpen(row.url))}
              testID={`browser-suggest-${row.url}`}
            />
          ))}
        </ListGroup>
      ) : (
        <>
          {tiles.length > 0 ? (
            <View style={styles.section}>
              <SectionHeader title={t('Bookmarks bar')} />
              <View style={styles.tiles}>
                {tiles.map((b) => (
                  <Pressable key={b.id} accessibilityRole="link" accessibilityLabel={b.title} onPress={() => onOpen(b.url!)} style={styles.tile} android_ripple={{ color: theme.ripple }} testID={`browser-tile-${b.url}`}>
                    <View style={[styles.tileIcon, { backgroundColor: theme.surface, borderColor: theme.border }]}>
                      <Favicon url={b.url!} size={32} />
                    </View>
                    <ThemedText type="caption" numberOfLines={1} style={styles.tileText}>
                      {b.title || tabHost(b.url!)}
                    </ThemedText>
                  </Pressable>
                ))}
              </View>
            </View>
          ) : null}
          {recent.length > 0 ? (
            <View style={styles.section}>
              <SectionHeader title={t('Recently visited')} />
              <ListGroup>
                {recent.map((h) => (
                  <ListRow key={h.url} leading={<Favicon url={h.url} size={28} />} title={h.title || displayAddress(h.url)} subtitle={tabHost(h.url)} onPress={() => onOpen(h.url)} testID={`browser-recent-${h.url}`} />
                ))}
              </ListGroup>
            </View>
          ) : null}
          {tiles.length === 0 && recent.length === 0 ? (
            <View style={styles.hint}>
              <Icon name="globe" size={36} color={theme.textTertiary} />
              <ThemedText type="small" themeColor="textSecondary" style={styles.center}>
                {t('Search with {engine} or type a web address. Ads and trackers are blocked, and nothing you browse leaves the phone except what you sync.', { engine: engine.name })}
              </ThemedText>
            </View>
          ) : null}
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
  },
  column: {
    width: '100%',
    maxWidth: Layout.maxWidth,
    alignSelf: 'center',
    padding: Layout.gutter,
    gap: Space.lg,
  },
  section: {
    gap: Space.sm,
  },
  kind: {
    paddingRight: Space.lg,
  },
  tiles: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    rowGap: Space.md,
  },
  tile: {
    width: '25%',
    alignItems: 'center',
    gap: Space.xs,
    paddingVertical: Space.xs,
    borderRadius: Radius.md,
  },
  tileIcon: {
    width: 56,
    height: 56,
    borderRadius: Radius.lg,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tileText: {
    paddingHorizontal: Space.xs,
    textAlign: 'center',
  },
  hint: {
    alignItems: 'center',
    gap: Space.md,
    paddingTop: Space.huge,
    paddingHorizontal: Space.lg,
  },
  center: {
    textAlign: 'center',
  },
});
