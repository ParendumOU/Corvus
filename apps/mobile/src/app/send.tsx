import { normalizeSentUrl } from '@corvus/shared';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';

import { Button } from '@/components/button';
import { Card } from '@/components/card';
import { EmptyState } from '@/components/empty-state';
import { showToast } from '@/components/feedback';
import { TextField } from '@/components/fields';
import { PageActions, actionDoneMessage, type PageAction } from '@/components/page-actions';
import { Screen } from '@/components/screen';
import { useSession } from '@/hooks/use-session';
import { useSharedText } from '@/hooks/use-shared-text';
import { t } from '@/lib/i18n';
import { nav } from '@/lib/nav';

/**
 * A page typed here, or shared to Corvus from another app (Android share sheet): send it to a
 * computer, save it to the reading list, or bookmark it.
 */
export default function SendScreen() {
  const session = useSession();
  const { text: shared, clear: clearShared } = useSharedText();
  const [text, setText] = useState(shared);
  const [title, setTitle] = useState('');

  // The share can arrive after the screen opened (the app was already running).
  useEffect(() => {
    if (shared) setText(shared);
  }, [shared]);

  const url = normalizeSentUrl(text);

  const done = (action: PageAction, computer: string): void => {
    clearShared();
    showToast(actionDoneMessage(action, computer));
    if (action === 'watch') nav.replace('/watches');
    else if (router.canGoBack()) router.back();
    else nav.replace(action === 'send' ? '/' : '/library');
  };

  if (session.status === 'unpaired') {
    return (
      <Screen>
        <EmptyState
          icon="send"
          description={t('Pair this phone with your computer first, then share the page again.')}
          action={<Button label={t('Pair with a computer')} icon="scan" onPress={() => nav.replace('/pair')} testID="send-pair" />}
        />
      </Screen>
    );
  }

  return (
    <Screen>
      <Card>
        <TextField
          testID="send-url"
          label={t('Page address')}
          value={text}
          onChangeText={setText}
          placeholder="https://example.com/article"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          multiline
          lines={2}
          error={text.trim() !== '' && !url ? t('That is not a web address.') : null}
        />
        <TextField testID="send-title" label={t('Title (optional)')} value={title} onChangeText={setTitle} />
      </Card>

      <PageActions url={url} title={title} onDone={done} />
    </Screen>
  );
}
