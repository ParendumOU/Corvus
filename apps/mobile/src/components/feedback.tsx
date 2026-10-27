/**
 * Feedback the app gives: a banner inside a screen (an error, a warning, a note), a toast that
 * confirms an action for a few seconds, and a confirmation dialog for what cannot be undone. The
 * toast and the dialog are shown by <FeedbackHost/> in the root layout.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Animated, Modal, Platform, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button } from '@/components/button';
import { Icon, type IconName } from '@/components/icon';
import { ThemedText } from '@/components/themed-text';
import { Elevation, Radius, Space } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { t } from '@/lib/i18n';

export type Tone = 'info' | 'success' | 'warning' | 'error';

const TONE_ICON: Record<Tone, IconName> = { info: 'info', success: 'checkCircle', warning: 'warning', error: 'warning' };

function toneColors(tone: Tone, theme: ReturnType<typeof useTheme>): { color: string; fill: string } {
  if (tone === 'error') return { color: theme.danger, fill: theme.dangerSoft };
  if (tone === 'warning') return { color: theme.warning, fill: theme.warningSoft };
  if (tone === 'success') return { color: theme.success, fill: theme.successSoft };
  return { color: theme.accentText, fill: theme.accentSoft };
}

/** A note inside a screen: what happened and, when there is one, what to do about it. */
export function Banner({ tone = 'info', icon, title, message, action, testID }: { tone?: Tone; icon?: IconName; title?: string; message: string; action?: ReactNode; testID?: string }) {
  const theme = useTheme();
  const { color, fill } = toneColors(tone, theme);
  return (
    <View style={[styles.banner, { backgroundColor: fill }]} accessibilityRole={tone === 'error' ? 'alert' : undefined} testID={testID}>
      <Icon name={icon ?? TONE_ICON[tone]} size={20} color={color} />
      <View style={styles.bannerText}>
        {title ? <ThemedText type="smallStrong">{title}</ThemedText> : null}
        <ThemedText type="small" style={tone === 'error' ? { color: theme.danger } : undefined} themeColor={tone === 'error' ? undefined : 'text'}>
          {message}
        </ThemedText>
        {action ? <View style={styles.bannerAction}>{action}</View> : null}
      </View>
    </View>
  );
}

/** A short status in a pill ("Yes", "Changed"), colored by its tone; `neutral` is grey. */
export function Badge({ label, tone, testID }: { label: string; tone: Tone | 'neutral'; testID?: string }) {
  const theme = useTheme();
  const { color, fill } = tone === 'neutral' ? { color: theme.textSecondary, fill: theme.disabledFill } : toneColors(tone, theme);
  return (
    <View style={[styles.badge, { backgroundColor: fill }]} testID={testID}>
      <ThemedText type="caption" style={{ color }} numberOfLines={1}>
        {label}
      </ThemedText>
    </View>
  );
}

// ---------------------------------------------------------------- toast and dialog state

interface ToastState {
  id: number;
  message: string;
  tone: Tone;
}
interface DialogState {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  destructive: boolean;
  resolve: (ok: boolean) => void;
}

let toastListener: ((toast: ToastState) => void) | null = null;
let dialogListener: ((dialog: DialogState) => void) | null = null;
let toastId = 0;

/** Says for a few seconds that an action worked ("Sent to Demo laptop"). */
export function showToast(message: string, tone: Tone = 'success'): void {
  toastListener?.({ id: ++toastId, message, tone });
}

/** Asks before something that cannot be undone. Resolves to true when the person confirms. */
export function confirm(options: { title: string; message: string; confirmLabel: string; cancelLabel?: string; destructive?: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    if (!dialogListener) {
      resolve(false);
      return;
    }
    dialogListener({ cancelLabel: t('Cancel'), destructive: true, ...options, resolve });
  });
}

/** Shows the toasts and the confirmation dialog; mounted once, in the root layout. */
export function FeedbackHost() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const [toast, setToast] = useState<ToastState | null>(null);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const fade = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    toastListener = setToast;
    dialogListener = setDialog;
    return () => {
      toastListener = null;
      dialogListener = null;
    };
  }, []);

  useEffect(() => {
    if (!toast) return;
    Animated.timing(fade, { toValue: 1, duration: 160, useNativeDriver: Platform.OS !== 'web' }).start();
    const timer = setTimeout(() => {
      Animated.timing(fade, { toValue: 0, duration: 200, useNativeDriver: Platform.OS !== 'web' }).start(() => setToast((now) => (now?.id === toast.id ? null : now)));
    }, 3200);
    return () => clearTimeout(timer);
  }, [toast, fade]);

  const close = (ok: boolean): void => {
    dialog?.resolve(ok);
    setDialog(null);
  };

  return (
    <>
      {toast && (
        <Animated.View
          pointerEvents="none"
          style={[styles.toastWrap, { bottom: insets.bottom + 96, opacity: fade, transform: [{ translateY: fade.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }) }] }]}>
          <View style={[styles.toast, { backgroundColor: theme.text }, Elevation.overlay]} accessibilityLiveRegion="polite" accessibilityRole="alert" testID="toast">
            <Icon name={TONE_ICON[toast.tone]} size={20} color={theme.background} />
            <ThemedText type="smallStrong" style={[styles.grow, { color: theme.background }]}>
              {toast.message}
            </ThemedText>
          </View>
        </Animated.View>
      )}
      <Modal visible={dialog !== null} transparent animationType="fade" statusBarTranslucent navigationBarTranslucent onRequestClose={() => close(false)}>
        <Pressable style={[styles.scrim, { backgroundColor: theme.scrim }]} onPress={() => close(false)} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" />
        <View style={styles.dialogWrap} pointerEvents="box-none">
          {dialog && (
            <View style={[styles.dialog, { backgroundColor: theme.surfaceRaised }, Elevation.overlay]} accessibilityViewIsModal testID="dialog">
              <ThemedText type="title" accessibilityRole="header">
                {dialog.title}
              </ThemedText>
              <ThemedText type="body" themeColor="textSecondary">
                {dialog.message}
              </ThemedText>
              <View style={styles.dialogActions}>
                <Button label={dialog.cancelLabel} kind="text" onPress={() => close(false)} testID="dialog-cancel" />
                <Button label={dialog.confirmLabel} kind={dialog.destructive ? 'dangerFilled' : 'primary'} onPress={() => close(true)} testID="dialog-confirm" />
              </View>
            </View>
          )}
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Space.md,
    padding: Space.md + 2,
    borderRadius: Radius.md,
  },
  badge: {
    alignSelf: 'flex-start',
    paddingHorizontal: Space.sm,
    paddingVertical: 2,
    borderRadius: Radius.pill,
  },
  bannerText: {
    flex: 1,
    gap: 2,
  },
  bannerAction: {
    flexDirection: 'row',
    marginTop: Space.sm,
    marginLeft: -Space.md,
  },
  toastWrap: {
    position: 'absolute',
    left: Space.lg,
    right: Space.lg,
    alignItems: 'center',
  },
  toast: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.md,
    maxWidth: 560,
    paddingVertical: Space.md + 2,
    paddingHorizontal: Space.lg,
    borderRadius: Radius.md,
  },
  grow: {
    flexShrink: 1,
  },
  scrim: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  dialogWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: Space.xxl,
  },
  dialog: {
    width: '100%',
    maxWidth: 400,
    gap: Space.lg,
    paddingTop: Space.xxl,
    paddingHorizontal: Space.xxl,
    paddingBottom: Space.lg,
    borderRadius: Radius.xl,
  },
  dialogActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: Space.sm,
    marginTop: Space.xs,
  },
});
