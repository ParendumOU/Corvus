import '@/polyfills';
// Defines the background check before anything else, as the system requires.
import '@/lib/background';

import { DarkTheme, DefaultTheme, Stack, ThemeProvider, router } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect } from 'react';
import { useColorScheme } from 'react-native';

import { openReceived } from '@/hooks/use-session';
import { t } from '@/lib/i18n';
import { onNotificationTap } from '@/lib/notifications';

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const colorScheme = useColorScheme();
  useEffect(() => {
    void SplashScreen.hideAsync();
  }, []);
  // A tapped notification opens the page sent here, or the watched pages.
  useEffect(
    () =>
      onNotificationTap((tap) => {
        if (tap.kind === 'sent' && tap.recordId) void openReceived(tap.recordId, tap.url);
        else router.push('/watches');
      }),
    [],
  );
  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      <Stack>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="pair" options={{ presentation: 'modal', title: t('Pair with a computer') }} />
        <Stack.Screen name="send" options={{ presentation: 'modal', title: t('Save or send a page') }} />
        <Stack.Screen name="watches" options={{ title: t('Watched pages') }} />
        <Stack.Screen name="ask" options={{ title: t('Ask Corvus') }} />
      </Stack>
    </ThemeProvider>
  );
}
