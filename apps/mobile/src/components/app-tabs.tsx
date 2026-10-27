import { NativeTabs } from 'expo-router/native-tabs';

import { useTheme } from '@/hooks/use-theme';
import { t } from '@/lib/i18n';

/** The bottom navigation bar (Material's navigation bar on Android); the web build has app-tabs.web.tsx. */
export default function AppTabs() {
  const theme = useTheme();
  return (
    <NativeTabs
      backgroundColor={theme.surface}
      indicatorColor={theme.accentContainer}
      rippleColor={theme.ripple}
      iconColor={{ default: theme.textSecondary, selected: theme.onAccentContainer }}
      labelStyle={{ default: { color: theme.textSecondary, fontSize: 12, fontWeight: '500' }, selected: { color: theme.text, fontSize: 12, fontWeight: '700' } }}
      labelVisibilityMode="labeled">
      <NativeTabs.Trigger name="index">
        <NativeTabs.Trigger.Label>{t('Home')}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon src={require('@/assets/images/tabIcons/home.png')} renderingMode="template" />
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="library">
        <NativeTabs.Trigger.Label>{t('Library')}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon src={require('@/assets/images/tabIcons/library.png')} renderingMode="template" />
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name="settings">
        <NativeTabs.Trigger.Label>{t('Settings')}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon src={require('@/assets/images/tabIcons/settings.png')} renderingMode="template" />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
