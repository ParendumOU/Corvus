import { normalizeSentUrl } from '@corvus/shared';
import { useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, TextInput, View } from 'react-native';

import { ACCENT, Button } from '@/components/button';
import { Favicon } from '@/components/favicon';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { refreshSession, useSession, watch } from '@/hooks/use-session';
import { useTheme } from '@/hooks/use-theme';
import { ago } from '@/lib/format';
import { openInApp, openInBrowser } from '@/lib/open-url';
import { tabHost } from '@/lib/replica';
import { INTERVAL_CHOICES, describeInterval, type WatchView } from '@/lib/watches';

function ConditionState({ w }: { w: WatchView }) {
  if (!w.condition) return null;
  const met = w.status?.conditionMet;
  const state = met === true ? 'Yes' : met === false ? 'Not yet' : 'Not known yet';
  return (
    <ThemedText type="small" themeColor="textSecondary" testID={`watch-condition-${w.url}`}>
      Notify me when {w.condition} · <ThemedText type="smallBold" style={met === true ? styles.met : undefined}>{state}</ThemedText>
      {w.status?.conditionDetail ? ` (${w.status.conditionDetail})` : ''}
    </ThemedText>
  );
}

function WatchCard({ w }: { w: WatchView }) {
  const s = w.status;
  const checked = w.paused ? 'Paused' : s?.lastCheckedAt ? `Checked ${ago(s.lastCheckedAt)} by ${s.device}` : 'Not checked yet: a computer with Corvus checks it soon';
  return (
    <ThemedView type="backgroundElement" style={styles.card} testID={`watch-${w.url}`}>
      <Pressable accessibilityRole="link" onPress={() => void openInApp(w.url)} onLongPress={() => void openInBrowser(w.url)} style={styles.head}>
        <Favicon url={w.url} />
        <View style={styles.grow}>
          <ThemedText type="smallBold" numberOfLines={2}>
            {w.title && w.title !== w.url ? w.title : tabHost(w.url)}
          </ThemedText>
          <ThemedText type="small" themeColor="textSecondary" numberOfLines={1}>
            {tabHost(w.url)} · {describeInterval(w.intervalMinutes)}
          </ThemedText>
        </View>
      </Pressable>
      <ConditionState w={w} />
      {s?.lastChangedAt ? (
        <ThemedText type="small" testID={`watch-change-${w.url}`}>
          Changed {ago(s.lastChangedAt)}
          {s.summary ? `: ${s.summary}` : ''}
        </ThemedText>
      ) : null}
      {s?.result === 'error' && s.error ? (
        <ThemedText type="small" style={styles.error}>
          Could not check it: {s.error}
        </ThemedText>
      ) : null}
      <ThemedText type="small" themeColor="textSecondary">
        {checked}
      </ThemedText>
    </ThemedView>
  );
}

/** Pages the computers watch for changes, and a form to watch one more. */
export default function WatchesScreen() {
  const theme = useTheme();
  const session = useSession();
  const [text, setText] = useState('');
  const [condition, setCondition] = useState('');
  const [every, setEvery] = useState(60);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const url = normalizeSentUrl(text);

  const add = async (): Promise<void> => {
    if (!url) return;
    setBusy(true);
    setError(null);
    try {
      await watch(url, '', every, condition);
      setText('');
      setCondition('');
    } catch (err) {
      setError(`Could not add it: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const input = [styles.input, { color: theme.text, backgroundColor: theme.background }];
  return (
    <ThemedView style={styles.container}>
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={session.refreshing} onRefresh={() => void refreshSession()} />}>
        <ThemedView type="backgroundElement" style={styles.card}>
          <ThemedText type="smallBold">Watch a page</ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            Your computers check it and tell you when it changes, or only when your condition comes true (“the price is under 100”).
          </ThemedText>
          <TextInput
            testID="watch-url"
            style={input}
            value={text}
            onChangeText={setText}
            placeholder="https://shop.example/item"
            placeholderTextColor={theme.textSecondary}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
          />
          <TextInput
            testID="watch-condition"
            style={input}
            value={condition}
            onChangeText={setCondition}
            placeholder="Notify me when… (optional)"
            placeholderTextColor={theme.textSecondary}
          />
          <View style={styles.chips}>
            {INTERVAL_CHOICES.map((m) => (
              <Pressable
                key={m}
                accessibilityRole="radio"
                accessibilityState={{ checked: m === every }}
                onPress={() => setEvery(m)}
                style={[styles.chip, { borderColor: m === every ? ACCENT : theme.backgroundSelected, backgroundColor: m === every ? ACCENT : 'transparent' }]}
                testID={`watch-every-${m}`}>
                <ThemedText type="small" style={m === every ? styles.chosen : undefined}>
                  {describeInterval(m)}
                </ThemedText>
              </Pressable>
            ))}
          </View>
          <Button label="Watch this page" busy={busy} disabled={!url || busy} onPress={() => void add()} testID="watch-add" />
          {error && (
            <ThemedText type="small" style={styles.error}>
              {error}
            </ThemedText>
          )}
        </ThemedView>

        {session.watches.length === 0 && (
          <ThemedText type="small" themeColor="textSecondary" style={styles.center} testID="watches-empty">
            {session.refreshed ? 'No watched pages yet.' : 'Loading…'}
          </ThemedText>
        )}
        {session.watches.map((w) => (
          <WatchCard key={w.url} w={w} />
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
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
  },
  grow: {
    flex: 1,
  },
  input: {
    minHeight: 44,
    paddingHorizontal: Spacing.three,
    borderRadius: Spacing.two,
    fontSize: 16,
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
  met: {
    color: '#188038',
  },
  error: {
    color: '#D93025',
  },
  center: {
    textAlign: 'center',
  },
});
