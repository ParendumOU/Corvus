import { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button } from '@/components/button';
import { Card, CardHeader, SectionHeader } from '@/components/card';
import { LoadingState } from '@/components/empty-state';
import { Banner } from '@/components/feedback';
import { ChoiceChips } from '@/components/fields';
import { ActionRow, ListGroup } from '@/components/list';
import { Space } from '@/constants/theme';
import { bookmarkPage, saveToReadingList, sendToComputer, useSession, watch } from '@/hooks/use-session';
import { t } from '@/lib/i18n';
import { tabHost } from '@/lib/replica';
import { sendTargets } from '@/lib/send';

export type PageAction = 'send' | 'read-later' | 'bookmark' | 'watch';

/** What to say once an action worked ("Sent to Demo laptop"). */
export function actionDoneMessage(action: PageAction, computer: string): string {
  if (action === 'send') return t('Sent to {computer}', { computer });
  if (action === 'read-later') return t('Saved to your reading list');
  if (action === 'bookmark') return t('Bookmarked');
  return t('Watching it for changes');
}

/**
 * What can be done with a page from the phone: send it to a computer, or keep it (reading list,
 * bookmark, watch). The Save or send screen and the Open screen (links Corvus opens as the
 * browser) share it; `brief` leaves out the explanations.
 */
export function PageActions({
  url,
  title,
  brief = false,
  onDone,
}: {
  url: string | null;
  title: string;
  brief?: boolean;
  /** After an action worked; `computer` is where the page was sent. */
  onDone: (action: PageAction, computer: string) => void;
}) {
  const session = useSession();
  const [to, setTo] = useState<string | null>(null);
  const [busy, setBusy] = useState<PageAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const targets = useMemo(() => sendTargets(session.devices, session.self, session.tabs), [session.devices, session.self, session.tabs]);
  const target = targets.find((d) => d.id === to) ?? targets[0];

  const run = async (action: PageAction): Promise<void> => {
    if (!url) return;
    setBusy(action);
    setError(null);
    try {
      if (action === 'send' && target) await sendToComputer({ url, title: title.trim(), to: target.id });
      if (action === 'read-later') await saveToReadingList(url, title.trim());
      if (action === 'bookmark') await bookmarkPage(url, title.trim() || tabHost(url));
      if (action === 'watch') await watch(url, title.trim(), 60, '');
      onDone(action, target?.name ?? '');
    } catch (err) {
      setError(t('That did not work: {error}', { error: err instanceof Error ? err.message : String(err) }));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <Card>
        <CardHeader
          title={t('Send to a computer')}
          description={brief ? undefined : t('It opens in a new tab there the next time Corvus syncs (within a minute while it is running).')}
        />
        {targets.length === 0 &&
          (session.refreshed ? (
            <Banner tone="warning" message={t('No computer on this sync chain yet.')} testID="send-no-computer" />
          ) : (
            <LoadingState testID="send-no-computer" />
          ))}
        {targets.length > 0 && (
          <ChoiceChips choices={targets.map((d) => ({ key: d.id, label: d.name, icon: 'screen' as const, testID: `send-to-${d.name}` }))} value={target?.id} onChange={setTo} />
        )}
        <Button
          label={target ? t('Send to {computer}', { computer: target.name }) : t('Send')}
          kind={brief ? 'tonal' : 'primary'}
          icon="send"
          busy={busy === 'send'}
          disabled={!url || !target || busy !== null}
          onPress={() => void run('send')}
          testID="send-submit"
        />
      </Card>

      <View style={styles.keep}>
        <SectionHeader title={t('Keep it')} />
        {brief ? null : (
          <View style={styles.note}>
            <CardHeader description={t('Saved on every device. For the reading list, a computer with Corvus fetches the article.')} />
          </View>
        )}
        <ListGroup>
          <ActionRow icon="book" label={t('Save to reading list')} busy={busy === 'read-later'} disabled={!url || busy !== null} onPress={() => void run('read-later')} testID="send-read-later" />
          <ActionRow icon="star" label={t('Bookmark')} busy={busy === 'bookmark'} disabled={!url || busy !== null} onPress={() => void run('bookmark')} testID="send-bookmark" />
          <ActionRow icon="eye" label={t('Watch for changes')} busy={busy === 'watch'} disabled={!url || busy !== null} onPress={() => void run('watch')} testID="send-watch" />
        </ListGroup>
      </View>

      {error && <Banner tone="error" message={error} testID="send-error" />}
    </>
  );
}

const styles = StyleSheet.create({
  keep: {
    gap: Space.sm,
  },
  note: {
    paddingHorizontal: Space.lg,
    marginTop: -Space.xs,
  },
});
