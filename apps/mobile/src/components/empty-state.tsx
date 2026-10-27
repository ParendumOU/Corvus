import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { Icon, type IconName } from '@/components/icon';
import { ThemedText } from '@/components/themed-text';
import { Space } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { t } from '@/lib/i18n';

/** What a screen or a list shows before it has anything: an icon, what goes here, and how to fill it. */
export function EmptyState({
  icon,
  title,
  description,
  action,
  compact,
  testID,
}: {
  icon: IconName;
  title?: string;
  description: string;
  action?: React.ReactNode;
  /** Inside a card (a list with nothing in it), with less room around it. */
  compact?: boolean;
  testID?: string;
}) {
  const theme = useTheme();
  return (
    <View style={[styles.wrap, compact && styles.compact]} testID={testID}>
      <View style={[styles.badge, compact && styles.badgeSmall, { backgroundColor: theme.accentSoft }]}>
        <Icon name={icon} size={compact ? 22 : 28} color={theme.accentText} />
      </View>
      <View style={styles.text}>
        {title ? (
          <ThemedText type="heading" style={styles.center}>
            {title}
          </ThemedText>
        ) : null}
        <ThemedText type="small" themeColor="textSecondary" style={styles.center}>
          {description}
        </ThemedText>
      </View>
      {action ? <View style={styles.action}>{action}</View> : null}
    </View>
  );
}

/** While something loads: a spinner and what it is waiting for. */
export function LoadingState({ label, testID }: { label?: string; testID?: string }) {
  const theme = useTheme();
  return (
    <View style={styles.loading} testID={testID} accessibilityRole="progressbar" accessibilityLabel={label ?? t('Loading…')}>
      <ActivityIndicator color={theme.accent} />
      <ThemedText type="small" themeColor="textSecondary">
        {label ?? t('Loading…')}
      </ThemedText>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    gap: Space.lg,
    paddingVertical: Space.xxxl,
    paddingHorizontal: Space.lg,
  },
  compact: {
    gap: Space.md,
    paddingVertical: Space.xxl,
  },
  badge: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeSmall: {
    width: 48,
    height: 48,
    borderRadius: 24,
  },
  text: {
    gap: Space.xs + 2,
    maxWidth: 340,
  },
  center: {
    textAlign: 'center',
  },
  action: {
    alignSelf: 'stretch',
    marginTop: Space.xs,
  },
  loading: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Space.md,
    paddingVertical: Space.xxl,
  },
});
