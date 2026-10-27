import { useState, type ReactNode } from 'react';
import { Platform, Pressable, StyleSheet, TextInput, View, type TextInputProps, type TextStyle } from 'react-native';

import { IconButton } from '@/components/button';
import { Icon, type IconName } from '@/components/icon';
import { ThemedText } from '@/components/themed-text';
import { Layout, Radius, Space, Type } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { t } from '@/lib/i18n';

/** The web build draws its own focus ring, not the browser's outline. */
const NO_OUTLINE = Platform.select<TextStyle>({ web: { outlineStyle: 'none' } as unknown as TextStyle, default: {} });

export type TextFieldProps = Omit<TextInputProps, 'style'> & {
  /** Always shown above the field, so it stays clear what goes in it once something is typed. */
  label?: string;
  /** Under the field: what to type, or what happens with it. */
  help?: string;
  /** Under the field instead of the help, in red, with the field outlined in red. */
  error?: string | null;
  /** Rows of a multiline field. */
  lines?: number;
  leading?: ReactNode;
  testID?: string;
};

/** A text field with its label above and its help or error under it. */
export function TextField({ label, help, error, lines = 1, leading, multiline, onFocus, onBlur, testID, ...input }: TextFieldProps) {
  const theme = useTheme();
  const [focused, setFocused] = useState(false);
  const border = error ? theme.danger : focused ? theme.accent : theme.borderStrong;
  const minHeight = multiline ? Math.max(Layout.touch + 4, 24 * lines + 28) : Layout.touch + 4;
  return (
    <View style={styles.field}>
      {label ? (
        <ThemedText type="smallStrong" themeColor={error ? 'danger' : focused ? 'accentText' : 'textSecondary'} numberOfLines={2}>
          {label}
        </ThemedText>
      ) : null}
      <View style={[styles.box, { minHeight, backgroundColor: theme.field, borderColor: border, borderWidth: focused || error ? 2 : 1, padding: focused || error ? 0 : 1 }]}>
        {leading ? <View style={styles.leading}>{leading}</View> : null}
        <TextInput
          testID={testID}
          accessibilityLabel={input.accessibilityLabel ?? label}
          placeholderTextColor={theme.textTertiary}
          selectionColor={theme.accent}
          cursorColor={theme.accent}
          multiline={multiline}
          textAlignVertical={multiline ? 'top' : 'center'}
          onFocus={(e) => {
            setFocused(true);
            onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocused(false);
            onBlur?.(e);
          }}
          style={[Type.body, styles.input, multiline && styles.multiline, { color: theme.text, minHeight: minHeight - 4 }, NO_OUTLINE]}
          {...input}
        />
      </View>
      {error ? (
        <View style={styles.message} accessibilityLiveRegion="polite">
          <Icon name="warning" size={16} color={theme.danger} />
          <ThemedText type="small" themeColor="danger" style={styles.grow}>
            {error}
          </ThemedText>
        </View>
      ) : help ? (
        <ThemedText type="small" themeColor="textSecondary">
          {help}
        </ThemedText>
      ) : null}
    </View>
  );
}

/** A search box: magnifier on the left, a button to clear it on the right once something is typed. */
export function SearchField({ value, onChangeText, placeholder, testID }: { value: string; onChangeText: (text: string) => void; placeholder: string; testID?: string }) {
  const theme = useTheme();
  const [focused, setFocused] = useState(false);
  return (
    <View style={[styles.search, { backgroundColor: theme.surface, borderColor: focused ? theme.accent : theme.border }]}>
      <Icon name="search" size={20} color={focused ? theme.accentText : theme.textSecondary} />
      <TextInput
        testID={testID}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        accessibilityLabel={placeholder}
        placeholderTextColor={theme.textTertiary}
        selectionColor={theme.accent}
        cursorColor={theme.accent}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={[Type.body, styles.searchInput, { color: theme.text }, NO_OUTLINE]}
      />
      {value !== '' && <IconButton icon="close" size={20} onPress={() => onChangeText('')} accessibilityLabel={t('Clear the search')} />}
    </View>
  );
}

export interface Choice<K extends string | number> {
  key: K;
  label: string;
  /** Read out instead of the label (when the label is shortened to fit). */
  accessibilityLabel?: string;
  icon?: IconName;
  testID?: string;
}

/** Pick one of a few (computers to send to): chips that wrap; the chosen one is filled and checked. */
export function ChoiceChips<K extends string | number>({ choices, value, onChange }: { choices: Choice<K>[]; value: K | undefined; onChange: (key: K) => void }) {
  const theme = useTheme();
  return (
    <View style={styles.chips} accessibilityRole="radiogroup">
      {choices.map((c) => {
        const chosen = c.key === value;
        return (
          <Pressable
            key={String(c.key)}
            accessibilityRole="radio"
            accessibilityState={{ checked: chosen }}
            accessibilityLabel={c.accessibilityLabel}
            onPress={() => onChange(c.key)}
            hitSlop={{ top: 6, bottom: 6 }}
            android_ripple={{ color: theme.ripple }}
            style={[
              styles.chip,
              chosen ? { backgroundColor: theme.accentContainer, borderColor: theme.accentContainer } : { borderColor: theme.borderStrong },
            ]}
            testID={c.testID}>
            {chosen ? <Icon name="check" size={18} color={theme.onAccentContainer} /> : c.icon ? <Icon name={c.icon} size={18} color={theme.textSecondary} /> : null}
            <ThemedText type="label" style={{ color: chosen ? theme.onAccentContainer : theme.text }} numberOfLines={1}>
              {c.label}
            </ThemedText>
          </Pressable>
        );
      })}
    </View>
  );
}

/** Pick one of 2–4 short options in a row (how often to check a page). Labels never wrap. */
export function SegmentedControl<K extends string | number>({ choices, value, onChange }: { choices: Choice<K>[]; value: K; onChange: (key: K) => void }) {
  const theme = useTheme();
  return (
    <View style={[styles.segmented, { borderColor: theme.borderStrong }]} accessibilityRole="radiogroup">
      {choices.map((c, i) => {
        const chosen = c.key === value;
        return (
          <Pressable
            key={String(c.key)}
            accessibilityRole="radio"
            accessibilityState={{ checked: chosen }}
            accessibilityLabel={c.accessibilityLabel ?? c.label}
            onPress={() => onChange(c.key)}
            android_ripple={{ color: theme.ripple }}
            style={[styles.segment, i > 0 && { borderLeftWidth: 1, borderLeftColor: theme.borderStrong }, chosen && { backgroundColor: theme.accentContainer }]}
            testID={c.testID}>
            {chosen ? <Icon name="check" size={16} color={theme.onAccentContainer} /> : null}
            <ThemedText type="label" style={{ color: chosen ? theme.onAccentContainer : theme.text }} numberOfLines={1}>
              {c.label}
            </ThemedText>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  field: {
    gap: Space.xs + 2,
  },
  box: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: Radius.md,
  },
  leading: {
    paddingLeft: Space.md,
  },
  input: {
    flex: 1,
    paddingHorizontal: Space.md + 2,
    paddingVertical: Space.sm,
  },
  multiline: {
    paddingTop: Space.md,
    paddingBottom: Space.md,
  },
  message: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Space.xs + 2,
    paddingTop: 1,
  },
  grow: {
    flex: 1,
  },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.sm,
    minHeight: Layout.touch,
    paddingLeft: Space.lg,
    paddingRight: Space.xs,
    borderRadius: Radius.pill,
    borderWidth: 1,
  },
  searchInput: {
    flex: 1,
    paddingVertical: Space.sm,
    minHeight: Layout.touch - 2,
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Space.sm,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.xs + 2,
    minHeight: 36,
    paddingHorizontal: Space.md + 2,
    borderRadius: Radius.sm + 2,
    borderWidth: 1,
    overflow: 'hidden',
  },
  segmented: {
    flexDirection: 'row',
    borderWidth: 1,
    borderRadius: Radius.pill,
    overflow: 'hidden',
    minHeight: 40,
  },
  segment: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Space.xs,
    paddingHorizontal: Space.xs,
    minHeight: 40,
  },
});
