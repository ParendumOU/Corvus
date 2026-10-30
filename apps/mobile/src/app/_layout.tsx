import '@/polyfills';
// Defines the background check before anything else, as the system requires.
import '@/lib/background';

import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';
import { useEffect, useMemo } from 'react';

import { FeedbackHost } from '@/components/feedback';
import { useAppLanguage } from '@/hooks/use-language';
import { useRouteMemory } from '@/hooks/use-route-memory';
import { openReceived } from '@/hooks/use-session';
import { useScheme, useTheme } from '@/hooks/use-theme';
import { t } from '@/lib/i18n';
import { onNotificationTap } from '@/lib/notifications';
import { nav } from '@/lib/nav';

SplashScreen.preventAutoHideAsync();

// A screen opened from a link, or brought back after Android ended the app, has the tabs under it.
export const unstable_settings = { anchor: '(tabs)' };

export default function RootLayout() {
  const scheme = useScheme();
  const theme = useTheme();
  const language = useAppLanguage();
  useRouteMemory();
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
        else nav.push('/watches');
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
      {/* Every screen is drawn again in a new language; the navigation state stays where it is. */}
      <Screens key={language} />
    </ThemeProvider>
  );
}

function Screens() {
  const theme = useTheme();
  return (
    <>
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: theme.background },
          headerShadowVisible: false,
          headerTintColor: theme.text,
          headerTitleStyle: { fontSize: 20, fontWeight: '600', color: theme.text },
          contentStyle: { backgroundColor: theme.background },
        }}>
        {/* Its title is what iOS's back button reads in the screens opened from the tabs (not "(tabs)"). */}
        <Stack.Screen name="(tabs)" options={{ headerShown: false, title: 'Corvus' }} />
        <Stack.Screen name="pair" options={{ presentation: 'modal', title: t('Pair with a computer') }} />
        <Stack.Screen name="send" options={{ presentation: 'modal', title: t('Save or send a page') }} />
        <Stack.Screen name="open" options={{ presentation: 'modal', title: t('Open link') }} />
        <Stack.Screen name="watches" options={{ title: t('Watched pages') }} />
        <Stack.Screen name="ask" options={{ title: t('Assist') }} />
        <Stack.Screen name="chat/[id]" options={{ title: t('Assist') }} />
        {/* One browser screen at most: links that come in while it is open go to it. Its title is what
            iOS's back button reads in Browser settings. */}
        <Stack.Screen name="browser" options={{ headerShown: false, title: t('Browser'), animation: 'fade_from_bottom' }} dangerouslySingular />
        <Stack.Screen name="browser-settings" options={{ title: t('Browser settings') }} />
        <Stack.Screen name="licenses" options={{ title: t('Third-party licences') }} />
      </Stack>
      <FeedbackHost />
    </>
  );
}
