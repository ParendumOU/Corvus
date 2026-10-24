import { normalizeSentUrl } from '@corvus/shared';
import { router } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';

import { ACCENT, Button } from '@/components/button';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { bookmarkPage, saveToReadingList, sendToComputer, useSession, watch } from '@/hooks/use-session';
import { useSharedText } from '@/hooks/use-shared-text';
import { useTheme } from '@/hooks/use-theme';
import { tabHost } from '@/lib/replica';
import { sendTargets } from '@/lib/send';

type Action = 'send' | 'read-later' | 'bookmark' | 'watch';

/**
 * A page typed here, or shared to Corvus from another app (Android share sheet): send it to a
 * computer, save it to the reading list, or bookmark it.
 */
export default function SendScreen() {
  const theme = useTheme();
  const session = useSession();
  const { text: shared, clear: clearShared } = useSharedText();
  const [text, setText] = useState(shared);
  const [title, setTitle] = useState('');
  const [to, setTo] = useState<string | null>(null);
  const [busy, setBusy] = useState<Action | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The share can arrive after the screen opened (the app was already running).
  useEffect(() => {
    if (shared) setText(shared);
  }, [shared]);

  const targets = useMemo(() => sendTargets(session.devices, session.self, session.tabs), [session.devices, session.self, session.tabs]);
  const target = targets.find((d) => d.id === to) ?? targets[0];
  const url = normalizeSentUrl(text);

  const run = async (action: Action): Promise<void> => {
    if (!url) return;
    setBusy(action);
    setError(null);
    try {
      if (action === 'send' && target) await sendToComputer({ url, title: title.trim(), to: target.id });
      if (action === 'read-later') await saveToReadingList(url, title.trim());
      if (action === 'bookmark') await bookmarkPage(url, title.trim() || tabHost(url));
      if (action === 'watch') await watch(url, title.trim(), 60, '');
      clearShared();
      if (action === 'watch') router.replace('/watches');
      else if (router.canGoBack()) router.back();
      else router.replace(action === 'send' ? '/' : '/library');
    } catch (err) {
      setError(`That did not work: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
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
          <TextInput
            testID="send-title"
            style={[styles.input, styles.title, { color: theme.text, backgroundColor: theme.background }]}
            value={title}
            onChangeText={setTitle}
            placeholder="Title (optional)"
            placeholderTextColor={theme.textSecondary}
          />
        </ThemedView>

        <ThemedView type="backgroundElement" style={styles.card}>
          <ThemedText type="smallBold">Send to a computer</ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            It opens in a new tab there the next time Corvus syncs (within a minute while it is running).
          </ThemedText>
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
          <Button
            label={target ? `Send to ${target.name}` : 'Send'}
            busy={busy === 'send'}
            disabled={!url || !target || busy !== null}
            onPress={() => void run('send')}
            testID="send-submit"
          />
        </ThemedView>

        <ThemedView type="backgroundElement" style={styles.card}>
          <ThemedText type="smallBold">Keep it</ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            Saved on every device. For the reading list, a computer with Corvus fetches the article.
          </ThemedText>
          <Button
            label="Save to reading list"
            kind="secondary"
            busy={busy === 'read-later'}
            disabled={!url || busy !== null}
            onPress={() => void run('read-later')}
            testID="send-read-later"
          />
          <Button label="Bookmark" kind="secondary" busy={busy === 'bookmark'} disabled={!url || busy !== null} onPress={() => void run('bookmark')} testID="send-bookmark" />
          <Button
            label="Watch for changes"
            kind="secondary"
            busy={busy === 'watch'}
            disabled={!url || busy !== null}
            onPress={() => void run('watch')}
            testID="send-watch"
          />
        </ThemedView>

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
  title: {
    minHeight: 44,
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
