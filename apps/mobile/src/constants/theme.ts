/**
 * Corvus for mobile's design tokens: color roles for light and dark, spacing, radii, type scale and
 * elevation. Screens and components take every color, size and radius from here.
 *
 * Dark is tinted towards the indigo of the app icon (not pure black) and uses the desktop app's
 * light accent with dark text on it; light follows the desktop (cool off-white page, white cards
 * with a hairline border, accent #5B5BD6).
 */

import '@/global.css';

import { Platform, type TextStyle, type ViewStyle } from 'react-native';

export interface Palette {
  /** The page behind everything. */
  background: string;
  /** Cards and list groups. */
  surface: string;
  /** Dialogs, sheets, toasts, menus: above the surface. */
  surfaceRaised: string;
  /** Inside a text field. */
  field: string;
  /** Hairline around cards. */
  border: string;
  /** Outline of fields, outlined buttons and chips. */
  borderStrong: string;
  /** Between rows of a list. */
  divider: string;
  text: string;
  textSecondary: string;
  textTertiary: string;
  textDisabled: string;
  accent: string;
  accentPressed: string;
  /** Translucent accent: pressed rows, tonal buttons, focus halos. */
  accentSoft: string;
  /** Solid, quiet accent: the selected tab's pill, selected chips, badges. */
  accentContainer: string;
  onAccent: string;
  onAccentContainer: string;
  /** Accent as text on the page or a card (links, section headers). */
  accentText: string;
  danger: string;
  dangerSoft: string;
  onDanger: string;
  success: string;
  successSoft: string;
  warning: string;
  warningSoft: string;
  /** Behind a dialog. */
  scrim: string;
  /** Touch feedback on rows and buttons. */
  ripple: string;
  /** Behind a favicon, so dark icons stay visible on dark pages. */
  faviconTile: string;
  /** Home's header band, from the top down to the page. */
  heroFrom: string;
  heroTo: string;
  /** Disabled buttons. */
  disabledFill: string;
  // Older names, kept for screens and branches written before these tokens.
  backgroundElement: string;
  backgroundSelected: string;
}

const dark: Palette = {
  background: '#12121b',
  surface: '#1b1b28',
  surfaceRaised: '#252536',
  field: '#14141f',
  border: '#2a2a3d',
  borderStrong: '#43435c',
  divider: '#262637',
  text: '#ececf3',
  textSecondary: '#a7a7bc',
  textTertiary: '#7b7b92',
  textDisabled: '#5d5d73',
  accent: '#8b8cf8',
  accentPressed: '#a5a6fb',
  accentSoft: 'rgba(139, 140, 248, 0.14)',
  accentContainer: '#2d2d58',
  onAccent: '#14142b',
  onAccentContainer: '#dcdcff',
  accentText: '#a5a6fb',
  danger: '#f28b82',
  dangerSoft: 'rgba(242, 139, 130, 0.13)',
  onDanger: '#2d0f0c',
  success: '#81c995',
  successSoft: 'rgba(129, 201, 149, 0.13)',
  warning: '#fdd663',
  warningSoft: 'rgba(253, 214, 99, 0.12)',
  scrim: 'rgba(4, 4, 10, 0.66)',
  ripple: 'rgba(236, 236, 243, 0.10)',
  faviconTile: '#e9e9f1',
  heroFrom: '#24244a',
  heroTo: '#12121b',
  disabledFill: 'rgba(236, 236, 243, 0.08)',
  backgroundElement: '#1b1b28',
  backgroundSelected: '#252536',
};

const light: Palette = {
  background: '#f6f7f9',
  surface: '#ffffff',
  surfaceRaised: '#ffffff',
  field: '#ffffff',
  border: '#e3e5ea',
  borderStrong: '#c5c8d1',
  divider: '#eceef2',
  text: '#1b1c22',
  textSecondary: '#5b5f6e',
  textTertiary: '#858998',
  textDisabled: '#a8acb8',
  accent: '#5b5bd6',
  accentPressed: '#4646c0',
  accentSoft: 'rgba(91, 91, 214, 0.10)',
  accentContainer: '#e5e5fb',
  onAccent: '#ffffff',
  onAccentContainer: '#28288c',
  accentText: '#4949c4',
  danger: '#d93025',
  dangerSoft: 'rgba(217, 48, 37, 0.08)',
  onDanger: '#ffffff',
  success: '#188038',
  successSoft: 'rgba(24, 128, 56, 0.09)',
  warning: '#9a5400',
  warningSoft: 'rgba(176, 96, 0, 0.10)',
  scrim: 'rgba(16, 16, 32, 0.42)',
  ripple: 'rgba(27, 28, 34, 0.08)',
  faviconTile: '#f1f2f6',
  heroFrom: '#e6e6fa',
  heroTo: '#f6f7f9',
  disabledFill: 'rgba(27, 28, 34, 0.07)',
  backgroundElement: '#ffffff',
  backgroundSelected: '#eceef2',
};

export const Colors = { light, dark } as const;

export type ThemeColor = keyof Palette;

/** Spacing on a 4 dp grid. */
export const Space = {
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
  huge: 48,
} as const;

/** Older spacing names (2, 4, 8, 16, 24, 32, 64). */
export const Spacing = {
  half: 2,
  one: 4,
  two: 8,
  three: 16,
  four: 24,
  five: 32,
  six: 64,
} as const;

/** Corner radii by what they round: small parts, controls, cards, sheets and dialogs, pills. */
export const Radius = {
  xs: 6,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 28,
  pill: 999,
} as const;

/** Layout constants: page gutter, widest content, row and touch-target heights. */
export const Layout = {
  gutter: 16,
  maxWidth: 720,
  /** Material's minimum touch target. */
  touch: 48,
  row: 56,
  rowTwoLine: 68,
  /** Space left under the last item of a tab's scroll view. */
  tabBottom: 24,
} as const;

export const MaxContentWidth = Layout.maxWidth;
/** Extra room at the end of a tab's scroll view (the native tab bar already takes its own space). */
export const BottomTabInset = Layout.tabBottom;

const sans = Platform.select({ web: 'Roboto, "Segoe UI", system-ui, -apple-system, sans-serif', default: undefined });

/** Type scale by role. Android uses Roboto (the system font); the web build asks for it too. */
export const Type = {
  /** A tab's large title (Library, Settings). */
  display: { fontFamily: sans, fontSize: 28, lineHeight: 36, fontWeight: '700', letterSpacing: -0.2 },
  /** Home's wordmark and dialog titles. */
  title: { fontFamily: sans, fontSize: 20, lineHeight: 28, fontWeight: '600' },
  /** A card's or an item's title. */
  heading: { fontFamily: sans, fontSize: 17, lineHeight: 24, fontWeight: '600' },
  body: { fontFamily: sans, fontSize: 16, lineHeight: 24, fontWeight: '400' },
  bodyStrong: { fontFamily: sans, fontSize: 16, lineHeight: 24, fontWeight: '500' },
  small: { fontFamily: sans, fontSize: 14, lineHeight: 20, fontWeight: '400' },
  smallStrong: { fontFamily: sans, fontSize: 14, lineHeight: 20, fontWeight: '600' },
  /** Buttons, tabs, chips and section headers. */
  label: { fontFamily: sans, fontSize: 14, lineHeight: 20, fontWeight: '600', letterSpacing: 0.1 },
  caption: { fontFamily: sans, fontSize: 12, lineHeight: 16, fontWeight: '500', letterSpacing: 0.2 },
  code: { fontFamily: Platform.select({ ios: 'ui-monospace', web: 'var(--font-mono)', default: 'monospace' }), fontSize: 13, lineHeight: 18, fontWeight: '400' },
} satisfies Record<string, TextStyle>;

export type TypeName = keyof typeof Type;

/** Two levels: cards in light mode (a soft lift), and what floats (dialogs, toasts, the add button). */
export const Elevation = {
  card: Platform.select<ViewStyle>({
    web: { boxShadow: '0 1px 2px rgba(20, 20, 40, 0.04)' } as ViewStyle,
    default: { elevation: 0 },
  }),
  overlay: Platform.select<ViewStyle>({
    web: { boxShadow: '0 8px 28px rgba(10, 10, 30, 0.28)' } as ViewStyle,
    default: { elevation: 8, shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 16, shadowOffset: { width: 0, height: 6 } },
  }),
};

/** Older font names, kept for the code font. */
export const Fonts = Platform.select({
  ios: { sans: 'system-ui', serif: 'ui-serif', rounded: 'ui-rounded', mono: 'ui-monospace' },
  default: { sans: 'normal', serif: 'serif', rounded: 'normal', mono: 'monospace' },
  web: { sans: 'var(--font-display)', serif: 'var(--font-serif)', rounded: 'var(--font-rounded)', mono: 'var(--font-mono)' },
});
