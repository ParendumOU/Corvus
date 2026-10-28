import type { AskRecord, DeviceInfo } from '@corvus/shared';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentRef } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { Button, IconButton } from '@/components/button';
import { AnswerBlock, ComputerButton, ComputerSheet, Composer, FollowUpChips, UserBubble, type AnswerTone } from '@/components/chat';
import { EmptyState, LoadingState } from '@/components/empty-state';
import { Favicon } from '@/components/favicon';
import { Banner, confirm } from '@/components/feedback';
import { CorvusMark, Icon } from '@/components/icon';
import { ThemedText } from '@/components/themed-text';
import { Layout, Radius, Space } from '@/constants/theme';
import { askQuestion, forgetAsks, forgetThread, refreshSession, retryAsk, useSession } from '@/hooks/use-session';
import { useKeyboardInset } from '@/hooks/use-keyboard-inset';
import { useTheme } from '@/hooks/use-theme';
import { answeredAlone, askPhase, assistContext, assistOrigin, assistTitle, followUpContext, isOnline, threadAsks } from '@/lib/chat';
import { ago } from '@/lib/format';
import { t } from '@/lib/i18n';
import { openInApp } from '@/lib/open-url';
import { contextPage, pageContext } from '@/lib/page-ask';
import { clearHandedPage, handedPage } from '@/lib/page-handoff';
import { tabHost } from '@/lib/replica';
import { sendTargets } from '@/lib/send';

/** How often the screen looks for more of the answer while a computer is writing it. */
const ANSWER_REFRESH_MS = 2_000;

/** Questions to start with, on a new chat. */
const SUGGESTIONS = (): string[] => [t('What happened in the news today?'), t('Explain how vaccines work in simple terms'), t('Plan a weekend in Lisbon')];

/** One question and the computer's side of it. */
function Turn({
  ask,
  computer,
  others,
  now,
  last,
  busy,
  onAsk,
}: {
  ask: AskRecord;
  computer: DeviceInfo | undefined;
  /** The computers other than the one asked that run Corvus right now (to ask instead). */
  others: DeviceInfo[];
  now: number;
  last: boolean;
  busy: boolean;
  onAsk: (q: string) => void;
}) {
  const name = ask.answeredBy || computer?.name || t('your computer');
  const phase = askPhase(ask, computer, now);
  const retry = <Button key="retry" label={t('Try again')} icon="refresh" kind="tonal" size="sm" onPress={() => void retryAsk(ask)} testID={`ask-retry-${ask.question}`} />;
  const cancel = <Button key="cancel" label={t('Cancel')} kind="text" size="sm" onPress={() => void forgetAsks([ask.id])} testID={`ask-remove-${ask.question}`} />;
  const elsewhere = others[0] ? (
    <Button key="other" label={t('Ask {computer}', { computer: others[0].name })} kind="tonal" size="sm" onPress={() => void retryAsk(ask, others[0]!.id)} testID={`ask-other-${ask.question}`} />
  ) : null;

  let status: string;
  let tone: AnswerTone = 'progress';
  let thinking = false;
  let actions: React.ReactNode = null;
  switch (phase) {
    case 'waiting':
      status = t('Waiting for {computer}…', { computer: name });
      thinking = true;
      break;
    case 'offline':
      status = t('Corvus is not open on {computer}. It answers as soon as Corvus opens there.', { computer: name });
      tone = 'warning';
      actions = [elsewhere, cancel];
      break;
    case 'unanswered':
      status = t('{computer} has not picked it up yet. Check that “Answer questions from Corvus on your phone” is on in Corvus’s settings there.', { computer: name });
      tone = 'warning';
      actions = [elsewhere, cancel];
      break;
    case 'answering':
      status = ask.answer ? t('{computer} is writing…', { computer: name }) : t('Thinking on {computer}…', { computer: name });
      thinking = true;
      break;
    case 'stalled':
      status = t('{computer} stopped answering.', { computer: name });
      tone = 'warning';
      actions = [retry, cancel];
      break;
    case 'error':
      status = t('{computer} could not answer: {error}', { computer: name, error: ask.error || t('something went wrong') });
      tone = 'error';
      actions = [retry, cancel];
      break;
    default:
      status = t('Answered by {computer} · {when}', { computer: name, when: ago(ask.updatedAt, now) });
      tone = 'muted';
  }
  return (
    <View style={styles.turn} testID={`ask-${ask.question}`}>
      <UserBubble text={ask.question} />
      <AnswerBlock
        who={name}
        status={status}
        tone={tone}
        thinking={thinking}
        answer={ask.answer}
        streaming={phase === 'answering' && ask.answer !== ''}
        sources={ask.sources}
        note={answeredAlone(ask) ? t('Answered without the earlier messages: update Corvus on {computer} to answer follow-ups.', { computer: name }) : undefined}
        actions={actions}
        statusTestID={`ask-status-${ask.question}`}
        answerTestID={`ask-answer-${ask.question}`}>
        {last && phase === 'done' ? <FollowUpChips questions={ask.followUps} onAsk={onAsk} disabled={busy} /> : null}
      </AnswerBlock>
    </View>
  );
}

/**
 * A conversation of the Assist tab. `id` is a conversation of this phone (its first question's id),
 * "new" for a new one, or with `assist=1` a Corvus Assist conversation had on a computer: read here,
 * and continued as a new conversation of the phone that quotes it.
 */
export default function ChatScreen() {
  const theme = useTheme();
  const params = useLocalSearchParams<{ id: string; assist?: string; page?: string }>();
  const id = params.id ?? 'new';
  const session = useSession();
  const [now, setNow] = useState(() => Date.now());
  const [draft, setDraft] = useState('');
  const [to, setTo] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const atBottom = useRef(true);
  const scrolledOnce = useRef(false);
  const openPicker = useCallback(() => setPicking(true), []);
  const keyboard = useKeyboardInset();

  const conversation = params.assist ? session.conversations.find((c) => c.id === id) : undefined;
  const asks = useMemo(() => (params.assist || id === 'new' ? [] : threadAsks(session.asks, id)), [session.asks, id, params.assist]);
  // A chat about a page of the browser: the page handed over (a new chat), or the one its first question carries.
  const handed = id === 'new' ? handedPage(params.page) : null;
  const aboutPage = handed ?? contextPage(asks[0]?.context);
  const last = asks[asks.length - 1];
  const targets = useMemo(() => sendTargets(session.devices, session.self, session.tabs), [session.devices, session.self, session.tabs]);
  const preferred = targets.find((d) => isOnline(d, now)) ?? targets[0];
  const computer = targets.find((d) => d.id === (to ?? last?.to)) ?? preferred;
  const pending = last?.state === 'waiting' || last?.state === 'answering';
  const online = targets.filter((d) => isOnline(d, now));

  // The clock moves the states on ("not open there"), and an answer being written is fetched often.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => void refreshSession(), ANSWER_REFRESH_MS);
    return () => clearInterval(timer);
  }, [pending]);

  const send = async (text: string): Promise<void> => {
    const question = text.trim();
    if (!question || !computer || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (conversation) {
        const asked = await askQuestion(question, computer.id, { context: assistContext(conversation), origin: assistOrigin(conversation) });
        router.replace(`/chat/${asked.id}`);
      } else if (id === 'new' || asks.length === 0) {
        const asked = await askQuestion(question, computer.id, handed ? { context: pageContext(handed, handed.text) } : {});
        if (handed) clearHandedPage();
        router.replace(`/chat/${asked.id}`);
      } else {
        await askQuestion(question, computer.id, { thread: id, context: followUpContext(asks) });
      }
      setDraft('');
      atBottom.current = true;
    } catch (err) {
      setError(t('That did not work: {error}', { error: err instanceof Error ? err.message : String(err) }));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (): Promise<void> => {
    const ok = await confirm({
      title: t('Delete this conversation?'),
      message: t('It leaves this phone and the computers. A computer still answering stops.'),
      confirmLabel: t('Delete'),
      destructive: true,
    });
    if (!ok) return;
    await forgetThread(id);
    if (router.canGoBack()) router.back();
    else router.replace('/assist');
  };

  const header = (
    <Stack.Screen
      options={{
        title: t('Assist'),
        // The computer that answers sits on the right, next to deleting the conversation (a header title
        // is not pressable on the web build).
        headerRight: () => (
          <View style={styles.headerActions}>
            {conversation ? null : <ComputerButton computer={computer} now={now} onPress={openPicker} />}
            {asks.length > 0 ? <IconButton icon="trash" accessibilityLabel={t('Delete this conversation')} onPress={() => void remove()} testID="chat-delete" /> : null}
          </View>
        ),
      }}
    />
  );

  if (session.status === 'unpaired') {
    return (
      <View style={[styles.fill, { backgroundColor: theme.background }]}>
        {header}
        <EmptyState
          icon="sparkle"
          description={t('Pair this phone with your computer first: your computer answers the questions.')}
          action={<Button label={t('Pair with a computer')} icon="scan" onPress={() => router.replace('/pair')} testID="ask-pair" />}
        />
      </View>
    );
  }

  const gone = !conversation && id !== 'new' && asks.length === 0;
  if (gone && !session.refreshed) {
    return (
      <View style={[styles.fill, { backgroundColor: theme.background }]}>
        {header}
        <LoadingState />
      </View>
    );
  }

  const composerNote = targets.length === 0 ? (
    session.refreshed ? (
      <Banner tone="warning" message={t('No computer on this sync chain yet.')} testID="ask-no-computer" />
    ) : (
      <LoadingState testID="ask-no-computer" />
    )
  ) : conversation ? (
    <ThemedText type="caption" themeColor="textSecondary" testID="chat-continue-note">
      {t('Your reply starts a new chat on this phone that continues this one. {computer} answers it.', { computer: computer?.name ?? '' })}
    </ThemedText>
  ) : null;

  return (
    <View style={[styles.fill, { backgroundColor: theme.background, paddingBottom: keyboard }]}>
      {header}
      <ScrollView
        ref={scroll}
        style={styles.fill}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        scrollEventThrottle={64}
        onScroll={(e) => {
          // Before the first scroll to the end, a scroll event is only the page settling.
          if (!scrolledOnce.current) return;
          const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
          atBottom.current = contentSize.height - contentOffset.y - layoutMeasurement.height < 96;
        }}
        // The keyboard coming up shrinks the list: the latest message stays in view.
        onLayout={() => {
          if (atBottom.current && scrolledOnce.current) requestAnimationFrame(() => scroll.current?.scrollToEnd({ animated: false }));
        }}
        onContentSizeChange={() => {
          // The latest message stays in view as it grows; opening a conversation starts at its end.
          if (!atBottom.current) return;
          const animated = scrolledOnce.current;
          scrolledOnce.current = true;
          requestAnimationFrame(() => scroll.current?.scrollToEnd({ animated }));
        }}>
        <View style={styles.column}>
          {gone && !conversation ? (
            <EmptyState icon="sparkle" title={t('This conversation is gone')} description={t('It was deleted on this phone or on another device.')} testID="chat-gone" />
          ) : null}

          {conversation ? (
            <View style={[styles.pageCard, { backgroundColor: theme.surface, borderColor: theme.border }]} testID={`conversation-${conversation.id}`}>
              <View style={styles.pageHead}>
                <Favicon url={conversation.url} size={28} />
                <View style={styles.grow}>
                  <ThemedText type="bodyStrong" numberOfLines={2}>
                    {conversation.pageTitle || tabHost(conversation.url)}
                  </ThemedText>
                  <ThemedText type="small" themeColor="textSecondary" numberOfLines={1}>
                    {t('Corvus Assist on your computer · {when}', { when: ago(conversation.updatedAt, now) })}
                  </ThemedText>
                </View>
              </View>
              <Button label={t('Open the page')} kind="tonal" icon="external" size="sm" style={styles.start} onPress={() => void openInApp(conversation.url)} testID={`conversation-open-${conversation.id}`} />
            </View>
          ) : null}

          {conversation?.turns.map((turn) => (
            <View key={turn.id} style={styles.turn}>
              <UserBubble text={turn.prompt.trim() || (turn.kind === 'summarize' ? t('Summarize this page') : assistTitle(conversation))} />
              <AnswerBlock who="Corvus Assist" status={t('On your computer')} tone="muted" answer={turn.text || t('(no answer)')} sources={[]} answerTestID={`conversation-answer-${turn.id}`} />
            </View>
          ))}

          {asks[0]?.origin ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => router.push({ pathname: '/chat/[id]', params: { id: asks[0]!.origin!.conversation, assist: '1' } })}
              style={[styles.quote, { borderLeftColor: theme.accent, backgroundColor: theme.accentSoft }]}
              testID="chat-origin">
              <Icon name="history" size={18} color={theme.accentText} />
              <View style={styles.grow}>
                <ThemedText type="caption" themeColor="accentText">
                  {t('Continues a conversation from your computer')}
                </ThemedText>
                <ThemedText type="small" numberOfLines={2}>
                  {asks[0].origin.title}
                </ThemedText>
              </View>
              <Icon name="chevronRight" size={18} color={theme.textTertiary} />
            </Pressable>
          ) : null}

          {aboutPage ? (
            <View style={[styles.pageCard, { backgroundColor: theme.surface, borderColor: theme.border }]} testID="chat-page">
              <View style={styles.pageHead}>
                <Favicon url={aboutPage.url} size={28} />
                <View style={styles.grow}>
                  <ThemedText type="bodyStrong" numberOfLines={2}>
                    {aboutPage.title || tabHost(aboutPage.url)}
                  </ThemedText>
                  <ThemedText type="small" themeColor="textSecondary" numberOfLines={1}>
                    {handed?.text?.text ? t('About this page · its text goes with your question') : t('About this page · {site}', { site: tabHost(aboutPage.url) })}
                  </ThemedText>
                </View>
              </View>
              <Button label={t('Open the page')} kind="tonal" icon="external" size="sm" style={styles.start} onPress={() => void openInApp(aboutPage.url)} testID="chat-page-open" />
            </View>
          ) : null}

          {id === 'new' && !conversation && handed ? (
            <View style={styles.pageAsk} testID="chat-new-page">
              <ThemedText type="small" themeColor="textSecondary">
                {t('Ask about this page. Your computer answers with its AI search, using its own AI provider.')}
              </ThemedText>
              <FollowUpChips questions={[t('Summarize this page'), t('What are the key points?'), t('Is this source reliable?')]} onAsk={(q) => void send(q)} disabled={busy || !computer} />
            </View>
          ) : null}

          {id === 'new' && !conversation && !handed ? (
            <View style={styles.hero} testID="chat-new">
              <View style={[styles.heroMark, { backgroundColor: theme.accentSoft }]}>
                <CorvusMark size={40} />
              </View>
              <ThemedText type="title" style={styles.center}>
                {t('Ask your computer anything')}
              </ThemedText>
              <ThemedText type="small" themeColor="textSecondary" style={styles.center}>
                {t("Your computer answers with Corvus's AI search, using its own AI provider, while Corvus is open there.")}
              </ThemedText>
              <FollowUpChips questions={SUGGESTIONS()} onAsk={(q) => void send(q)} disabled={busy || !computer} />
            </View>
          ) : null}

          {asks.map((ask, i) => (
            <Turn key={ask.id} ask={ask} computer={session.devices.find((d) => d.id === ask.to)} others={online.filter((d) => d.id !== ask.to)} now={now} last={i === asks.length - 1} busy={busy || !computer} onAsk={(q) => void send(q)} />
          ))}

          {error ? <Banner tone="error" message={error} testID="ask-error" /> : null}
        </View>
      </ScrollView>
      {gone && !conversation ? null : (
        <Composer
          value={draft}
          onChange={setDraft}
          onSend={() => void send(draft)}
          placeholder={conversation ? t('Continue this conversation') : asks.length > 0 ? t('Ask a follow-up') : handed ? t('Ask about this page') : t('Ask anything')}
          disabled={!computer}
          busy={busy}
          note={composerNote}
          autoFocus={id === 'new' && Platform.OS !== 'web'}
          keyboardUp={keyboard > 0}
        />
      )}
      <ComputerSheet
        open={picking}
        computers={targets}
        value={computer?.id}
        now={now}
        onPick={(picked) => {
          setTo(picked);
          setPicking(false);
        }}
        onClose={() => setPicking(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
  },
  scroll: {
    flexGrow: 1,
  },
  column: {
    width: '100%',
    maxWidth: Layout.maxWidth,
    alignSelf: 'center',
    paddingHorizontal: Layout.gutter,
    paddingTop: Space.md,
    paddingBottom: Space.xl,
    gap: Space.xxl,
  },
  turn: {
    gap: Space.lg,
  },
  grow: {
    flex: 1,
  },
  center: {
    textAlign: 'center',
  },
  pageCard: {
    borderWidth: 1,
    borderRadius: Radius.lg,
    padding: Space.lg,
    gap: Space.md,
  },
  pageHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.md,
  },
  start: {
    alignSelf: 'flex-start',
  },
  pageAsk: {
    gap: Space.md,
  },
  quote: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.md,
    padding: Space.md,
    borderLeftWidth: 3,
    borderRadius: Radius.sm,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.xs,
  },
  hero: {
    alignItems: 'center',
    gap: Space.md,
    paddingTop: Space.huge,
    paddingHorizontal: Space.lg,
  },
  heroMark: {
    width: 72,
    height: 72,
    borderRadius: 36,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Space.sm,
  },
});
