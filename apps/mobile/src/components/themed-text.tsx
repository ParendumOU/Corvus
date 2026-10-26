import { Platform, StyleSheet, Text, type TextProps } from 'react-native';

import { Fonts, ThemeColor } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

export type ThemedTextProps = TextProps & {
  type?: 'default' | 'title' | 'small' | 'smallBold' | 'subtitle' | 'heading' | 'body' | 'label' | 'link' | 'linkPrimary' | 'code';
  themeColor?: ThemeColor;
};

export function ThemedText({ style, type = 'default', themeColor, ...rest }: ThemedTextProps) {
  const theme = useTheme();

  return <Text style={[{ color: theme[themeColor ?? 'text'] }, styles[type], style]} {...rest} />;
}

const styles = StyleSheet.create({
  small: {
    fontSize: 14,
    lineHeight: 20,
    fontWeight: 500,
  },
  smallBold: {
    fontSize: 14,
    lineHeight: 20,
    fontWeight: 700,
  },
  default: {
    fontSize: 16,
    lineHeight: 24,
    fontWeight: 500,
  },
  title: {
    fontSize: 44,
    fontWeight: 700,
    lineHeight: 50,
  },
  /** A screen's title. */
  subtitle: {
    fontSize: 32,
    lineHeight: 40,
    fontWeight: 700,
  },
  /** A card's or a section's title. */
  heading: {
    fontSize: 18,
    lineHeight: 24,
    fontWeight: 600,
  },
  /** Running text: explanations and descriptions. */
  body: {
    fontSize: 15,
    lineHeight: 22,
    fontWeight: 400,
  },
  /** A section's name above its card. */
  label: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: 600,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  link: {
    lineHeight: 30,
    fontSize: 14,
  },
  linkPrimary: {
    lineHeight: 30,
    fontSize: 14,
    color: '#3c87f7',
  },
  code: {
    fontFamily: Fonts.mono,
    fontWeight: Platform.select({ android: 700 }) ?? 500,
    fontSize: 12,
  },
});
