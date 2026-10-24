import type { Bookmark, ReadingItem, SyncedHistoryEntry } from '@corvus/shared';
import { router } from 'expo-router';
import { useMemo, useState, type ReactNode } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button } from '@/components/button';
import { Favicon } from '@/components/favicon';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { BottomTabInset, MaxContentWidth, Spacing } from '@/constants/theme';
import { refreshSession, setRead, useSession } from '@/hooks/use-session';
import { useTheme } from '@/hooks/use-theme';
import { ago } from '@/lib/format';
import { HISTORY_PAGE, groupByDay, searchHistory, timeOfDay } from '@/lib/history';
import { folderContents, folderPath, searchBookmarks, searchReading } from '@/lib/library';
import { openInApp, openInBrowser } from '@/lib/open-url';
import { tabHost } from '@/lib/replica';

type Section = 'bookmarks' | 'reading' | 'history';

const PLACEHOLDERS: Record<Section, string> = {
  bookmarks: 'Find a bookmark',
  reading: 'Find in your reading list',
  history: 'Search history',
};

function Segment({ value, onChange }: { value: Section; onChange: (s: Section) => void }) {
  const theme = useTheme();
  const options: Array<[Section, string]> = [
    ['bookmarks', 'Bookmarks'],
    ['reading', 'Reading list'],
    ['history', 'History'],
  ];
  return (
    <ThemedView type="backgroundElement" style={styles.segment}>
      {options.map(([key, label]) => (
        <Pressable
          key={key}
          accessibilityRole="tab"
          accessibilityState={{ selected: value === key }}
          onPress={() => onChange(key)}
          style={[styles.segmentButton, value === key && { backgroundColor: theme.backgroundSelected }]}
          testID={`library-${key}`}>
          <ThemedText type="smallBold" themeColor={value === key ? 'text' : 'textSecondary'}>
            {label}
          </ThemedText>
        </Pressable>
      ))}
    </ThemedView>
  );
}

function PageRow({ url, title, sub, testID, onOpen, right }: { url: string; title: string; sub: string; testID: string; onOpen?: () => void; right?: ReactNode }) {
  const theme = useTheme();
  return (
    <View style={styles.rowWrap}>
      <Pressable
        accessibilityRole="link"
        accessibilityHint="Opens the page. Long press to open it in your browser app."
        onPress={() => (onOpen ? onOpen() : void openInApp(url))}
        onLongPress={() => void openInBrowser(url)}
        style={({ pressed }) => [styles.row, pressed && { backgroundColor: theme.backgroundSelected }]}
        testID={testID}>
        <Favicon url={url} />
        <View style={styles.grow}>
          <ThemedText type="small" numberOfLines={2}>
            {title || url}
          </ThemedText>
          <ThemedText type="small" themeColor="textSecondary" numberOfLines={1}>
            {sub}
          </ThemedText>
        </View>
      </Pressable>
      {right}
    </View>
  );
}

function Bookmarks({ bookmarks, query }: { bookmarks: Bookmark[]; query: string }) {
  const [folder, setFolder] = useState<string | null>(null);
  const results = useMemo(() => searchBookmarks(bookmarks, query), [bookmarks, query]);
  const contents = useMemo(() => folderContents(bookmarks, folder), [bookmarks, folder]);
  const path = useMemo(() => folderPath(bookmarks, folder), [bookmarks, folder]);

  if (query.trim()) {
    return (
      <ThemedView type="backgroundElement" style={styles.card}>
        {results.length === 0 && (
          <ThemedText type="small" themeColor="textSecondary">
            No bookmark matches “{query.trim()}”.
          </ThemedText>
        )}
        {results.map((b) => (
          <PageRow key={b.id} url={b.url ?? ''} title={b.title} sub={tabHost(b.url ?? '')} testID={`bookmark-${b.url}`} />
        ))}
      </ThemedView>
    );
  }

  return (
    <ThemedView type="backgroundElement" style={styles.card}>
      <View style={styles.crumbs}>
        <Pressable onPress={() => setFolder(null)} testID="crumb-top">
          <ThemedText type="smallBold" themeColor={folder === null ? 'text' : 'textSecondary'}>
            Bookmarks
          </ThemedText>
        </Pressable>
        {path.map((f) => (
          <Pressable key={f.id} onPress={() => setFolder(f.id)} testID={`crumb-${f.title}`}>
            <ThemedText type="smallBold" themeColor={f.id === folder ? 'text' : 'textSecondary'}>
              {' › '}
              {f.title || 'Folder'}
            </ThemedText>
          </Pressable>
        ))}
      </View>
      {contents.length === 0 && (
        <ThemedText type="small" themeColor="textSecondary">
          This folder is empty.
        </ThemedText>
      )}
      {contents.map((b) =>
        b.kind === 'folder' ? (
          <Pressable key={b.id} accessibilityRole="button" onPress={() => setFolder(b.id)} style={styles.row} testID={`folder-${b.title}`}>
            <ThemedText type="small" style={styles.folderIcon}>
              ▸
            </ThemedText>
            <ThemedText type="small" style={styles.grow}>
              {b.title || 'Folder'}
            </ThemedText>
          </Pressable>
        ) : (
          <PageRow key={b.id} url={b.url ?? ''} title={b.title} sub={tabHost(b.url ?? '')} testID={`bookmark-${b.url}`} />
        ),
      )}
    </ThemedView>
  );
}

function Reading({ items, query, refreshed }: { items: ReadingItem[]; query: string; refreshed: boolean }) {
  const shown = useMemo(() => searchReading(items, query), [items, query]);
  const [busy, setBusy] = useState<string | null>(null);
  const toggle = (item: ReadingItem, read: boolean): void => {
    setBusy(item.url);
    void setRead(item, read).finally(() => setBusy(null));
  };
  const meta = (item: ReadingItem): string =>
    [
      item.siteName || tabHost(item.url),
      item.readingMinutes > 0 ? `${item.readingMinutes} min read` : null,
      `saved ${ago(item.savedAt)}`,
      item.readAt !== undefined ? 'read' : null,
    ]
      .filter(Boolean)
      .join(' · ');

  return (
    <ThemedView type="backgroundElement" style={styles.card}>
      {shown.length === 0 && (
        <ThemedText type="small" themeColor="textSecondary" testID="reading-empty">
          {query.trim()
            ? `Nothing in your reading list matches “${query.trim()}”.`
            : refreshed
              ? 'Your reading list is empty. Save articles in reader mode on your computer, or share a link to Corvus here.'
              : 'Loading…'}
        </ThemedText>
      )}
      {shown.map((item) => {
        const read = item.readAt !== undefined;
        return (
          <PageRow
            key={item.url}
            url={item.url}
            title={item.title}
            sub={meta(item)}
            testID={`reading-${item.url}`}
            onOpen={() => {
              void openInApp(item.url);
              if (!read) toggle(item, true);
            }}
            right={
              <Pressable
                accessibilityRole="button"
                disabled={busy === item.url}
                onPress={() => toggle(item, !read)}
                hitSlop={8}
                testID={`reading-toggle-${item.url}`}>
                <ThemedText type="smallBold" themeColor="textSecondary">
                  {read ? 'Mark unread' : 'Mark read'}
                </ThemedText>
              </Pressable>
            }
          />
        );
      })}
    </ThemedView>
  );
}

function History({ entries, query, refreshed }: { entries: SyncedHistoryEntry[]; query: string; refreshed: boolean }) {
  const [limit, setLimit] = useState(HISTORY_PAGE);
  const matches = useMemo(() => searchHistory(entries, query), [entries, query]);
  const days = useMemo(() => groupByDay(matches.slice(0, limit)), [matches, limit]);

  if (matches.length === 0) {
    return (
      <ThemedView type="backgroundElement" style={styles.card}>
        <ThemedText type="small" themeColor="textSecondary" testID="history-empty">
          {query.trim() ? `Nothing in your history matches “${query.trim()}”.` : refreshed ? 'No history from your computers yet.' : 'Loading…'}
        </ThemedText>
      </ThemedView>
    );
  }
  return (
    <>
      {days.map((day) => (
        <ThemedView key={day.label} type="backgroundElement" style={styles.card} testID={`history-day-${day.label}`}>
          <ThemedText type="smallBold">{day.label}</ThemedText>
          {day.entries.map((e) => (
            <PageRow key={e.url} url={e.url} title={e.title} sub={`${timeOfDay(e.visitedAt)} · ${tabHost(e.url)}`} testID={`history-${e.url}`} />
          ))}
        </ThemedView>
      ))}
      {matches.length > limit && (
        <Button label={`Show more (${matches.length - limit} left)`} kind="secondary" onPress={() => setLimit((n) => n + HISTORY_PAGE)} testID="history-more" />
      )}
    </>
  );
}

export default function LibraryScreen() {
  const theme = useTheme();
  const session = useSession();
  const [section, setSection] = useState<Section>('bookmarks');
  const [query, setQuery] = useState('');

  return (
    <ThemedView style={styles.container}>
      <SafeAreaView style={styles.safeArea}>
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          refreshControl={
            session.status === 'paired' ? <RefreshControl refreshing={session.refreshing} onRefresh={() => void refreshSession()} /> : undefined
          }>
          <ThemedText type="subtitle" testID="library-title">
            Library
          </ThemedText>

          {session.status === 'unpaired' ? (
            <ThemedView type="backgroundElement" style={styles.card}>
              <ThemedText type="small" themeColor="textSecondary">
                Pair this phone with your computer to see your bookmarks and reading list here.
              </ThemedText>
              <Button label="Pair with a computer" onPress={() => router.push('/pair')} />
            </ThemedView>
          ) : (
            <>
              <Segment value={section} onChange={setSection} />
              <TextInput
                testID="library-search"
                style={[styles.search, { color: theme.text, backgroundColor: theme.backgroundElement }]}
                value={query}
                onChangeText={setQuery}
                placeholder={PLACEHOLDERS[section]}
                placeholderTextColor={theme.textSecondary}
                autoCapitalize="none"
                autoCorrect={false}
                clearButtonMode="while-editing"
              />
              {section === 'bookmarks' && <Bookmarks bookmarks={session.bookmarks} query={query} />}
              {section === 'reading' && <Reading items={session.reading} query={query} refreshed={session.refreshed} />}
              {section === 'history' && <History entries={session.history} query={query} refreshed={session.refreshed} />}
              <Button label="Save or send a page" kind="secondary" onPress={() => router.push('/send')} testID="library-add" />
            </>
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
  segment: {
    flexDirection: 'row',
    padding: Spacing.one,
    borderRadius: Spacing.three,
    gap: Spacing.one,
  },
  segmentButton: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: Spacing.two,
    borderRadius: Spacing.two,
  },
  search: {
    minHeight: 44,
    paddingHorizontal: Spacing.three,
    borderRadius: Spacing.three,
    fontSize: 16,
  },
  card: {
    gap: Spacing.one,
    padding: Spacing.three,
    borderRadius: Spacing.four,
  },
  crumbs: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingBottom: Spacing.two,
  },
  rowWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  row: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    paddingVertical: Spacing.two,
    paddingHorizontal: Spacing.one,
    borderRadius: Spacing.two,
  },
  grow: {
    flex: 1,
  },
  folderIcon: {
    width: 20,
    textAlign: 'center',
  },
});
