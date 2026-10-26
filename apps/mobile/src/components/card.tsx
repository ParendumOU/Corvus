import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';

/** A rounded panel; its blocks (header, rows, buttons) sit 16 apart. */
export function Card({ children, style, testID }: { children: React.ReactNode; style?: StyleProp<ViewStyle>; testID?: string }) {
  return (
    <ThemedView type="backgroundElement" style={[styles.card, style]} testID={testID}>
      {children}
    </ThemedView>
  );
}

/** A card's title and the text that explains it, kept together. */
export function CardHeader({ title, description }: { title?: string; description?: string }) {
  return (
    <View style={styles.header}>
      {title ? <ThemedText type="heading">{title}</ThemedText> : null}
      {description ? (
        <ThemedText type="body" themeColor="textSecondary">
          {description}
        </ThemedText>
      ) : null}
    </View>
  );
}

/** A section's name, above its card. */
export function SectionLabel({ children }: { children: string }) {
  return (
    <ThemedText type="label" themeColor="textSecondary" style={styles.label}>
      {children}
    </ThemedText>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: Spacing.three,
    padding: 20,
    borderRadius: Spacing.four,
  },
  header: {
    gap: 6,
  },
  label: {
    marginTop: Spacing.two,
    marginBottom: -Spacing.two,
    paddingHorizontal: Spacing.one,
  },
});
