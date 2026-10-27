import { Children, Fragment, isValidElement, type ReactNode } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, View, type AccessibilityRole, type StyleProp, type ViewStyle } from 'react-native';

import { Card } from '@/components/card';
import { Icon, type IconName } from '@/components/icon';
import { ThemedText } from '@/components/themed-text';
import { Layout, Radius, Space } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

/** Where a row's text starts when it has something on its left (16 + 36 + 16). */
export const ROW_TEXT_INSET = Space.lg + 36 + Space.lg;

/**
 * Rows in a card, with a divider between them that starts where the text does. `header` is an
 * optional first block (a title, breadcrumbs) above the rows.
 */
export function ListGroup({
  children,
  header,
  inset = ROW_TEXT_INSET,
  style,
  testID,
}: {
  children: ReactNode;
  header?: ReactNode;
  inset?: number;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const theme = useTheme();
  const rows = Children.toArray(children).filter(isValidElement);
  return (
    <Card padded={false} style={style} testID={testID}>
      {header ? <View style={styles.groupHeader}>{header}</View> : null}
      {rows.map((row, i) => (
        <Fragment key={row.key ?? i}>
          {i > 0 && <View style={[styles.divider, { marginLeft: inset, backgroundColor: theme.divider }]} />}
          {row}
        </Fragment>
      ))}
    </Card>
  );
}

/** A card's own header inside a ListGroup: a title and a line under it. */
export function ListHeader({ title, subtitle, leading, trailing }: { title: string; subtitle?: string; leading?: ReactNode; trailing?: ReactNode }) {
  return (
    <View style={styles.listHeader}>
      {leading}
      <View style={styles.grow}>
        <ThemedText type="heading" numberOfLines={1}>
          {title}
        </ThemedText>
        {subtitle ? (
          <ThemedText type="small" themeColor="textSecondary" numberOfLines={1}>
            {subtitle}
          </ThemedText>
        ) : null}
      </View>
      {trailing}
    </View>
  );
}

/**
 * One row: something on the left (an icon or a favicon), a title and a line under it, and on the
 * right a chevron or a control. Only the left part and the text are pressable, so a control on the
 * right (a button, a switch) works on its own.
 */
export function ListRow({
  title,
  subtitle,
  leading,
  trailing,
  chevron,
  badge,
  onPress,
  onLongPress,
  titleLines = 1,
  subtitleLines = 1,
  muted,
  accessibilityRole,
  accessibilityLabel,
  accessibilityHint,
  accessibilityState,
  testID,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  leading?: ReactNode;
  trailing?: ReactNode;
  chevron?: boolean;
  /** Inside the pressable part, before the chevron (a dot for something new). */
  badge?: ReactNode;
  onPress?: () => void;
  onLongPress?: () => void;
  titleLines?: number;
  subtitleLines?: number;
  /** Already done (a read article): drawn quieter. */
  muted?: boolean;
  accessibilityRole?: AccessibilityRole;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  accessibilityState?: { selected?: boolean; checked?: boolean; disabled?: boolean };
  testID?: string;
}) {
  const theme = useTheme();
  const body = (
    <>
      {leading ? <View style={styles.leading}>{leading}</View> : null}
      <View style={styles.text}>
        {typeof title === 'string' ? (
          <ThemedText type="body" numberOfLines={titleLines} themeColor={muted ? 'textSecondary' : 'text'}>
            {title}
          </ThemedText>
        ) : (
          title
        )}
        {subtitle === undefined || subtitle === null || subtitle === '' ? null : typeof subtitle === 'string' ? (
          <ThemedText type="small" themeColor="textSecondary" numberOfLines={subtitleLines}>
            {subtitle}
          </ThemedText>
        ) : (
          subtitle
        )}
      </View>
      {badge}
      {chevron ? <Icon name="chevronRight" size={20} color={theme.textTertiary} /> : null}
    </>
  );
  return (
    <View style={[styles.row, subtitle ? styles.twoLine : null]}>
      {onPress || onLongPress ? (
        <Pressable
          accessibilityRole={accessibilityRole ?? 'button'}
          accessibilityLabel={accessibilityLabel}
          accessibilityHint={accessibilityHint}
          accessibilityState={accessibilityState}
          onPress={onPress}
          onLongPress={onLongPress}
          android_ripple={{ color: theme.ripple }}
          style={({ pressed }) => [styles.main, pressed && Platform.OS !== 'android' && { backgroundColor: theme.ripple }]}
          testID={testID}>
          {body}
        </Pressable>
      ) : (
        <View style={styles.main} testID={testID} accessibilityLabel={accessibilityLabel}>
          {body}
        </View>
      )}
      {trailing ? <View style={styles.trailing}>{trailing}</View> : null}
    </View>
  );
}

/** A row that does something (Save to reading list): an icon, what it does, a spinner while busy. */
export function ActionRow({ icon, label, onPress, disabled, busy, testID }: { icon: IconName; label: string; onPress: () => void; disabled?: boolean; busy?: boolean; testID?: string }) {
  const theme = useTheme();
  const off = !!disabled || !!busy;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: off, busy: !!busy }}
      disabled={off}
      onPress={onPress}
      android_ripple={{ color: theme.ripple }}
      style={({ pressed }) => [styles.action, pressed && Platform.OS !== 'android' && { backgroundColor: theme.ripple }]}
      testID={testID}>
      <IconTile name={icon} color={disabled && !busy ? theme.textDisabled : undefined} background={disabled && !busy ? theme.disabledFill : undefined} />
      <ThemedText type="body" themeColor={disabled && !busy ? 'textDisabled' : 'text'} style={styles.grow}>
        {label}
      </ThemedText>
      {busy ? <ActivityIndicator color={theme.accent} /> : null}
    </Pressable>
  );
}

/** A radio button's circle, filled when chosen. */
export function RadioMark({ checked }: { checked: boolean }) {
  const theme = useTheme();
  return (
    <View style={[styles.radio, { borderColor: checked ? theme.accent : theme.textTertiary }]}>
      {checked ? <View style={[styles.radioDot, { backgroundColor: theme.accent }]} /> : null}
    </View>
  );
}

/** A square tile with an icon, the left part of a row that is not a page (a folder, a device). */
export function IconTile({ name, color, background, size = 36 }: { name: IconName; color?: string; background?: string; size?: number }) {
  const theme = useTheme();
  return (
    <View style={[styles.tile, { width: size, height: size, backgroundColor: background ?? theme.accentSoft }]}>
      <Icon name={name} size={Math.round(size * 0.56)} color={color ?? theme.accentText} />
    </View>
  );
}

const styles = StyleSheet.create({
  groupHeader: {
    paddingHorizontal: Space.lg,
    paddingTop: Space.lg,
    paddingBottom: Space.sm,
  },
  listHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.md,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'stretch',
    minHeight: Layout.row,
  },
  twoLine: {
    minHeight: Layout.rowTwoLine,
  },
  main: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.lg,
    paddingLeft: Space.lg,
    paddingRight: Space.md,
    paddingVertical: Space.sm + 2,
  },
  leading: {
    width: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: {
    flex: 1,
    gap: 1,
  },
  trailing: {
    justifyContent: 'center',
    paddingRight: Space.xs,
  },
  action: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.lg,
    minHeight: Layout.row,
    paddingHorizontal: Space.lg,
    paddingVertical: Space.sm,
  },
  radio: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: Space.md,
  },
  radioDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  tile: {
    borderRadius: Radius.sm + 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  grow: {
    flex: 1,
  },
});
