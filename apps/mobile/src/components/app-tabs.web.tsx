import { Tabs, TabList, TabTrigger, TabSlot, type TabTriggerSlotProps, type TabListProps } from 'expo-router/ui';
import { Pressable, StyleSheet, View } from 'react-native';

import { Icon, type IconName } from '@/components/icon';
import { ThemedText } from '@/components/themed-text';
import { Space } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { t } from '@/lib/i18n';

/** Height of the bottom bar: the screens end above it instead of under it. */
const TAB_BAR_HEIGHT = 80;

/**
 * The web build's tab bar (the native one is app-tabs.tsx), drawn like Android's navigation bar so
 * the browser checks see the screens as a phone shows them.
 */
export default function AppTabs() {
  return (
    <Tabs>
      <TabSlot style={{ height: '100%', paddingBottom: TAB_BAR_HEIGHT }} />
      <TabList asChild>
        <CustomTabList>
          <TabTrigger name="index" href="/" asChild>
            <TabButton icon="home">{t('Home')}</TabButton>
          </TabTrigger>
          <TabTrigger name="library" href="/library" asChild>
            <TabButton icon="bookmark">{t('Library')}</TabButton>
          </TabTrigger>
          <TabTrigger name="settings" href="/settings" asChild>
            <TabButton icon="settings">{t('Settings')}</TabButton>
          </TabTrigger>
        </CustomTabList>
      </TabList>
    </Tabs>
  );
}

export function TabButton({ children, icon, isFocused, ref: _ref, ...props }: TabTriggerSlotProps & { icon: IconName }) {
  const theme = useTheme();
  return (
    <Pressable {...props} style={styles.tab}>
      <View style={[styles.pill, isFocused && { backgroundColor: theme.accentContainer }]}>
        <Icon name={icon} size={22} color={isFocused ? theme.onAccentContainer : theme.textSecondary} />
      </View>
      <ThemedText type="caption" style={{ color: isFocused ? theme.text : theme.textSecondary, fontWeight: isFocused ? '700' : '500' }}>
        {children}
      </ThemedText>
    </Pressable>
  );
}

export function CustomTabList(props: TabListProps) {
  const theme = useTheme();
  return <View {...props} style={[styles.bar, { backgroundColor: theme.surface, borderTopColor: theme.border }]} />;
}

const styles = StyleSheet.create({
  bar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: TAB_BAR_HEIGHT,
    flexDirection: 'row',
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Space.xs,
  },
  pill: {
    width: 64,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
