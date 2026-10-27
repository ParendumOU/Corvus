import type { AskRecord } from '@corvus/shared';
import { router } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Button, IconButton } from '@/components/button';
import { Card, SectionHeader } from '@/components/card';
import { EmptyState, LoadingState } from '@/components/empty-state';
import { Favicon } from '@/components/favicon';
import { Banner } from '@/components/feedback';
import { ChoiceChips, TextField } from '@/components/fields';
import { Icon } from '@/components/icon';
import { Screen } from '@/components/screen';
import { ThemedText } from '@/components/themed-text';
import { Radius, Space } from '@/constants/theme';
import { askQuestion, forgetAsk, refreshSession, useSession } from '@/hooks/use-session';
import { useTheme } from '@/hooks/use-theme';
import { t } from '@/lib/i18n';
import { answerParts, answering, askStatus } from '@/lib/asks';
import { ago } from '@/lib/format';
import { openInApp } from '@/lib/open-url';
import { tabHost } from '@/lib/replica';
import { sendTargets } from '@/lib/send';

/** How often the screen looks for the answer while a computer is writing it. */
const ANSWER_REFRESH_MS = 2_000;

function AskCard({ ask, deviceName, onFollowUp }: { ask: AskRecord; deviceName: (id: string) => string; onFollowUp: (q: string) => void }) {
  const theme = useTheme();
  const parts = answerParts(ask.answer, ask.sources.length);
  const pending = ask.state === 'waiting' || ask.state === 'answering';
  const statusColor = ask.state === 'error' ? theme.danger : pending ? theme.accentText : theme.textSecondary;
  return (
    <Card testID={`ask-${ask.question}`}>
      <View style={styles.head}>
        <ThemedText type="heading" style={styles.grow}>
          {ask.question}
        </ThemedText>
        <IconButton icon="trash" size={20} accessibilityLabel={t('Remove')} onPress={() => void forgetAsk(ask.id)} testID={`ask-remove-${ask.question}`} />
      </View>
      <View style={styles.status}>
        {pending ? <View style={[styles.pulse, { backgroundColor: theme.accent }]} /> : <Icon name={ask.state === 'error' ? 'warning' : 'checkCircle'} size={16} color={statusColor} />}
        <ThemedText type="small" style={[styles.grow, { color: statusColor }]} testID={`ask-status-${ask.question}`}>
          {askStatus(ask, deviceName)} · {ago(ask.askedAt)}
        </ThemedText>
      </View>
      {ask.answer !== '' && (
        <ThemedText type="body" testID={`ask-answer-${ask.question}`}>
          {parts.map((p, i) =>
            'text' in p ? (
              p.text
            ) : (
              <ThemedText key={i} type="smallStrong" themeColor="accentText" onPress={() => void openInApp(ask.sources[p.cite - 1]!.url)}>
                [{p.cite}]
              </ThemedText>
            ),
          )}
        </ThemedText>
      )}
      {ask.sources.length > 0 && ask.state !== 'waiting' && (
        <View style={[styles.sources, { borderColor: theme.divider }]}>
          {ask.sources.map((s, i) => (
            <Pressable
              key={s.url}
              accessibilityRole="link"
              onPress={() => void openInApp(s.url)}
              android_ripple={{ color: theme.ripple }}
              style={styles.source}
              testID={`ask-source-${s.url}`}>
              <ThemedText type="caption" themeColor="textSecondary" style={styles.sourceNumber}>
                {i + 1}
              </ThemedText>
              <Favicon url={s.url} size={20} />
              <ThemedText type="small" numberOfLines={1} style={styles.grow}>
                {s.title || tabHost(s.url)}
              </ThemedText>
              <Icon name="external" size={16} color={theme.textTertiary} />
            </Pressable>
          ))}
        </View>
      )}
      {ask.followUps.length > 0 && (
        <View style={styles.followUps}>
          {ask.followUps.map((q) => (
            <Pressable
              key={q}
              accessibilityRole="button"
              onPress={() => onFollowUp(q)}
              android_ripple={{ color: theme.ripple }}
              style={[styles.followUp, { borderColor: theme.borderStrong }]}>
              <Icon name="sparkle" size={16} color={theme.accentText} />
              <ThemedText type="small" style={styles.shrink}>
                {q}
              </ThemedText>
            </Pressable>
          ))}
        </View>
      )}
    </Card>
  );
}

/**
 * Ask Corvus: a question goes to one of the computers of the sync chain, which answers it with
 * Corvus's AI search (its own AI provider, nothing to set up on the phone). The answer shows as it
 * is written, with its sources.
 */
export default function AskScreen() {
  const session = useSession();
  const [question, setQuestion] = useState('');
  const [to, setTo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const targets = useMemo(() => sendTargets(session.devices, session.self, session.tabs), [session.devices, session.self, session.tabs]);
  const target = targets.find((d) => d.id === to) ?? targets[0];
  const deviceName = (id: string): string => session.devices.find((d) => d.id === id)?.name ?? t('your computer');
  const pending = answering(session.asks);

  // While a computer answers, look for more of the answer every couple of seconds.
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => void refreshSession(), ANSWER_REFRESH_MS);
    return () => clearInterval(timer);
  }, [pending]);

  const ask = async (text: string): Promise<void> => {
    if (!text.trim() || !target) return;
    setBusy(true);
    setError(null);
    try {
      await askQuestion(text, target.id);
      setQuestion('');
    } catch (err) {
      setError(t('That did not work: {error}', { error: err instanceof Error ? err.message : String(err) }));
    } finally {
      setBusy(false);
    }
  };

  if (session.status === 'unpaired') {
    return (
      <Screen>
        <EmptyState
          icon="sparkle"
          description={t('Pair this phone with your computer first: your computer answers the questions.')}
          action={<Button label={t('Pair with a computer')} icon="scan" onPress={() => router.replace('/pair')} testID="ask-pair" />}
        />
      </Screen>
    );
  }

  return (
    <Screen>
      <Card>
        <TextField
          testID="ask-question"
          label={t('Your question')}
          value={question}
          onChangeText={setQuestion}
          placeholder={t('Ask anything')}
          help={t("Your computer answers with Corvus's AI search, using its own AI provider, while Corvus is open there.")}
          multiline
          lines={3}
          maxLength={1000}
        />
        {targets.length === 0 &&
          (session.refreshed ? (
            <Banner tone="warning" message={t('No computer on this sync chain yet.')} testID="ask-no-computer" />
          ) : (
            <LoadingState testID="ask-no-computer" />
          ))}
        {targets.length > 1 && (
          <ChoiceChips choices={targets.map((d) => ({ key: d.id, label: d.name, icon: 'screen' as const, testID: `ask-to-${d.name}` }))} value={target?.id} onChange={setTo} />
        )}
        <Button
          label={target ? t('Ask {computer}', { computer: target.name }) : t('Ask')}
          icon="send"
          busy={busy}
          disabled={!question.trim() || !target || busy}
          onPress={() => void ask(question)}
          testID="ask-submit"
        />
      </Card>

      {error && <Banner tone="error" message={error} testID="ask-error" />}

      {session.asks.length > 0 && (
        <View style={styles.list}>
          <SectionHeader title={t('Your questions')} />
          {session.asks.map((a) => (
            <AskCard key={a.id} ask={a} deviceName={deviceName} onFollowUp={(q) => void ask(q)} />
          ))}
        </View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  head: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Space.xs,
    marginRight: -Space.sm,
    marginTop: -Space.xs,
  },
  grow: {
    flex: 1,
  },
  shrink: {
    flexShrink: 1,
  },
  status: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.sm,
    marginTop: -Space.sm,
  },
  pulse: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginHorizontal: 4,
  },
  sources: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: Space.xs,
  },
  source: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.md,
    minHeight: 44,
    borderRadius: Radius.sm,
  },
  sourceNumber: {
    width: 14,
    textAlign: 'right',
  },
  followUps: {
    gap: Space.sm,
  },
  followUp: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: Space.sm,
    minHeight: 40,
    paddingHorizontal: Space.md,
    paddingVertical: Space.sm,
    borderWidth: 1,
    borderRadius: Radius.md,
    overflow: 'hidden',
  },
  list: {
    gap: Space.md,
  },
});
