import { Colors, type Palette } from '@/constants/theme';
import { useColorScheme } from '@/hooks/use-color-scheme';

/** The color scheme the app draws in: the phone's. */
export function useScheme(): 'light' | 'dark' {
  return useColorScheme() === 'dark' ? 'dark' : 'light';
}

/** The color roles of the current scheme (see constants/theme.ts). */
export function useTheme(): Palette {
  return Colors[useScheme()];
}
