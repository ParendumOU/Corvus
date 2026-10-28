import { FlatList, Platform, Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button, IconButton } from '@/components/button';
import { Favicon } from '@/components/favicon';
import { confirm } from '@/components/feedback';
import { Icon } from '@/components/icon';
import { ThemedText } from '@/components/themed-text';
import { Elevation, Radius, Space } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { displayAddress } from '@/lib/address';
import { t } from '@/lib/i18n';
import type { BrowserTab } from '@/lib/tabs';

/** The phone's tabs as a grid of cards (site icon, title, address), newest last; tap one to show it. */
export function TabSwitcher({
  open,
  tabs,
  activeId,
  onPick,
  onCloseTab,
  onCloseAll,
  onNewTab,
  onDismiss,
}: {
  open: boolean;
  tabs: readonly BrowserTab[];
  activeId: string | null;
  onPick: (id: string) => void;
  onCloseTab: (id: string) => void;
  onCloseAll: () => void;
  onNewTab: () => void;
  onDismiss: () => void;
}) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const columns = width >= 600 ? 3 : 2;

  if (!open) return null;

  const closeAll = async (): Promise<void> => {
    const ok = await confirm({ title: t('Close all tabs?'), message: t('{n} tabs close. Their pages stay in your history.', { n: tabs.length }), confirmLabel: t('Close all'), destructive: true });
    if (ok) onCloseAll();
  };

  return (
    // Drawn over the browser rather than in a Modal, so the status bar keeps the app's colors.
    <View style={[StyleSheet.absoluteFill, { backgroundColor: theme.background, paddingTop: insets.top }]} testID="tab-switcher">
        <View style={styles.header}>
          <IconButton icon="back" accessibilityLabel={t('Back to the page')} onPress={onDismiss} testID="tabs-back" />
          <ThemedText type="title" style={styles.grow} accessibilityRole="header">
            {tabs.length === 1 ? t('1 tab') : t('{n} tabs', { n: tabs.length })}
          </ThemedText>
          {tabs.length > 1 ? <Button label={t('Close all')} kind="text" size="sm" onPress={() => void closeAll()} testID="tabs-close-all" /> : null}
        </View>
        <FlatList
          data={tabs}
          key={columns}
          numColumns={columns}
          keyExtractor={(tab) => tab.id}
          contentContainerStyle={[styles.grid, { paddingBottom: insets.bottom + 96 }]}
          columnWrapperStyle={styles.row}
          renderItem={({ item }) => {
            const active = item.id === activeId;
            return (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                accessibilityLabel={item.title || displayAddress(item.url) || t('New tab')}
                onPress={() => onPick(item.id)}
                android_ripple={{ color: theme.ripple }}
                style={({ pressed }) => [
                  styles.card,
                  { backgroundColor: theme.surface, borderColor: active ? theme.accent : theme.border },
                  active && styles.cardActive,
                  pressed && Platform.OS !== 'android' && { opacity: 0.85 },
                ]}
                testID={`tab-card-${item.url || 'new'}`}>
                <View style={styles.cardHead}>
                  {item.url ? <Favicon url={item.url} size={20} /> : <Icon name="plus" size={20} color={theme.textSecondary} />}
                  <ThemedText type="caption" themeColor="textSecondary" numberOfLines={1} style={styles.grow}>
                    {displayAddress(item.url) || t('New tab')}
                  </ThemedText>
                  <IconButton icon="close" size={18} accessibilityLabel={t('Close tab')} onPress={() => onCloseTab(item.id)} testID={`tab-close-${item.url || 'new'}`} />
                </View>
                <View style={[styles.preview, { backgroundColor: theme.background }]}>
                  {item.url ? <Favicon url={item.url} size={40} /> : <Icon name="search" size={32} color={theme.textTertiary} />}
                  <ThemedText type="smallStrong" numberOfLines={3} style={styles.center}>
                    {item.title || displayAddress(item.url) || t('New tab')}
                  </ThemedText>
                </View>
              </Pressable>
            );
          }}
        />
        <View style={[styles.fab, { bottom: insets.bottom + Space.lg }]} pointerEvents="box-none">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('New tab')}
            onPress={onNewTab}
            android_ripple={{ color: theme.accentSoft }}
            style={[styles.fabButton, { backgroundColor: theme.accentContainer }, Elevation.overlay]}
            testID="tabs-new">
            <Icon name="plus" size={22} color={theme.onAccentContainer} />
            <ThemedText type="label" style={{ color: theme.onAccentContainer }}>
              {t('New tab')}
            </ThemedText>
          </Pressable>
        </View>
    </View>
  );
}

const CARD_HEIGHT = 196;

const styles = StyleSheet.create({
  fill: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.xs,
    paddingHorizontal: Space.xs,
    minHeight: 56,
  },
  grow: {
    flex: 1,
  },
  grid: {
    paddingHorizontal: Space.md,
    paddingTop: Space.sm,
    gap: Space.md,
  },
  row: {
    gap: Space.md,
  },
  card: {
    flex: 1,
    height: CARD_HEIGHT,
    borderRadius: Radius.lg,
    borderWidth: 1,
    overflow: 'hidden',
  },
  cardActive: {
    borderWidth: 2,
  },
  cardHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.sm,
    paddingLeft: Space.md,
    height: 44,
  },
  preview: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Space.sm,
    paddingHorizontal: Space.sm,
  },
  center: {
    textAlign: 'center',
  },
  fab: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  fabButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.md,
    minHeight: 56,
    paddingLeft: Space.lg,
    paddingRight: Space.xl,
    borderRadius: Radius.lg,
    overflow: 'hidden',
  },
});
