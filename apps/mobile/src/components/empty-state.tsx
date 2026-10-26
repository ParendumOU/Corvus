import { Image, StyleSheet, View, type ImageSourcePropType } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

/** What a screen shows before it has anything: an icon, what goes here, and how to fill it. */
export function EmptyState({
  icon,
  title,
  description,
  action,
  testID,
}: {
  icon: ImageSourcePropType;
  title: string;
  description: string;
  action?: React.ReactNode;
  testID?: string;
}) {
  const theme = useTheme();
  return (
    <View style={styles.wrap} testID={testID}>
      <View style={[styles.badge, { backgroundColor: theme.backgroundElement }]}>
        <Image source={icon} style={[styles.icon, { tintColor: theme.textSecondary }]} />
      </View>
      <View style={styles.text}>
        <ThemedText type="heading" style={styles.center}>
          {title}
        </ThemedText>
        <ThemedText type="body" themeColor="textSecondary" style={styles.center}>
          {description}
        </ThemedText>
      </View>
      {action ? <View style={styles.action}>{action}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    gap: Spacing.three,
    paddingVertical: Spacing.five,
    paddingHorizontal: Spacing.two,
  },
  badge: {
    width: 72,
    height: 72,
    borderRadius: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  icon: {
    width: 30,
    height: 30,
  },
  text: {
    gap: Spacing.two,
    maxWidth: 340,
  },
  center: {
    textAlign: 'center',
  },
  action: {
    alignSelf: 'stretch',
    marginTop: Spacing.two,
  },
});
