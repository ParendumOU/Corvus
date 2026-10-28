import '@/polyfills';
// Defines the background check before anything else, as the system requires.
import '@/lib/background';

import { DarkTheme, DefaultTheme, Stack, ThemeProvider, router } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';
import { useEffect, useMemo } from 'react';

import { FeedbackHost } from '@/components/feedback';
import { openReceived } from '@/hooks/use-session';
import { useScheme, useTheme } from '@/hooks/use-theme';
import { t } from '@/lib/i18n';
import { onNotificationTap } from '@/lib/notifications';

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const scheme = useScheme();
  const theme = useTheme();
  useEffect(() => {
    void SplashScreen.hideAsync();
  }, []);
  // The window behind the screens takes the page color, so no white shows between them.
  useEffect(() => {
    void SystemUI.setBackgroundColorAsync(theme.background).catch(() => undefined);
  }, [theme.background]);
  // A tapped notification opens the page sent here, or the watched pages.
  useEffect(
    () =>
      onNotificationTap((tap) => {
        if (tap.kind === 'sent' && tap.recordId) void openReceived(tap.recordId, tap.url);
        else router.push('/watches');
      }),
    [],
  );
  const navigation = useMemo(() => {
    const base = scheme === 'dark' ? DarkTheme : DefaultTheme;
    return {
      ...base,
      colors: { ...base.colors, primary: theme.accent, background: theme.background, card: theme.background, text: theme.text, border: theme.divider, notification: theme.accent },
    };
  }, [scheme, theme]);
  return (
    <ThemeProvider value={navigation}>
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: theme.background },
          headerShadowVisible: false,
          headerTintColor: theme.text,
          headerTitleStyle: { fontSize: 20, fontWeight: '600', color: theme.text },
          contentStyle: { backgroundColor: theme.background },
        }}>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="pair" options={{ presentation: 'modal', title: t('Pair with a computer') }} />
        <Stack.Screen name="send" options={{ presentation: 'modal', title: t('Save or send a page') }} />
        <Stack.Screen name="open" options={{ presentation: 'modal', title: t('Open link') }} />
        <Stack.Screen name="watches" options={{ title: t('Watched pages') }} />
        <Stack.Screen name="ask" options={{ title: t('Assist') }} />
        <Stack.Screen name="chat/[id]" options={{ title: t('Assist') }} />
        {/* One browser screen at most: links that come in while it is open go to it. */}
        <Stack.Screen name="browser" options={{ headerShown: false, animation: 'fade_from_bottom' }} dangerouslySingular />
        <Stack.Screen name="browser-settings" options={{ title: t('Browser settings') }} />
      </Stack>
      <FeedbackHost />
    </ThemeProvider>
  );
}
