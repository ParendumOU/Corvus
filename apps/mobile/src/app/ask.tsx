import type { AskRecord } from '@corvus/shared';
import { router } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';

import { ACCENT, Button } from '@/components/button';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { MaxContentWidth, Spacing } from '@/constants/theme';
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
  return (
    <ThemedView type="backgroundElement" style={styles.card} testID={`ask-${ask.question}`}>
      <ThemedText type="smallBold">{ask.question}</ThemedText>
      <ThemedText type="small" themeColor="textSecondary" testID={`ask-status-${ask.question}`}>
        {askStatus(ask, deviceName)} · {ago(ask.askedAt)}
      </ThemedText>
      {ask.answer !== '' && (
        <ThemedText testID={`ask-answer-${ask.question}`}>
          {parts.map((p, i) =>
            'text' in p ? (
              p.text
            ) : (
              <ThemedText key={i} type="small" style={styles.cite} onPress={() => void openInApp(ask.sources[p.cite - 1]!.url)}>
                [{p.cite}]
              </ThemedText>
            ),
          )}
        </ThemedText>
      )}
      {ask.sources.length > 0 && ask.state !== 'waiting' && (
        <View style={styles.sources}>
          {ask.sources.map((s, i) => (
            <Pressable
              key={s.url}
              accessibilityRole="link"
              onPress={() => void openInApp(s.url)}
              style={({ pressed }) => [styles.source, pressed && { backgroundColor: theme.backgroundSelected }]}
              testID={`ask-source-${s.url}`}>
              <ThemedText type="small" themeColor="textSecondary">
                {i + 1}.
              </ThemedText>
              <ThemedText type="small" numberOfLines={1} style={styles.grow}>
                {s.title || tabHost(s.url)}
              </ThemedText>
            </Pressable>
          ))}
        </View>
      )}
      {ask.followUps.length > 0 && (
        <View style={styles.chips}>
          {ask.followUps.map((q) => (
            <Pressable key={q} accessibilityRole="button" onPress={() => onFollowUp(q)} style={[styles.chip, { borderColor: theme.backgroundSelected }]}>
              <ThemedText type="small">{q}</ThemedText>
            </Pressable>
          ))}
        </View>
      )}
      <Pressable accessibilityRole="button" onPress={() => void forgetAsk(ask.id)} hitSlop={8} style={styles.remove} testID={`ask-remove-${ask.question}`}>
        <ThemedText type="smallBold" themeColor="textSecondary">
          {t('Remove')}
        </ThemedText>
      </Pressable>
    </ThemedView>
  );
}

/**
 * Ask Corvus: a question goes to one of the computers of the sync chain, which answers it with
 * Corvus's AI search (its own AI provider, nothing to set up on the phone). The answer shows as it
 * is written, with its sources.
 */
export default function AskScreen() {
  const theme = useTheme();
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
      <ThemedView style={styles.container}>
        <View style={styles.content}>
          <ThemedText type="small" themeColor="textSecondary">
            {t('Pair this phone with your computer first: your computer answers the questions.')}
          </ThemedText>
          <Button label={t('Pair with a computer')} onPress={() => router.replace('/pair')} testID="ask-pair" />
        </View>
      </ThemedView>
    );
  }

  return (
    <ThemedView style={styles.container}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <ThemedView type="backgroundElement" style={styles.card}>
          <TextInput
            testID="ask-question"
            style={[styles.input, { color: theme.text, backgroundColor: theme.background }]}
            value={question}
            onChangeText={setQuestion}
            placeholder={t('Ask anything')}
            placeholderTextColor={theme.textSecondary}
            multiline
            maxLength={1000}
          />
          <ThemedText type="small" themeColor="textSecondary">
            {t("Your computer answers with Corvus's AI search, using its own AI provider, while Corvus is open there.")}
          </ThemedText>
          {targets.length === 0 && (
            <ThemedText type="small" themeColor="textSecondary" testID="ask-no-computer">
              {session.refreshed ? t('No computer on this sync chain yet.') : t('Loading…')}
            </ThemedText>
          )}
          {targets.length > 1 && (
            <View style={styles.chips}>
              {targets.map((d) => {
                const chosen = d.id === target?.id;
                return (
                  <Pressable
                    key={d.id}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: chosen }}
                    onPress={() => setTo(d.id)}
                    style={[styles.chip, { borderColor: chosen ? ACCENT : theme.backgroundSelected, backgroundColor: chosen ? ACCENT : 'transparent' }]}
                    testID={`ask-to-${d.name}`}>
                    <ThemedText type="small" style={chosen ? styles.chosen : undefined}>
                      {d.name}
                    </ThemedText>
                  </Pressable>
                );
              })}
            </View>
          )}
          <Button
            label={target ? t('Ask {computer}', { computer: target.name }) : t('Ask')}
            busy={busy}
            disabled={!question.trim() || !target || busy}
            onPress={() => void ask(question)}
            testID="ask-submit"
          />
        </ThemedView>

        {error && (
          <ThemedText type="small" style={styles.error} testID="ask-error">
            {error}
          </ThemedText>
        )}

        {session.asks.map((a) => (
          <AskCard key={a.id} ask={a} deviceName={deviceName} onFollowUp={(q) => void ask(q)} />
        ))}
      </ScrollView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    padding: Spacing.four,
    gap: Spacing.three,
    maxWidth: MaxContentWidth,
    width: '100%',
    alignSelf: 'center',
  },
  card: {
    gap: Spacing.two,
    padding: Spacing.four,
    borderRadius: Spacing.four,
  },
  input: {
    minHeight: 80,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    borderRadius: Spacing.two,
    fontSize: 16,
    textAlignVertical: 'top',
  },
  cite: {
    color: ACCENT,
  },
  sources: {
    gap: Spacing.half,
  },
  source: {
    flexDirection: 'row',
    gap: Spacing.two,
    paddingVertical: Spacing.one,
    borderRadius: Spacing.one,
  },
  grow: {
    flex: 1,
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
  },
  chip: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.one,
  },
  chosen: {
    color: '#ffffff',
  },
  remove: {
    alignSelf: 'flex-end',
  },
  error: {
    color: '#D93025',
  },
});
