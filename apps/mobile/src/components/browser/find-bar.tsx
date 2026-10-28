import { useEffect, useState } from 'react';
import { Platform, StyleSheet, TextInput, View, type TextStyle } from 'react-native';

import { IconButton } from '@/components/button';
import { ThemedText } from '@/components/themed-text';
import { Radius, Space, Type } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { t } from '@/lib/i18n';
import { BrowserKit } from '../../../modules/browser-kit';

const NO_OUTLINE = Platform.select<TextStyle>({ web: { outlineStyle: 'none' } as unknown as TextStyle, default: {} });

/** Find in page (Android): the WebView's own search, with the match count and previous / next. */
export function FindBar({ viewTag, onClose }: { viewTag: number; onClose: () => void }) {
  const theme = useTheme();
  const [text, setText] = useState('');
  const [result, setResult] = useState<{ active: number; total: number } | null>(null);

  useEffect(() => {
    const sub = BrowserKit?.addListener('onFindResult', (e) => {
      if (e.viewTag === viewTag && e.done) setResult({ active: e.active, total: e.total });
    });
    return () => {
      sub?.remove();
      void BrowserKit?.clearFind(viewTag);
    };
  }, [viewTag]);

  const search = (next: string): void => {
    setText(next);
    if (!next) setResult(null);
    void BrowserKit?.find(viewTag, next);
  };

  return (
    <View style={[styles.bar, { backgroundColor: theme.surface, borderBottomColor: theme.border }]} testID="find-bar">
      <TextInput
        value={text}
        onChangeText={search}
        autoFocus
        placeholder={t('Find in page')}
        placeholderTextColor={theme.textTertiary}
        selectionColor={theme.accent}
        style={[Type.body, styles.input, { color: theme.text, backgroundColor: theme.field, borderColor: theme.border }, NO_OUTLINE]}
        returnKeyType="search"
        onSubmitEditing={() => void BrowserKit?.findNext(viewTag, true)}
        autoCorrect={false}
        accessibilityLabel={t('Find in page')}
        testID="find-input"
      />
      <ThemedText type="small" themeColor="textSecondary" style={styles.count} testID="find-count">
        {result && text ? (result.total === 0 ? t('No matches') : `${result.active + 1}/${result.total}`) : ''}
      </ThemedText>
      <IconButton icon="chevronUp" accessibilityLabel={t('Previous match')} disabled={!result?.total} onPress={() => void BrowserKit?.findNext(viewTag, false)} />
      <IconButton icon="chevronDown" accessibilityLabel={t('Next match')} disabled={!result?.total} onPress={() => void BrowserKit?.findNext(viewTag, true)} />
      <IconButton icon="close" accessibilityLabel={t('Close')} onPress={onClose} testID="find-close" />
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: Space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  input: {
    flex: 1,
    minHeight: 40,
    paddingHorizontal: Space.md,
    paddingVertical: Space.xs,
    borderRadius: Radius.md,
    borderWidth: 1,
  },
  count: {
    minWidth: 56,
    textAlign: 'center',
  },
});
