import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Radius, Space, Type } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { openInApp } from '@/lib/open-url';
import { t } from '@/lib/i18n';
import { markdownBlocks, markdownInline, type Inline } from '@/lib/markdown';
import { keptLength, partialMarkdown, revealStep } from '@/lib/reveal';

/** How often the text being written out moves on. */
const REVEAL_FRAME_MS = 33;

/**
 * How much of `text` to show: all of it when it was there from the start, else written out at a
 * steady pace toward the latest text (lib/reveal.ts) as the computer's pieces arrive.
 */
function useReveal(text: string, streaming: boolean): number {
  const [shown, setShown] = useState(() => (streaming ? 0 : text.length));
  const previous = useRef(text);
  const shownRef = useRef(shown);
  shownRef.current = shown;
  if (previous.current !== text) {
    const kept = keptLength(previous.current, shownRef.current, text);
    previous.current = text;
    if (kept < shownRef.current) {
      shownRef.current = kept;
      setShown(kept);
    }
  }
  const behind = shown < text.length;
  useEffect(() => {
    if (!behind) return;
    let last = Date.now();
    const timer = setInterval(() => {
      const at = Date.now();
      const dt = at - last;
      last = at;
      setShown((n) => revealStep(n, previous.current.length, dt, !streaming));
    }, REVEAL_FRAME_MS);
    return () => clearInterval(timer);
  }, [behind, streaming]);
  return Math.min(shown, text.length);
}

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
  const shown = useReveal(text, !!streaming);
  const writing = !!streaming || shown < text.length;
  const blocks = markdownBlocks(writing ? partialMarkdown(text, shown) : text);
  const caret = writing ? (
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
      // A small pill inside the line: a view, since a nested text's background on Android covers its
      // whole line height (tall boxes over the lines around it).
      const source = sources[part.n - 1];
      return (
        <Pressable
          accessibilityRole="link"
          accessibilityLabel={t('Source {n}: {title}', { n: part.n, title: source?.title || source?.url || '' })}
          onPress={source ? () => void openInApp(source.url) : undefined}
          hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
          style={[styles.cite, { backgroundColor: theme.accentContainer }]}
          testID={`cite-${part.n}`}>
          <Text allowFontScaling={false} style={[styles.citeText, { color: theme.onAccentContainer }]}>
            {part.n}
          </Text>
        </Pressable>
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
    minWidth: 16,
    marginHorizontal: 1,
    height: 16,
    paddingHorizontal: 4,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    // Inline views sit on the baseline: lowered a little, the pill centres on the small letters.
    transform: [{ translateY: Platform.OS === 'web' ? 1 : 3 }],
  },
  citeText: {
    fontSize: 10,
    lineHeight: 14,
    fontWeight: '600',
    includeFontPadding: false,
  },
});
