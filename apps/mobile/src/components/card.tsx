import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Elevation, Radius, Space } from '@/constants/theme';
import { useScheme, useTheme } from '@/hooks/use-theme';

/** A panel on the page: surface color, hairline border, 16 dp corners. Its blocks sit 12 apart. */
export function Card({ children, style, padded = true, testID }: { children: React.ReactNode; style?: StyleProp<ViewStyle>; padded?: boolean; testID?: string }) {
  const theme = useTheme();
  const scheme = useScheme();
  return (
    <View
      style={[styles.card, padded && styles.padded, { backgroundColor: theme.surface, borderColor: theme.border }, scheme === 'light' && Elevation.card, style]}
      testID={testID}>
      {children}
    </View>
  );
}

/** A card's title and the text that explains it, kept together. */
export function CardHeader({ title, description, testID }: { title?: string; description?: string; testID?: string }) {
  return (
    <View style={styles.header} testID={testID}>
      {title ? <ThemedText type="heading">{title}</ThemedText> : null}
      {description ? (
        <ThemedText type="small" themeColor="textSecondary">
          {description}
        </ThemedText>
      ) : null}
    </View>
  );
}

/**
 * A section's name above its card or list, in the accent color like Android's settings, with an
 * optional count or action on the right.
 */
export function SectionHeader({ title, trailing, testID }: { title: string; trailing?: React.ReactNode; testID?: string }) {
  return (
    <View style={styles.section} testID={testID}>
      <ThemedText type="label" themeColor="accentText" style={styles.sectionTitle} accessibilityRole="header" numberOfLines={2}>
        {title}
      </ThemedText>
      {trailing}
    </View>
  );
}

/** Older name of SectionHeader. */
export function SectionLabel({ children }: { children: string }) {
  return <SectionHeader title={children} />;
}

const styles = StyleSheet.create({
  card: {
    borderRadius: Radius.lg,
    borderWidth: 1,
    overflow: 'hidden',
  },
  padded: {
    padding: Space.lg,
    gap: Space.md,
  },
  header: {
    gap: Space.xs,
  },
  section: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.sm,
    minHeight: 32,
    paddingHorizontal: Space.lg,
    marginTop: Space.sm,
    marginBottom: -Space.xs,
  },
  sectionTitle: {
    flex: 1,
  },
});
