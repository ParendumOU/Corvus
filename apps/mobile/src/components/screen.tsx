import { useEffect, useRef, useState, type ComponentRef, type ReactNode } from 'react';
import { Keyboard, KeyboardAvoidingView, Platform, RefreshControl, ScrollView, StyleSheet, TextInput, View, type StyleProp, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { Layout, Space } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

/**
 * A screen's scrolling page: the page color, a centered column 16 dp from the edges, room for the
 * keyboard (fields stay visible while typing) and pull to refresh.
 *
 * - `tab`: a tab of the bottom bar. It draws its own title under the status bar; the tab bar keeps
 *   its own space at the bottom.
 * - otherwise a screen pushed over the tabs, under the navigation header: it keeps clear of the
 *   gesture bar at the bottom.
 */
export function Screen({
  children,
  tab,
  header,
  refreshing,
  onRefresh,
  contentStyle,
  floating,
  onScrolled,
  testID,
}: {
  children: ReactNode;
  tab?: boolean;
  /** Called with true once the page is scrolled away from its top, and false back at the top. */
  onScrolled?: (away: boolean) => void;
  /** Above the scrolling page (a floating button); the page leaves room for it at the end. */
  floating?: ReactNode;
  /** Drawn above the column, full width (Home's header band). */
  header?: ReactNode;
  refreshing?: boolean;
  onRefresh?: () => void;
  contentStyle?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const offset = useRef(0);
  const [away, setAway] = useState(false);

  // Once the keyboard is up, scroll the field being typed in (and a little room under it) into view.
  useEffect(() => {
    if (Platform.OS === 'web') return;
    const sub = Keyboard.addListener('keyboardDidShow', (e) => {
      setTimeout(() => {
        const input = TextInput.State.currentlyFocusedInput();
        if (!input || !scroll.current) return;
        input.measureInWindow((_x, y, _w, height) => {
          const overlap = y + height + Space.xxxl - e.endCoordinates.screenY;
          if (overlap > 0) scroll.current?.scrollTo({ y: offset.current + overlap, animated: true });
        });
      }, 150);
    });
    return () => sub.remove();
  }, []);

  return (
    <KeyboardAvoidingView style={[styles.fill, { backgroundColor: theme.background }]} behavior={Platform.OS === 'web' ? undefined : 'padding'} testID={testID}>
      <ScrollView
        ref={scroll}
        style={styles.fill}
        contentContainerStyle={[
          styles.scroll,
          { paddingTop: tab && !header ? insets.top : 0, paddingBottom: (tab ? Layout.tabBottom : insets.bottom + Space.xxl) + (floating ? 72 : 0) },
        ]}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        scrollEventThrottle={32}
        onScroll={(e) => {
          const y = e.nativeEvent.contentOffset.y;
          offset.current = y;
          setAway((was) => (was === y > 8 ? was : y > 8));
          onScrolled?.(y > 24);
        }}
        refreshControl={
          onRefresh ? (
            <RefreshControl
              refreshing={!!refreshing}
              onRefresh={onRefresh}
              colors={[theme.accent]}
              tintColor={theme.accent}
              progressBackgroundColor={theme.surfaceRaised}
              progressViewOffset={tab ? insets.top : 0}
            />
          ) : undefined
        }>
        {header}
        <View style={[styles.column, contentStyle]}>{children}</View>
      </ScrollView>
      {/* The status bar is see-through (edge to edge): on a tab, the page scrolls under a strip of
          its own color, so the clock never sits over content. */}
      {tab && (!header || away) ? <View pointerEvents="none" style={[styles.statusStrip, { height: insets.top, backgroundColor: theme.background }]} /> : null}
      {floating}
    </KeyboardAvoidingView>
  );
}

/** A tab's large title, with an optional action on its right. */
export function ScreenTitle({ title, trailing, testID }: { title: string; trailing?: ReactNode; testID?: string }) {
  return (
    <View style={styles.title}>
      <ThemedText type="display" accessibilityRole="header" style={styles.grow} numberOfLines={1} testID={testID}>
        {title}
      </ThemedText>
      {trailing}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
  },
  scroll: {
    flexGrow: 1,
  },
  statusStrip: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
  },
  column: {
    width: '100%',
    maxWidth: Layout.maxWidth,
    alignSelf: 'center',
    paddingHorizontal: Layout.gutter,
    paddingTop: Space.lg,
    gap: Space.lg,
  },
  title: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 56,
    paddingTop: Space.sm,
    paddingHorizontal: Space.xs,
  },
  grow: {
    flex: 1,
  },
});
