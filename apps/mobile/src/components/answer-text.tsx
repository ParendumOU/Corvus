import { Fragment, type ReactNode } from 'react';
import { Platform, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Radius, Space, Type } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { openInApp } from '@/lib/open-url';
import { t } from '@/lib/i18n';
import { markdownBlocks, markdownInline, type Inline } from '@/lib/markdown';

/**
 * An answer written in Markdown, drawn with the app's type: paragraphs, headings, bulleted and
 * numbered lists, quotes, code blocks, and inside them **bold**, *italics*, `code`, links and [n]
 * citations of `sources` (tapping one opens its page). Enough for Corvus's answers without a
 * Markdown library. `streaming` ends the text with a caret while the computer is still writing.
 */
export function AnswerText({
  text,
  sources = [],
  streaming,
  testID,
}: {
  text: string;
  sources?: readonly { url: string; title: string }[];
  streaming?: boolean;
  testID?: string;
}) {
  const theme = useTheme();
  const blocks = markdownBlocks(text);
  const caret = streaming ? (
    <ThemedText type="body" style={{ color: theme.accent }}>
      {' ▍'}
    </ThemedText>
  ) : null;

  const inline = (raw: string, last: boolean, strong?: boolean): ReactNode => (
    <>
      {markdownInline(raw, sources.length).map((part, i) => (
        <Fragment key={i}>{span(part, theme, sources, strong)}</Fragment>
      ))}
      {last ? caret : null}
    </>
  );

  return (
    <View style={styles.answer} testID={testID}>
      {blocks.map((block, b) => {
        const last = b === blocks.length - 1;
        switch (block.kind) {
          case 'heading':
            return (
              <ThemedText key={b} type="heading" accessibilityRole="header">
                {inline(block.text, last, true)}
              </ThemedText>
            );
          case 'list':
            return (
              <View key={b} style={styles.list}>
                {block.items.map((item, i) => (
                  <View key={i} style={styles.item}>
                    <ThemedText type="body" themeColor="textSecondary" style={styles.marker}>
                      {block.ordered ? `${block.start + i}.` : '•'}
                    </ThemedText>
                    <ThemedText type="body" style={styles.grow}>
                      {inline(item, last && i === block.items.length - 1)}
                    </ThemedText>
                  </View>
                ))}
              </View>
            );
          case 'quote':
            return (
              <View key={b} style={[styles.quote, { borderLeftColor: theme.borderStrong }]}>
                <ThemedText type="body" themeColor="textSecondary">
                  {inline(block.text, last)}
                </ThemedText>
              </View>
            );
          case 'code':
            return (
              <View key={b} style={[styles.code, { backgroundColor: theme.field, borderColor: theme.border }]}>
                <ThemedText type="code" selectable>
                  {block.text}
                </ThemedText>
                {last ? caret : null}
              </View>
            );
          default:
            return (
              <ThemedText key={b} type="body" selectable={Platform.OS !== 'web'}>
                {inline(block.text, last)}
              </ThemedText>
            );
        }
      })}
      {blocks.length === 0 && caret ? <ThemedText type="body">{caret}</ThemedText> : null}
    </View>
  );
}

function span(part: Inline, theme: ReturnType<typeof useTheme>, sources: readonly { url: string; title: string }[], strong?: boolean): ReactNode {
  switch (part.kind) {
    case 'bold':
      return <ThemedText type="bodyStrong" style={styles.bold}>{part.text}</ThemedText>;
    case 'italic':
      return <ThemedText type={strong ? 'heading' : 'body'} style={styles.italic}>{part.text}</ThemedText>;
    case 'code':
      return (
        <ThemedText type="code" style={[styles.inlineCode, { backgroundColor: theme.field }]}>
          {part.text}
        </ThemedText>
      );
    case 'link':
      return (
        <ThemedText type={strong ? 'heading' : 'body'} themeColor="accentText" style={styles.underline} accessibilityRole="link" onPress={() => void openInApp(part.url)}>
          {part.text}
        </ThemedText>
      );
    case 'cite': {
      const source = sources[part.n - 1];
      return (
        <ThemedText
          type="caption"
          accessibilityRole="link"
          accessibilityLabel={t('Source {n}: {title}', { n: part.n, title: source?.title || source?.url || '' })}
          onPress={source ? () => void openInApp(source.url) : undefined}
          style={[styles.cite, { color: theme.onAccentContainer, backgroundColor: theme.accentContainer }]}>
          {` ${part.n} `}
        </ThemedText>
      );
    }
    default:
      return part.text;
  }
}

const styles = StyleSheet.create({
  answer: {
    gap: Space.sm + 2,
  },
  list: {
    gap: Space.xs,
  },
  item: {
    flexDirection: 'row',
    gap: Space.sm,
    paddingRight: Space.xs,
  },
  marker: {
    minWidth: 18,
  },
  grow: {
    flex: 1,
  },
  quote: {
    borderLeftWidth: 3,
    paddingLeft: Space.md,
  },
  code: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: Radius.sm,
    padding: Space.md,
  },
  inlineCode: {
    fontSize: Type.code.fontSize,
    borderRadius: Radius.xs,
  },
  bold: {
    fontWeight: '700',
  },
  italic: {
    fontStyle: 'italic',
  },
  underline: {
    textDecorationLine: 'underline',
  },
  cite: {
    fontSize: 11,
    lineHeight: 16,
    borderRadius: Radius.xs,
    overflow: 'hidden',
  },
});
