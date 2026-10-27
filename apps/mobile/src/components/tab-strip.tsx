import { useEffect, useRef, useState, type ComponentRef } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { Icon, type IconName } from '@/components/icon';
import { ThemedText } from '@/components/themed-text';
import { Space } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

export interface StripTab<K extends string> {
  key: K;
  label: string;
  icon: IconName;
  /** Read out instead of the label, when the label is a short form. */
  accessibilityLabel?: string;
  testID?: string;
}

/**
 * Tabs under a screen's title (Library's sections): an icon over a one-line label and an underline
 * under the chosen one, as Material's primary tabs. The tabs share the width equally; when their
 * labels do not fit (a narrow phone, a large font) the strip scrolls sideways instead of squeezing
 * or wrapping them, and keeps the chosen tab in view.
 */
export function TabStrip<K extends string>({ tabs, value, onChange }: { tabs: StripTab<K>[]; value: K; onChange: (key: K) => void }) {
  const theme = useTheme();
  const [width, setWidth] = useState(0);
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const spots = useRef<Record<string, { x: number; w: number }>>({});
  const offset = useRef(0);
  const [marks, setMarks] = useState<Record<string, number>>({});

  // Only when the chosen tab is partly out of view, scroll just enough to show it whole.
  useEffect(() => {
    const spot = spots.current[value];
    if (!spot || width <= 0) return;
    if (spot.x < offset.current) scroll.current?.scrollTo({ x: Math.max(0, spot.x - Space.sm), animated: true });
    else if (spot.x + spot.w > offset.current + width) scroll.current?.scrollTo({ x: spot.x + spot.w - width + Space.sm, animated: true });
  }, [value, width]);

  return (
    <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)} style={[styles.strip, { borderBottomColor: theme.divider }]}>
      <ScrollView
        ref={scroll}
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ minWidth: width }}
        accessibilityRole="tablist"
        scrollEventThrottle={32}
        onScroll={(e) => {
          offset.current = e.nativeEvent.contentOffset.x;
        }}
        bounces={false}>
        {tabs.map((tab) => {
          const chosen = tab.key === value;
          const color = chosen ? theme.accentText : theme.textSecondary;
          return (
            <Pressable
              key={tab.key}
              accessibilityRole="tab"
              accessibilityState={{ selected: chosen }}
              accessibilityLabel={tab.accessibilityLabel ?? tab.label}
              onPress={() => onChange(tab.key)}
              onLayout={(e) => {
                spots.current[tab.key] = { x: e.nativeEvent.layout.x, w: e.nativeEvent.layout.width };
              }}
              android_ripple={{ color: theme.ripple }}
              style={({ pressed }) => [styles.tab, width > 0 && { minWidth: width / tabs.length }, pressed && Platform.OS !== 'android' && { backgroundColor: theme.ripple }]}
              testID={tab.testID}>
              <View
                style={styles.content}
                onLayout={(e) => {
                  const w = e.nativeEvent.layout.width;
                  setMarks((m) => (m[tab.key] === w ? m : { ...m, [tab.key]: w }));
                }}>
                <Icon name={tab.icon} size={22} color={color} />
                <ThemedText type="label" style={{ color, fontWeight: '500' }} numberOfLines={1}>
                  {tab.label}
                </ThemedText>
              </View>
              <View style={[styles.underline, { width: Math.max(28, marks[tab.key] ?? 0), backgroundColor: chosen ? theme.accent : 'transparent' }]} />
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  strip: {
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  tab: {
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingHorizontal: Space.sm,
    minHeight: 64,
  },
  content: {
    alignItems: 'center',
    gap: 2,
    paddingTop: Space.sm,
    paddingBottom: Space.sm,
  },
  underline: {
    height: 3,
    borderTopLeftRadius: 3,
    borderTopRightRadius: 3,
  },
});
