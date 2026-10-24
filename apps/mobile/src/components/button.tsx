import { ActivityIndicator, Pressable, StyleSheet, Text } from 'react-native';

import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

/** Corvus's accent, as on the desktop. */
export const ACCENT = '#5B5BD6';

export function Button({
  label,
  onPress,
  kind = 'primary',
  busy = false,
  disabled = false,
  testID,
}: {
  label: string;
  onPress: () => void;
  kind?: 'primary' | 'secondary' | 'danger';
  busy?: boolean;
  disabled?: boolean;
  testID?: string;
}) {
  const theme = useTheme();
  const off = disabled || busy;
  const background = kind === 'primary' ? ACCENT : theme.backgroundSelected;
  const color = kind === 'primary' ? '#ffffff' : kind === 'danger' ? '#D93025' : theme.text;
  return (
    <Pressable
      accessibilityRole="button"
      testID={testID}
      disabled={off}
      onPress={onPress}
      style={({ pressed }) => [styles.button, { backgroundColor: background, opacity: off ? 0.5 : pressed ? 0.8 : 1 }]}>
      {busy ? <ActivityIndicator color={color} /> : <Text style={[styles.label, { color }]}>{label}</Text>}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    minHeight: 44,
    paddingHorizontal: Spacing.four,
    borderRadius: Spacing.three,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    fontSize: 16,
    fontWeight: 600,
  },
});
