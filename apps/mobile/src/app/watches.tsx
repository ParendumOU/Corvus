import { normalizeSentUrl } from '@corvus/shared';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button } from '@/components/button';
import { Card, CardHeader, SectionHeader } from '@/components/card';
import { EmptyState, LoadingState } from '@/components/empty-state';
import { Favicon } from '@/components/favicon';
import { Badge, Banner } from '@/components/feedback';
import { SegmentedControl, TextField } from '@/components/fields';
import { Icon } from '@/components/icon';
import { ListRow } from '@/components/list';
import { Screen } from '@/components/screen';
import { ThemedText } from '@/components/themed-text';
import { Space } from '@/constants/theme';
import { refreshSession, useSession, watch } from '@/hooks/use-session';
import { useTheme } from '@/hooks/use-theme';
import { t } from '@/lib/i18n';
import { ago } from '@/lib/format';
import { openInApp, openInBrowser } from '@/lib/open-url';
import { tabHost } from '@/lib/replica';
import { INTERVAL_CHOICES, describeInterval, shortInterval, type WatchView } from '@/lib/watches';

function ConditionState({ w }: { w: WatchView }) {
  if (!w.condition) return null;
  const met = w.status?.conditionMet;
  const state = met === true ? t('Yes') : met === false ? t('Not yet') : t('Not known yet');
  return (
    <View style={styles.condition} testID={`watch-condition-${w.url}`}>
      <ThemedText type="small" themeColor="textSecondary" style={styles.grow}>
        {t('Notify me when {condition}', { condition: w.condition })}
        {w.status?.conditionDetail ? ` (${w.status.conditionDetail})` : ''}
      </ThemedText>
      <Badge label={state} tone={met === true ? 'success' : 'neutral'} />
    </View>
  );
}

function WatchCard({ w }: { w: WatchView }) {
  const theme = useTheme();
  const s = w.status;
  const checked = w.paused
    ? t('Paused')
    : s?.lastCheckedAt
      ? t('Checked {when} by {computer}', { when: ago(s.lastCheckedAt), computer: s.device })
      : t('Not checked yet: a computer with Corvus checks it soon');
  return (
    <Card padded={false} testID={`watch-${w.url}`}>
      <ListRow
        leading={<Favicon url={w.url} />}
        title={
          <ThemedText type="bodyStrong" numberOfLines={2}>
            {w.title && w.title !== w.url ? w.title : tabHost(w.url)}
          </ThemedText>
        }
        subtitle={`${tabHost(w.url)} · ${describeInterval(w.intervalMinutes)}`}
        accessibilityRole="link"
        accessibilityHint={t('Opens the page. Long press to open it in your browser app.')}
        onPress={() => void openInApp(w.url)}
        onLongPress={() => void openInBrowser(w.url)}
      />
      <View style={styles.body}>
        <ConditionState w={w} />
        {s?.lastChangedAt ? (
          <View style={[styles.change, { borderLeftColor: theme.accent }]} testID={`watch-change-${w.url}`}>
            <ThemedText type="caption" themeColor="accentText">
              {t('Changed {when}', { when: ago(s.lastChangedAt) })}
            </ThemedText>
            {s.summary ? <ThemedText type="small">{s.summary}</ThemedText> : null}
          </View>
        ) : null}
        {s?.result === 'error' && s.error ? <Banner tone="error" message={t('Could not check it: {error}', { error: s.error })} /> : null}
        <View style={styles.checked}>
          <Icon name="clock" size={14} color={theme.textTertiary} />
          <ThemedText type="caption" themeColor="textTertiary" style={styles.grow}>
            {checked}
          </ThemedText>
        </View>
      </View>
    </Card>
  );
}

/** Pages the computers watch for changes, and a form to watch one more. */
export default function WatchesScreen() {
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
      setError(t('Could not add it: {error}', { error: err instanceof Error ? err.message : String(err) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen refreshing={session.refreshing} onRefresh={() => void refreshSession()}>
      <Card>
        <CardHeader
          title={t('Watch a page')}
          description={t('Your computers check it and tell you when it changes, or only when your condition comes true (“the price is under 100”).')}
        />
        <TextField
          testID="watch-url"
          label={t('Page address')}
          value={text}
          onChangeText={setText}
          placeholder="https://shop.example/item"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          error={text.trim() !== '' && !url ? t('That is not a web address.') : null}
        />
        <TextField testID="watch-condition" label={t('Notify me when… (optional)')} value={condition} onChangeText={setCondition} placeholder={t('the price is under 100')} />
        <View style={styles.field}>
          <ThemedText type="smallStrong" themeColor="textSecondary">
            {t('Check it every')}
          </ThemedText>
          <SegmentedControl
            choices={INTERVAL_CHOICES.map((m) => ({ key: m, label: shortInterval(m), accessibilityLabel: describeInterval(m), testID: `watch-every-${m}` }))}
            value={every}
            onChange={setEvery}
          />
        </View>
        <Button label={t('Watch this page')} icon="eye" busy={busy} disabled={!url || busy} onPress={() => void add()} testID="watch-add" />
        {error && <Banner tone="error" message={error} />}
      </Card>

      {session.watches.length === 0 ? (
        session.refreshed ? (
          <EmptyState icon="eye" description={t('No watched pages yet.')} compact testID="watches-empty" />
        ) : (
          <LoadingState testID="watches-empty" />
        )
      ) : (
        <View style={styles.list}>
          <SectionHeader title={t('Watching')} trailing={<ThemedText type="caption" themeColor="textSecondary">{session.watches.length}</ThemedText>} />
          {session.watches.map((w) => (
            <WatchCard key={w.url} w={w} />
          ))}
        </View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  grow: {
    flex: 1,
  },
  field: {
    gap: Space.xs + 2,
  },
  body: {
    gap: Space.md,
    paddingHorizontal: Space.lg,
    paddingBottom: Space.lg,
  },
  condition: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Space.sm,
  },
  change: {
    gap: 2,
    borderLeftWidth: 3,
    paddingLeft: Space.md,
  },
  checked: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.xs + 2,
  },
  list: {
    gap: Space.md,
  },
});
