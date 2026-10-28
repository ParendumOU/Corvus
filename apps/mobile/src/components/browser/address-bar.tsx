import { useEffect, useRef, type ComponentRef } from 'react';
import { Platform, Pressable, StyleSheet, TextInput, View, type TextStyle } from 'react-native';

import { IconButton } from '@/components/button';
import { Icon } from '@/components/icon';
import { ThemedText } from '@/components/themed-text';
import { Radius, Space, Type } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { displayAddress, isSecure, isWebPage } from '@/lib/address';
import { t } from '@/lib/i18n';

const NO_OUTLINE = Platform.select<TextStyle>({ web: { outlineStyle: 'none' } as unknown as TextStyle, default: {} });

/**
 * The browser's address bar: the site (or the search) with the shield that counts what was blocked
 * on the page, reload or stop on the right; tapped, it becomes a field with the whole address.
 */
export function AddressBar({
  url,
  field,
  editing,
  draft,
  loading,
  blocked,
  blockingOn,
  onDraft,
  onEdit,
  onSubmit,
  onCancel,
  onReload,
  onStop,
  onShield,
}: {
  url: string;
  /** The tab being edited: another tab starts the field again from `draft`. */
  field: string;
  editing: boolean;
  /** What the field starts with when editing begins; the field reports its changes with `onDraft`. */
  draft: string;
  loading: boolean;
  /** Requests blocked on the page; null where the phone does not block (iOS, the web build). */
  blocked: number | null;
  /** Blocking is on for this site. */
  blockingOn: boolean;
  onDraft: (text: string) => void;
  onEdit: () => void;
  onSubmit: () => void;
  onCancel: () => void;
  onReload: () => void;
  onStop: () => void;
  onShield: () => void;
}) {
  const theme = useTheme();
  const input = useRef<ComponentRef<typeof TextInput>>(null);
  const web = isWebPage(url);

  useEffect(() => {
    if (!editing) return;
    const start = draft;
    const timer = setTimeout(() => {
      input.current?.focus();
      // The address being edited is selected once, so typing replaces it. Not selectTextOnFocus: Android
      // focuses the field again after the first keystroke, and selecting then ate what was being typed.
      if (start) input.current?.setSelection(0, start.length);
    }, 60);
    return () => clearTimeout(timer);
  }, [editing, field]);

  return (
    <View style={styles.bar}>
      {editing ? null : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={blocked === null ? t('About this site') : t('{n} ads and trackers blocked on this page', { n: blocked })}
          onPress={onShield}
          hitSlop={6}
          style={styles.shield}
          testID="browser-shield">
          <Icon name={blocked === null ? (isSecure(url) ? 'lock' : 'info') : blockingOn ? 'shieldCheck' : 'shieldOff'} size={22} color={blocked !== null && blockingOn ? theme.accentText : theme.textSecondary} />
          {blocked !== null && blocked > 0 && blockingOn ? (
            <View style={[styles.badge, { backgroundColor: theme.accent }]}>
              <ThemedText type="caption" style={[styles.badgeText, { color: theme.onAccent }]} testID="browser-blocked-count">
                {blocked > 99 ? '99+' : String(blocked)}
              </ThemedText>
            </View>
          ) : null}
        </Pressable>
      )}
      <View style={[styles.field, { backgroundColor: theme.field, borderColor: editing ? theme.accent : theme.border }]}>
        {editing ? (
          <>
            <Icon name="search" size={18} color={theme.textTertiary} />
            {/* Uncontrolled: on Android a value sent back from a busy JS thread wipes what was just typed. */}
            <TextInput
              key={field}
              ref={input}
              defaultValue={draft}
              onChangeText={onDraft}
              onSubmitEditing={onSubmit}
              placeholder={t('Search or type a web address')}
              placeholderTextColor={theme.textTertiary}
              selectionColor={theme.accent}
              style={[Type.body, styles.input, { color: theme.text }, NO_OUTLINE]}
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="off"
              keyboardType={Platform.OS === 'android' ? 'default' : 'web-search'}
              inputMode="url"
              returnKeyType="go"
              importantForAutofill="no"
              accessibilityLabel={t('Address')}
              testID="browser-address-input"
            />
            {draft ? (
              <IconButton
                icon="close"
                size={18}
                accessibilityLabel={t('Clear')}
                onPress={() => {
                  input.current?.clear();
                  onDraft('');
                }}
                testID="browser-address-clear"
              />
            ) : null}
          </>
        ) : (
          <Pressable accessibilityRole="button" accessibilityLabel={t('Address')} accessibilityHint={t('Search or type a web address')} onPress={onEdit} style={styles.shown} testID="browser-address">
            {web && !isSecure(url) ? (
              <ThemedText type="small" style={{ color: theme.warning }}>
                {t('Not secure')}
              </ThemedText>
            ) : null}
            <ThemedText type="body" numberOfLines={1} style={[styles.shrink, !url && { color: theme.textTertiary }]}>
              {displayAddress(url) || t('Search or type a web address')}
            </ThemedText>
          </Pressable>
        )}
      </View>
      {editing ? (
        <IconButton icon="close" accessibilityLabel={t('Cancel')} onPress={onCancel} testID="browser-address-cancel" />
      ) : loading ? (
        <IconButton icon="stop" accessibilityLabel={t('Stop')} onPress={onStop} testID="browser-stop" />
      ) : (
        <IconButton icon="refresh" accessibilityLabel={t('Reload')} onPress={onReload} disabled={!web} testID="browser-reload" />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.xs,
    paddingLeft: Space.sm,
    paddingRight: Space.xs,
    paddingVertical: Space.xs,
  },
  shield: {
    width: 40,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badge: {
    position: 'absolute',
    top: 4,
    right: 0,
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    paddingHorizontal: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: {
    fontSize: 10,
    lineHeight: 14,
    fontWeight: '700',
  },
  field: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.sm,
    minHeight: 44,
    paddingLeft: Space.md,
    borderRadius: Radius.pill,
    borderWidth: 1,
  },
  input: {
    flex: 1,
    paddingVertical: Space.sm,
  },
  shown: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.sm,
    minHeight: 44,
    paddingRight: Space.md,
  },
  shrink: {
    flexShrink: 1,
  },
});
