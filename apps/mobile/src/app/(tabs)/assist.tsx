import { router } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { Button, Fab } from '@/components/button';
import { EmptyState, LoadingState } from '@/components/empty-state';
import { Favicon } from '@/components/favicon';
import { SearchField } from '@/components/fields';
import { Icon } from '@/components/icon';
import { IconTile, ListGroup, ListRow } from '@/components/list';
import { Screen, ScreenTitle } from '@/components/screen';
import { ThemedText } from '@/components/themed-text';
import { Space } from '@/constants/theme';
import { refreshSession, useSession } from '@/hooks/use-session';
import { useTheme } from '@/hooks/use-theme';
import { chatList, searchChats, type ChatSummary } from '@/lib/chat';
import { ago } from '@/lib/format';
import { t } from '@/lib/i18n';

/** While a computer writes an answer, the list looks for it this often. */
const ANSWER_REFRESH_MS = 3_000;

function ChatRow({ chat }: { chat: ChatSummary }) {
  const theme = useTheme();
  const open = (): void => {
    if (chat.kind === 'assist') router.push({ pathname: '/chat/[id]', params: { id: chat.id, assist: '1' } });
    else router.push({ pathname: '/chat/[id]', params: { id: chat.id } });
  };
  const status = chat.waiting ? t('Waiting for {computer}…', { computer: chat.where }) : chat.pending ? t('Answering…') : chat.failed ? t('Could not answer') : chat.snippet;
  return (
    <ListRow
      leading={chat.kind === 'assist' && chat.url ? <Favicon url={chat.url} /> : <IconTile name="sparkle" />}
      title={
        <View style={styles.titleLine}>
          <ThemedText type="bodyStrong" numberOfLines={1} style={styles.grow}>
            {chat.title}
          </ThemedText>
          <ThemedText type="caption" themeColor="textTertiary">
            {ago(chat.updatedAt)}
          </ThemedText>
        </View>
      }
      subtitle={
        <View style={styles.sub}>
          <ThemedText type="small" numberOfLines={2} style={{ color: chat.failed ? theme.danger : chat.pending ? theme.accentText : theme.textSecondary }}>
            {status}
          </ThemedText>
          <View style={styles.meta}>
            {chat.pending ? <ActivityIndicator size="small" color={theme.accent} style={styles.spinner} /> : <Icon name={chat.kind === 'assist' ? 'globe' : 'laptop'} size={14} color={theme.textTertiary} />}
            <ThemedText type="caption" themeColor="textTertiary" numberOfLines={1} style={styles.grow}>
              {chat.kind === 'assist' ? t('Assist on your computer · {page}', { page: chat.where }) : chat.where}
            </ThemedText>
          </View>
        </View>
      }
      accessibilityLabel={`${chat.title}. ${status}`}
      onPress={open}
      testID={chat.kind === 'assist' ? `chat-assist-${chat.id}` : `chat-${chat.title}`}
    />
  );
}

/**
 * The Assist tab: every conversation with Corvus in one list, newest first. Those asked from this
 * phone (a computer answers them) and those had in Corvus Assist on a computer.
 */
export default function AssistScreen() {
  const session = useSession();
  const [query, setQuery] = useState('');
  const [scrolled, setScrolled] = useState(false);
  const paired = session.status !== 'unpaired';
  const names = useMemo(() => new Map(session.devices.map((d) => [d.id, d.name])), [session.devices]);
  const all = useMemo(() => chatList(session.asks, session.conversations, (id) => names.get(id) ?? t('your computer')), [session.asks, session.conversations, names]);
  const shown = useMemo(() => searchChats(all, query), [all, query]);
  const pending = all.some((c) => c.pending);

  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => void refreshSession(), ANSWER_REFRESH_MS);
    return () => clearInterval(timer);
  }, [pending]);

  const start = (): void => router.push({ pathname: '/chat/[id]', params: { id: 'new' } });

  return (
    <Screen
      tab
      refreshing={session.refreshing}
      onRefresh={paired ? () => void refreshSession() : undefined}
      onScrolled={setScrolled}
      floating={paired ? <Fab label={t('New chat')} icon="plus" collapsed={scrolled} onPress={start} testID="assist-new" /> : undefined}>
      <ScreenTitle title={t('Assist')} testID="assist-title" />
      {!paired ? (
        <EmptyState
          icon="sparkle"
          title={t('Ask your computer anything')}
          description={t('Pair this phone with your computer first: your computer answers the questions.')}
          action={<Button label={t('Pair with a computer')} icon="scan" onPress={() => router.push('/pair')} testID="ask-pair" />}
        />
      ) : all.length === 0 ? (
        session.refreshed ? (
          <EmptyState
            icon="sparkle"
            title={t('Ask your computer anything')}
            description={t('Your computer answers with Corvus’s AI search while Corvus is open there. Your conversations with Corvus Assist on your computers show up here too.')}
            action={<Button label={t('Start a chat')} icon="sparkle" onPress={start} testID="assist-start" />}
            testID="assist-empty"
          />
        ) : (
          <LoadingState testID="assist-empty" />
        )
      ) : (
        <>
          <SearchField testID="assist-search" value={query} onChangeText={setQuery} placeholder={t('Search conversations')} />
          {shown.length === 0 ? (
            <EmptyState icon="search" description={t('No conversation matches “{query}”.', { query: query.trim() })} compact />
          ) : (
            <ListGroup testID="assist-list">
              {shown.map((c) => (
                <ChatRow key={`${c.kind}-${c.id}`} chat={c} />
              ))}
            </ListGroup>
          )}
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  titleLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.sm,
  },
  grow: {
    flex: 1,
  },
  sub: {
    gap: 2,
  },
  meta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.xs + 2,
  },
  spinner: {
    transform: [{ scale: 0.7 }],
    width: 14,
    height: 14,
  },
});
