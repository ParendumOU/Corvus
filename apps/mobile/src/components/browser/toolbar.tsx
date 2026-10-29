import { Platform, Pressable, StyleSheet, View } from 'react-native';

import { IconButton } from '@/components/button';
import { CorvusMark } from '@/components/icon';
import { ThemedText } from '@/components/themed-text';
import { Radius, Space } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { t, tn } from '@/lib/i18n';

/** The browser's bottom bar: back, forward, Corvus (Home), the tabs and the page's menu. */
export function Toolbar({
  canGoBack,
  canGoForward,
  tabCount,
  bottomInset,
  onBack,
  onForward,
  onHome,
  onTabs,
  onMenu,
}: {
  canGoBack: boolean;
  canGoForward: boolean;
  tabCount: number;
  bottomInset: number;
  onBack: () => void;
  onForward: () => void;
  onHome: () => void;
  onTabs: () => void;
  onMenu: () => void;
}) {
  const theme = useTheme();
  return (
    <View style={[styles.bar, { backgroundColor: theme.surface, borderTopColor: theme.border, paddingBottom: bottomInset }]}>
      <IconButton icon="back" accessibilityLabel={t('Back')} onPress={onBack} disabled={!canGoBack} testID="browser-back" />
      <IconButton icon="forward" accessibilityLabel={t('Forward')} onPress={onForward} disabled={!canGoForward} testID="browser-forward" />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('Corvus home')}
        onPress={onHome}
        android_ripple={{ color: theme.ripple, borderless: true, radius: 24 }}
        style={({ pressed }) => [styles.home, pressed && Platform.OS !== 'android' && { opacity: 0.7 }]}
        testID="browser-home">
        <CorvusMark size={28} />
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={tn(tabCount, '1 tab open', '{n} tabs open')}
        onPress={onTabs}
        android_ripple={{ color: theme.ripple, borderless: true, radius: 24 }}
        style={({ pressed }) => [styles.tabs, pressed && Platform.OS !== 'android' && { opacity: 0.7 }]}
        testID="browser-tabs">
        <View style={[styles.tabsBox, { borderColor: theme.textSecondary }]}>
          <ThemedText type="caption" style={[styles.tabsCount, { color: theme.textSecondary }]}>
            {tabCount > 99 ? '99+' : String(tabCount)}
          </ThemedText>
        </View>
      </Pressable>
      <IconButton icon="more" accessibilityLabel={t('Page menu')} onPress={onMenu} testID="browser-menu" />
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: Space.xxs,
  },
  home: {
    width: 48,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabs: {
    width: 48,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabsBox: {
    minWidth: 22,
    height: 22,
    paddingHorizontal: 3,
    borderWidth: 2,
    borderRadius: Radius.xs,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabsCount: {
    fontSize: 11,
    lineHeight: 14,
    fontWeight: '700',
  },
});
