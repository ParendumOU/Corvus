import { normalizeSentUrl } from '@corvus/shared';
import { router } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';

import { ACCENT, Button } from '@/components/button';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { sendToComputer, useSession } from '@/hooks/use-session';
import { useSharedText } from '@/hooks/use-shared-text';
import { useTheme } from '@/hooks/use-theme';
import { sendTargets } from '@/lib/send';

/** Send a page to a computer: typed here, or shared to Corvus from another app (Android share sheet). */
export default function SendScreen() {
  const theme = useTheme();
  const session = useSession();
  const { text: shared, clear: clearShared } = useSharedText();
  const [text, setText] = useState(shared);
  const [to, setTo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The share can arrive after the screen opened (the app was already running).
  useEffect(() => {
    if (shared) setText(shared);
  }, [shared]);

  const targets = useMemo(() => sendTargets(session.devices, session.self, session.tabs), [session.devices, session.self, session.tabs]);
  const target = targets.find((d) => d.id === to) ?? targets[0];
  const url = normalizeSentUrl(text);

  const send = async (): Promise<void> => {
    if (!url || !target) return;
    setBusy(true);
    setError(null);
    try {
      await sendToComputer({ url, title: '', to: target.id });
      clearShared();
      if (router.canGoBack()) router.back();
      else router.replace('/');
    } catch (err) {
      setError(`Could not send it: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  if (session.status === 'unpaired') {
    return (
      <ThemedView style={styles.container}>
        <View style={styles.content}>
          <ThemedText type="small" themeColor="textSecondary">
            Pair this phone with your computer first, then share the page again.
          </ThemedText>
          <Button label="Pair with a computer" onPress={() => router.replace('/pair')} testID="send-pair" />
        </View>
      </ThemedView>
    );
  }

  return (
    <ThemedView style={styles.container}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <ThemedText type="small" themeColor="textSecondary">
          The page opens in a new tab on your computer the next time Corvus there syncs (within a minute while it is running).
        </ThemedText>

        <ThemedView type="backgroundElement" style={styles.card}>
          <ThemedText type="smallBold">Page</ThemedText>
          <TextInput
            testID="send-url"
            style={[styles.input, { color: theme.text, backgroundColor: theme.background }]}
            value={text}
            onChangeText={setText}
            placeholder="https://example.com/article"
            placeholderTextColor={theme.textSecondary}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            multiline
          />
          {text.trim() !== '' && !url && (
            <ThemedText type="small" style={styles.error}>
              That is not a web address.
            </ThemedText>
          )}
        </ThemedView>

        <ThemedView type="backgroundElement" style={styles.card}>
          <ThemedText type="smallBold">Computer</ThemedText>
          {targets.length === 0 && (
            <ThemedText type="small" themeColor="textSecondary" testID="send-no-computer">
              {session.refreshed ? 'No computer on this sync chain yet.' : 'Loading…'}
            </ThemedText>
          )}
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
                  testID={`send-to-${d.name}`}>
                  <ThemedText type="small" style={chosen ? styles.chosen : undefined}>
                    {d.name}
                  </ThemedText>
                </Pressable>
              );
            })}
          </View>
        </ThemedView>

        <Button label={target ? `Send to ${target.name}` : 'Send'} busy={busy} disabled={!url || !target} onPress={() => void send()} testID="send-submit" />

        {error && (
          <ThemedText type="small" style={styles.error} testID="send-error">
            {error}
          </ThemedText>
        )}
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
    minHeight: 64,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    borderRadius: Spacing.two,
    fontSize: 16,
    textAlignVertical: 'top',
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
  error: {
    color: '#D93025',
  },
});
