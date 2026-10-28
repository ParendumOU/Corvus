import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Platform, StyleSheet, ToastAndroid, View } from 'react-native';

import { Button } from '@/components/button';
import { Card, CardHeader } from '@/components/card';
import { Favicon } from '@/components/favicon';
import { Banner } from '@/components/feedback';
import { PageActions, actionDoneMessage, type PageAction } from '@/components/page-actions';
import { Screen } from '@/components/screen';
import { ThemedText } from '@/components/themed-text';
import { Space } from '@/constants/theme';
import { useSession } from '@/hooks/use-session';
import { leaveApp, useDefaultBrowser } from '@/lib/default-browser';
import { t } from '@/lib/i18n';
import { webLink } from '@/lib/links';
import { openInBrowser, openIncoming } from '@/lib/open-url';
import { tabHost } from '@/lib/replica';
import { nav } from '@/lib/nav';

/** Leaves the Open screen, so that the app opens on Home next time. */
function close(): void {
  if (router.canGoBack()) router.back();
  else nav.replace('/');
}

/**
 * A web link another app asked Corvus to open, as the phone's browser: open it in the browser app
 * picked in Settings (one tap), or first send it to a computer or keep it.
 */
export default function OpenScreen() {
  const params = useLocalSearchParams<{ url?: string; from?: string }>();
  // "Open in…" from Corvus's own browser: nothing to step back to afterwards.
  const fromBrowser = params.from === 'browser';
  const url = webLink(typeof params.url === 'string' ? params.url : '');
  const session = useSession();
  const browser = useDefaultBrowser();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = async (): Promise<void> => {
    if (!url) return;
    setBusy(true);
    setError(null);
    try {
      if (fromBrowser) {
        await openInBrowser(url);
        close();
      } else if (await openIncoming(url)) close();
    } catch (err) {
      setError(t('That did not work: {error}', { error: err instanceof Error ? err.message : String(err) }));
    } finally {
      setBusy(false);
    }
  };

  // Once the page is sent or kept, say so and step back to the app the link came from (the
  // system's toast, which stays on screen after Corvus leaves).
  const done = (action: PageAction, computer: string): void => {
    if (Platform.OS === 'android') ToastAndroid.show(actionDoneMessage(action, computer), ToastAndroid.SHORT);
    close();
    if (!fromBrowser) void leaveApp();
  };

  const name = browser.browser?.label;
  return (
    <Screen>
      <Card testID="open-card">
        {url ? (
          <View style={styles.page}>
            <Favicon url={url} size={40} />
            <View style={styles.grow}>
              <ThemedText type="heading" numberOfLines={1}>
                {tabHost(url) || url}
              </ThemedText>
              <ThemedText type="small" themeColor="textSecondary" numberOfLines={3} selectable testID="open-url">
                {url}
              </ThemedText>
            </View>
          </View>
        ) : (
          <CardHeader title={t('That is not a web address.')} />
        )}
        <Button
          label={name ? t('Open in {browser}', { browser: name }) : t('Open')}
          icon="external"
          busy={busy}
          disabled={!url || busy}
          onPress={() => void open()}
          testID="open-submit"
        />
        {error && <Banner tone="error" message={error} testID="open-error" />}
      </Card>

      {session.status === 'unpaired' && (
        <Banner
          message={t('Pair this phone with your computer to also send links to it, or save them to your reading list and bookmarks.')}
          testID="open-unpaired"
          action={<Button label={t('Pair with a computer')} kind="text" size="sm" icon="scan" onPress={() => nav.replace('/pair')} testID="open-pair" />}
        />
      )}

      {session.status === 'paired' && <PageActions url={url} title="" brief onDone={done} />}
    </Screen>
  );
}

const styles = StyleSheet.create({
  page: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.md,
  },
  grow: {
    flex: 1,
    gap: 2,
  },
});
