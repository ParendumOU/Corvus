import { StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Space } from '@/constants/theme';

/**
 * An answer written in Markdown, drawn simply: paragraphs, "- " lists as bullets, headings and
 * **bold** as bold text. Enough for Corvus Assist's answers without a Markdown library.
 */
export function AnswerText({ text, testID }: { text: string; testID?: string }) {
  const blocks = text.replace(/\r\n/g, '\n').split(/\n{2,}/);
  return (
    <View style={styles.answer} testID={testID}>
      {blocks.map((block, b) => {
        const lines = block.split('\n').filter((l) => l.trim() !== '');
        if (lines.length === 0) return null;
        const bullets = lines.every((l) => /^\s*([-*•]|\d+[.)])\s+/.test(l));
        if (bullets) {
          return (
            <View key={b} style={styles.list}>
              {lines.map((line, i) => {
                const numbered = /^\s*(\d+)[.)]\s+/.exec(line);
                return (
                  <View key={i} style={styles.item}>
                    <ThemedText type="body" themeColor="textSecondary" style={styles.marker}>
                      {numbered ? `${numbered[1]}.` : '•'}
                    </ThemedText>
                    <ThemedText type="body" style={styles.grow}>
                      {inline(line.replace(/^\s*([-*•]|\d+[.)])\s+/, ''))}
                    </ThemedText>
                  </View>
                );
              })}
            </View>
          );
        }
        const heading = /^#{1,6}\s+(.*)$/.exec(lines[0]!);
        return (
          <ThemedText key={b} type={heading ? 'heading' : 'body'}>
            {heading ? heading[1] : inline(lines.join('\n'))}
          </ThemedText>
        );
      })}
    </View>
  );
}

/** **bold** runs as bold text, everything else as written. */
function inline(text: string): React.ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  if (parts.length === 1) return text;
  return parts.map((p, i) =>
    /^\*\*[^*]+\*\*$/.test(p) ? (
      <ThemedText key={i} type="bodyStrong">
        {p.slice(2, -2)}
      </ThemedText>
    ) : (
      p
    ),
  );
}

const styles = StyleSheet.create({
  answer: {
    gap: Space.sm,
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
    minWidth: 14,
  },
  grow: {
    flex: 1,
  },
});
