import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { Icon, type IconName } from '@/components/icon';
import { Colors, Elevation, Layout, Radius, Space, Type, type Palette } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

/** Corvus's accent, as on the desktop (light scheme). */
export const ACCENT = Colors.light.accent;

/**
 * - primary: the screen's main action (filled accent).
 * - tonal: other actions (soft accent); `secondary` is its older name.
 * - outline: a quiet alternative next to a primary.
 * - text: the least emphasis (Not now, Cancel).
 * - danger: something that cannot be undone, before it is confirmed (outlined red).
 * - dangerFilled: the confirming button of a destructive dialog.
 */
export type ButtonKind = 'primary' | 'tonal' | 'secondary' | 'outline' | 'text' | 'danger' | 'dangerFilled';

function colorsFor(kind: ButtonKind, theme: Palette): { fill: string; text: string; border?: string; ripple: string } {
  switch (kind) {
    case 'primary':
      return { fill: theme.accent, text: theme.onAccent, ripple: 'rgba(255,255,255,0.22)' };
    case 'tonal':
    case 'secondary':
      return { fill: theme.accentSoft, text: theme.accentText, ripple: theme.accentSoft };
    case 'outline':
      return { fill: 'transparent', text: theme.text, border: theme.borderStrong, ripple: theme.ripple };
    case 'text':
      return { fill: 'transparent', text: theme.accentText, ripple: theme.accentSoft };
    case 'danger':
      return { fill: 'transparent', text: theme.danger, border: theme.danger, ripple: theme.dangerSoft };
    case 'dangerFilled':
      return { fill: theme.danger, text: theme.onDanger, ripple: 'rgba(255,255,255,0.22)' };
  }
}

export function Button({
  label,
  onPress,
  kind = 'primary',
  busy = false,
  disabled = false,
  icon,
  size = 'md',
  style,
  accessibilityLabel,
  testID,
}: {
  label: string;
  onPress: () => void;
  kind?: ButtonKind;
  busy?: boolean;
  disabled?: boolean;
  icon?: IconName;
  size?: 'md' | 'sm';
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
  testID?: string;
}) {
  const theme = useTheme();
  const off = disabled || busy;
  const c = colorsFor(kind, theme);
  const quiet = kind === 'text' || kind === 'outline' || kind === 'danger';
  const fill = off && !busy ? (quiet ? 'transparent' : theme.disabledFill) : c.fill;
  const text = off && !busy ? theme.textDisabled : c.text;
  const border = c.border ? (off && !busy ? theme.border : c.border) : undefined;
  const small = size === 'sm';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled: off, busy }}
      testID={testID}
      disabled={off}
      onPress={onPress}
      hitSlop={small ? { top: 6, bottom: 6 } : undefined}
      android_ripple={{ color: c.ripple, borderless: false }}
      style={({ pressed }) => [
        styles.button,
        small && styles.small,
        kind === 'text' && styles.textKind,
        { backgroundColor: fill },
        border !== undefined && { borderWidth: 1, borderColor: border },
        pressed && Platform.OS !== 'android' && styles.pressed,
        style,
      ]}>
      {busy ? (
        <ActivityIndicator color={c.text} />
      ) : (
        <View style={styles.inner}>
          {icon ? <Icon name={icon} size={small ? 18 : 20} color={text} /> : null}
          <Text style={[Type.label, small ? styles.smallLabel : styles.label, styles.shrink, { color: text }]} numberOfLines={2}>
            {label}
          </Text>
        </View>
      )}
    </Pressable>
  );
}

/** A 48 dp round button with only an icon; it needs an accessibility label. */
export function IconButton({
  icon,
  onPress,
  accessibilityLabel,
  color,
  disabled,
  testID,
  size = 22,
}: {
  icon: IconName;
  onPress: () => void;
  accessibilityLabel: string;
  color?: string;
  disabled?: boolean;
  testID?: string;
  size?: number;
}) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      testID={testID}
      android_ripple={{ color: theme.ripple, borderless: true, radius: Layout.touch / 2 }}
      style={({ pressed }) => [styles.iconButton, pressed && Platform.OS !== 'android' && { backgroundColor: theme.ripple }]}>
      <Icon name={icon} size={size} color={disabled ? theme.textDisabled : (color ?? theme.textSecondary)} />
    </Pressable>
  );
}

/**
 * The floating button for a tab's main action (Library's "Save or send a page"), bottom right. It
 * shows its label at the top of the page and only its icon once the page scrolls (`collapsed`).
 */
export function Fab({ label, icon, onPress, collapsed, testID }: { label: string; icon: IconName; onPress: () => void; collapsed?: boolean; testID?: string }) {
  const theme = useTheme();
  return (
    <View style={styles.fabWrap} pointerEvents="box-none">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        onPress={onPress}
        testID={testID}
        android_ripple={{ color: theme.accentSoft }}
        style={({ pressed }) => [styles.fab, collapsed && styles.fabSquare, { backgroundColor: theme.accentContainer }, Elevation.overlay, pressed && Platform.OS !== 'android' && styles.pressed]}>
        <Icon name={icon} size={22} color={theme.onAccentContainer} />
        {collapsed ? null : (
          <Text style={[Type.label, styles.label, { color: theme.onAccentContainer }]} numberOfLines={1}>
            {label}
          </Text>
        )}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  fabWrap: {
    position: 'absolute',
    right: Space.lg,
    bottom: Space.lg,
  },
  fab: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.md,
    minHeight: 56,
    paddingLeft: Space.lg,
    paddingRight: Space.xl,
    borderRadius: Radius.lg,
    overflow: 'hidden',
  },
  fabSquare: {
    width: 56,
    paddingLeft: 0,
    paddingRight: 0,
    justifyContent: 'center',
  },
  button: {
    minHeight: Layout.touch,
    paddingHorizontal: Space.xl,
    paddingVertical: Space.sm,
    borderRadius: Radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  small: {
    minHeight: 36,
    paddingHorizontal: Space.lg,
    paddingVertical: Space.xs,
    borderRadius: Radius.sm + 2,
  },
  textKind: {
    paddingHorizontal: Space.md,
  },
  pressed: {
    opacity: 0.82,
  },
  shrink: {
    flexShrink: 1,
  },
  inner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Space.sm,
  },
  label: {
    fontSize: 15,
    textAlign: 'center',
  },
  smallLabel: {
    fontSize: 14,
    textAlign: 'center',
  },
  iconButton: {
    width: Layout.touch,
    height: Layout.touch,
    borderRadius: Layout.touch / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
