import type { ReactNode } from 'react';
import { Modal, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon, type IconName } from '@/components/icon';
import { ThemedText } from '@/components/themed-text';
import { Elevation, Layout, Radius, Space } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { t } from '@/lib/i18n';

/** A sheet from the bottom over a scrim (the browser's menu, its site panel); tapping outside closes it. */
export function Sheet({ open, onClose, children, header, testID }: { open: boolean; onClose: () => void; children: ReactNode; header?: ReactNode; testID?: string }) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent navigationBarTranslucent>
      <Pressable style={[StyleSheet.absoluteFill, { backgroundColor: theme.scrim }]} onPress={onClose} accessibilityLabel={t('Close')} />
      <View style={[styles.sheet, { backgroundColor: theme.surfaceRaised, paddingBottom: insets.bottom + Space.sm }, Elevation.overlay]} accessibilityViewIsModal testID={testID}>
        <View style={[styles.grabber, { backgroundColor: theme.borderStrong }]} />
        {header}
        <ScrollView bounces={false} showsVerticalScrollIndicator={false} contentContainerStyle={styles.body}>
          {children}
        </ScrollView>
      </View>
    </Modal>
  );
}

/** A row of a sheet: an icon, a label (and a line under it), something on the right. */
export function SheetRow({
  icon,
  label,
  detail,
  onPress,
  trailing,
  disabled,
  active,
  testID,
}: {
  icon: IconName;
  label: string;
  detail?: string;
  onPress?: () => void;
  trailing?: ReactNode;
  disabled?: boolean;
  /** Drawn in the accent (a star that is on). */
  active?: boolean;
  testID?: string;
}) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled || !onPress}
      onPress={onPress}
      android_ripple={{ color: theme.ripple }}
      style={({ pressed }) => [styles.row, pressed && Platform.OS !== 'android' && { backgroundColor: theme.ripple }]}
      testID={testID}>
      <Icon name={icon} size={22} color={disabled ? theme.textDisabled : active ? theme.accentText : theme.textSecondary} />
      <View style={styles.grow}>
        <ThemedText type="body" numberOfLines={1} style={disabled ? { color: theme.textDisabled } : undefined}>
          {label}
        </ThemedText>
        {detail ? (
          <ThemedText type="small" themeColor="textSecondary" numberOfLines={3}>
            {detail}
          </ThemedText>
        ) : null}
      </View>
      {trailing}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    maxHeight: '88%',
    borderTopLeftRadius: Radius.xl,
    borderTopRightRadius: Radius.xl,
    paddingTop: Space.sm,
  },
  grabber: {
    width: 32,
    height: 4,
    borderRadius: 2,
    alignSelf: 'center',
    marginBottom: Space.sm,
  },
  body: {
    paddingHorizontal: Space.sm,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.lg,
    minHeight: Layout.row - 4,
    paddingHorizontal: Space.lg,
    paddingVertical: Space.xs,
    borderRadius: Radius.lg,
    overflow: 'hidden',
  },
  grow: {
    flex: 1,
  },
});
