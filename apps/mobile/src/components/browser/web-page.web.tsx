import { StyleSheet, View } from 'react-native';

import { Button } from '@/components/button';
import { Icon } from '@/components/icon';
import { ThemedText } from '@/components/themed-text';
import { Space } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import type { LoadRequest } from '@/lib/browser-store';
import { t } from '@/lib/i18n';
import type { BrowserTab } from '@/lib/tabs';

/**
 * The web build (automated checks only) has no WebView: the tab's page is a card that opens it in a
 * new browser tab, so the browser's own screens can still be checked.
 */
export function WebPage({ tab, request, visible }: { tab: BrowserTab; request: LoadRequest | undefined; visible: boolean; userAgent: string | undefined; gpc: boolean }) {
  const theme = useTheme();
  const url = request?.url || tab.url;
  if (!visible) return null;
  return (
    <View style={[StyleSheet.absoluteFill, styles.page, { backgroundColor: theme.background }]} testID="browser-page">
      <Icon name="globe" size={40} color={theme.textTertiary} />
      <ThemedText type="small" themeColor="textSecondary" style={styles.center} numberOfLines={3} testID="browser-page-url">
        {url}
      </ThemedText>
      <Button label={t('Open in your browser')} icon="external" kind="tonal" onPress={() => window.open(url, '_blank', 'noopener,noreferrer')} />
    </View>
  );
}

const styles = StyleSheet.create({
  page: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: Space.md,
    padding: Space.xxl,
  },
  center: {
    textAlign: 'center',
  },
});
