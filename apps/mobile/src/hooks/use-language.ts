import { getLocales, useLocales, type Locale } from 'expo-localization';
import { useEffect, useSyncExternalStore } from 'react';

import { languageFor, onLanguageChange, setUiLanguage, uiLanguage, type Language } from '@/lib/i18n';

/** The language of the locale the system gives Corvus now (on Android 13+, Corvus's own language when one is set). */
function systemLanguage(locales: Locale[] = getLocales()): Language {
  return languageFor(locales[0]?.languageTag ?? '');
}

// Before anything is drawn (this module is loaded with the root layout).
setUiLanguage(systemLanguage());

/**
 * The app's language, following the phone's while Corvus runs: Android hands a change of Corvus's
 * language (Settings, Apps, Corvus, Language) to the running app instead of building its screen again.
 */
export function useAppLanguage(): Language {
  const locales = useLocales();
  useEffect(() => setUiLanguage(systemLanguage(locales)), [locales]);
  return useSyncExternalStore(onLanguageChange, uiLanguage);
}
