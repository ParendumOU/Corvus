import { BAR_FOLDER_ID, OTHER_FOLDER_ID, type Bookmark, type ReadingItem, type SyncedHistoryEntry } from '@corvus/shared';
import { router } from 'expo-router';
import { Fragment, useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Button, Fab, IconButton } from '@/components/button';
import { SectionHeader } from '@/components/card';
import { EmptyState, LoadingState } from '@/components/empty-state';
import { Favicon } from '@/components/favicon';
import { SearchField } from '@/components/fields';
import { Icon } from '@/components/icon';
import { IconTile, ListGroup, ListRow } from '@/components/list';
import { Screen, ScreenTitle } from '@/components/screen';
import { TabStrip, type StripTab } from '@/components/tab-strip';
import { ThemedText } from '@/components/themed-text';
import { Layout, Space } from '@/constants/theme';
import { refreshSession, setRead, useSession } from '@/hooks/use-session';
import { useTheme } from '@/hooks/use-theme';
import { ago } from '@/lib/format';
import { HISTORY_PAGE, groupByDay, searchHistory, timeOfDay } from '@/lib/history';
import { folderContents, folderPath, searchBookmarks, searchReading } from '@/lib/library';
import { openInApp, openInBrowser } from '@/lib/open-url';
import { tabHost } from '@/lib/replica';
import { t } from '@/lib/i18n';

type Section = 'bookmarks' | 'reading' | 'history';

function placeholder(section: Section): string {
  if (section === 'bookmarks') return t('Find a bookmark');
  if (section === 'reading') return t('Find in your reading list');
  return t('Search history');
}

const OPEN_HINT = (): string => t('Opens the page. Long press to open it in your browser app.');

/** A folder's name; the two root folders by their ids, in the app's language. */
function folderName(b: Bookmark): string {
  if (b.id === BAR_FOLDER_ID) return t('Bookmarks bar');
  if (b.id === OTHER_FOLDER_ID) return t('Other bookmarks');
  return b.title || t('Folder');
}

/** A page in a list: its favicon, title and a line under it. Tap opens it; long press, in the browser app. */
function PageRow({ url, title, sub, testID, onOpen, trailing, muted, titleLines = 1, subtitleLines = 1 }: { url: string; title: string; sub: string; testID: string; onOpen?: () => void; trailing?: React.ReactNode; muted?: boolean; titleLines?: number; subtitleLines?: number }) {
  return (
    <ListRow
      leading={<Favicon url={url} />}
      title={title || url}
      subtitle={sub}
      titleLines={titleLines}
      subtitleLines={subtitleLines}
      muted={muted}
      accessibilityRole="link"
      accessibilityHint={OPEN_HINT()}
      onPress={() => (onOpen ? onOpen() : void openInApp(url))}
      onLongPress={() => void openInBrowser(url)}
      trailing={trailing}
      testID={testID}
    />
  );
}

function Bookmarks({ bookmarks, query }: { bookmarks: Bookmark[]; query: string }) {
  const theme = useTheme();
  const [folder, setFolder] = useState<string | null>(null);
  const results = useMemo(() => searchBookmarks(bookmarks, query), [bookmarks, query]);
  const contents = useMemo(() => folderContents(bookmarks, folder), [bookmarks, folder]);
  const path = useMemo(() => folderPath(bookmarks, folder), [bookmarks, folder]);

  if (query.trim()) {
    if (results.length === 0) return <EmptyState icon="search" description={t('No bookmark matches “{query}”.', { query: query.trim() })} compact />;
    return (
      <ListGroup>
        {results.map((b) => (
          <PageRow key={b.id} url={b.url ?? ''} title={b.title} sub={tabHost(b.url ?? '')} testID={`bookmark-${b.url}`} />
        ))}
      </ListGroup>
    );
  }

  const crumb = (label: string, current: boolean, onPress: () => void, testID: string) => (
    <Pressable key={testID} accessibilityRole="button" accessibilityState={{ selected: current }} onPress={onPress} hitSlop={8} style={styles.crumb} testID={testID}>
      <ThemedText type="label" style={{ color: current ? theme.text : theme.accentText }} numberOfLines={1}>
        {label}
      </ThemedText>
    </Pressable>
  );

  return (
    <ListGroup
      header={
        folder !== null && (
        <View style={styles.crumbs}>
          {crumb(t('Bookmarks'), folder === null, () => setFolder(null), 'crumb-top')}
          {path.map((f) => (
            <Fragment key={f.id}>
              <Icon name="chevronRight" size={16} color={theme.textTertiary} />
              {crumb(folderName(f), f.id === folder, () => setFolder(f.id), `crumb-${f.title}`)}
            </Fragment>
          ))}
        </View>
        )
      }>
      {contents.length === 0 ? <EmptyState icon="folder" description={t('This folder is empty.')} compact /> : null}
      {contents.map((b) =>
        b.kind === 'folder' ? (
          <ListRow key={b.id} leading={<IconTile name="folder" />} title={folderName(b)} chevron onPress={() => setFolder(b.id)} testID={`folder-${b.title}`} />
        ) : (
          <PageRow key={b.id} url={b.url ?? ''} title={b.title} sub={tabHost(b.url ?? '')} testID={`bookmark-${b.url}`} />
        ),
      )}
    </ListGroup>
  );
}

function Reading({ items, query, refreshed }: { items: ReadingItem[]; query: string; refreshed: boolean }) {
  const theme = useTheme();
  const shown = useMemo(() => searchReading(items, query), [items, query]);
  const [busy, setBusy] = useState<string | null>(null);
  const toggle = (item: ReadingItem, read: boolean): void => {
    setBusy(item.url);
    void setRead(item, read).finally(() => setBusy(null));
  };
  const meta = (item: ReadingItem): string =>
    [item.siteName || tabHost(item.url), item.readingMinutes > 0 ? t('{n} min read', { n: item.readingMinutes }) : null, t('saved {when}', { when: ago(item.savedAt) })]
      .filter(Boolean)
      .join(' · ');

  if (shown.length === 0) {
    if (!query.trim() && !refreshed) return <LoadingState testID="reading-empty" />;
    return (
      <EmptyState
        icon={query.trim() ? 'search' : 'book'}
        description={query.trim() ? t('Nothing in your reading list matches “{query}”.', { query: query.trim() }) : t('Your reading list is empty. Save articles in reader mode on your computer, or share a link to Corvus here.')}
        compact
        testID="reading-empty"
      />
    );
  }

  const unread = shown.filter((i) => i.readAt === undefined);
  const done = shown.filter((i) => i.readAt !== undefined);
  const rows = (list: ReadingItem[]) =>
    list.map((item) => {
      const read = item.readAt !== undefined;
      return (
        <PageRow
          key={item.url}
          url={item.url}
          title={item.title}
          sub={meta(item)}
          titleLines={2}
          subtitleLines={2}
          muted={read}
          testID={`reading-${item.url}`}
          onOpen={() => {
            void openInApp(item.url);
            if (!read) toggle(item, true);
          }}
          trailing={
            <IconButton
              icon={read ? 'checkCircle' : 'circle'}
              color={read ? theme.accentText : theme.textTertiary}
              accessibilityLabel={read ? t('Mark unread') : t('Mark read')}
              disabled={busy === item.url}
              onPress={() => toggle(item, !read)}
              testID={`reading-toggle-${item.url}`}
            />
          }
        />
      );
    });
  return (
    <>
      {unread.length > 0 && (
        <View style={styles.section}>
          <SectionHeader title={t('Unread')} trailing={<ThemedText type="caption" themeColor="textSecondary">{unread.length}</ThemedText>} />
          <ListGroup>{rows(unread)}</ListGroup>
        </View>
      )}
      {done.length > 0 && (
        <View style={styles.section}>
          <SectionHeader title={t('Read')} trailing={<ThemedText type="caption" themeColor="textSecondary">{done.length}</ThemedText>} />
          <ListGroup>{rows(done)}</ListGroup>
        </View>
      )}
    </>
  );
}

function History({ entries, query, refreshed }: { entries: SyncedHistoryEntry[]; query: string; refreshed: boolean }) {
  const [limit, setLimit] = useState(HISTORY_PAGE);
  const matches = useMemo(() => searchHistory(entries, query), [entries, query]);
  const days = useMemo(() => groupByDay(matches.slice(0, limit)), [matches, limit]);

  if (matches.length === 0) {
    if (!query.trim() && !refreshed) return <LoadingState testID="history-empty" />;
    return (
      <EmptyState
        icon={query.trim() ? 'search' : 'history'}
        description={query.trim() ? t('Nothing in your history matches “{query}”.', { query: query.trim() }) : t('No history from your computers yet.')}
        compact
        testID="history-empty"
      />
    );
  }
  return (
    <>
      {days.map((day) => (
        <View key={day.label} style={styles.section} testID={`history-day-${day.label}`}>
          <SectionHeader title={day.label} />
          <ListGroup>
            {day.entries.map((e) => (
              <PageRow key={e.url} url={e.url} title={e.title} sub={`${timeOfDay(e.visitedAt)} · ${tabHost(e.url)}`} testID={`history-${e.url}`} />
            ))}
          </ListGroup>
        </View>
      ))}
      {matches.length > limit && (
        <Button label={t('Show more ({n} left)', { n: matches.length - limit })} kind="tonal" onPress={() => setLimit((n) => n + HISTORY_PAGE)} testID="history-more" />
      )}
    </>
  );
}

export default function LibraryScreen() {
  const session = useSession();
  const [section, setSection] = useState<Section>('bookmarks');
  const [query, setQuery] = useState('');
  const [scrolled, setScrolled] = useState(false);
  const paired = session.status !== 'unpaired';

  const tabs: StripTab<Section>[] = [
    { key: 'bookmarks', label: t('Bookmarks'), icon: 'star', testID: 'library-bookmarks' },
    { key: 'reading', label: t('Reading'), accessibilityLabel: t('Reading list'), icon: 'book', testID: 'library-reading' },
    { key: 'history', label: t('History'), icon: 'history', testID: 'library-history' },
  ];

  return (
    <Screen
      tab
      refreshing={session.refreshing}
      onRefresh={paired ? () => void refreshSession() : undefined}
      onScrolled={setScrolled}
      floating={paired ? <Fab label={t('Save or send a page')} icon="plus" collapsed={scrolled} onPress={() => router.push('/send')} testID="library-add" /> : undefined}>
      <ScreenTitle title={t('Library')} testID="library-title" />

      {!paired ? (
        <EmptyState
          icon="bookmark"
          title={t('Your library, on your phone')}
          description={t('Pair this phone with your computer to see your bookmarks and reading list here.')}
          action={<Button label={t('Pair with a computer')} icon="scan" onPress={() => router.push('/pair')} />}
        />
      ) : (
        <>
          <View style={styles.bleed}>
            <TabStrip tabs={tabs} value={section} onChange={setSection} />
          </View>
          <SearchField testID="library-search" value={query} onChangeText={setQuery} placeholder={placeholder(section)} />
          {section === 'bookmarks' && <Bookmarks bookmarks={session.bookmarks} query={query} />}
          {section === 'reading' && <Reading items={session.reading} query={query} refreshed={session.refreshed} />}
          {section === 'history' && <History entries={session.history} query={query} refreshed={session.refreshed} />}
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  bleed: {
    marginHorizontal: -Layout.gutter,
    marginTop: -Space.sm,
  },
  crumbs: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: Space.xs,
  },
  crumb: {
    minHeight: 32,
    justifyContent: 'center',
  },
  section: {
    gap: Space.sm,
  },
});
