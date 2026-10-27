import { Text, type TextProps, type TextStyle } from 'react-native';

import { Type, type ThemeColor, type TypeName } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

/** Older type names, mapped onto the type scale. */
const LEGACY: Record<string, TextStyle> = {
  default: Type.body,
  subtitle: Type.display,
  smallBold: Type.smallStrong,
  link: Type.small,
  linkPrimary: Type.small,
};

export type ThemedTextProps = TextProps & {
  type?: TypeName | 'default' | 'subtitle' | 'smallBold' | 'link' | 'linkPrimary';
  themeColor?: ThemeColor;
};

export function ThemedText({ style, type = 'body', themeColor, ...rest }: ThemedTextProps) {
  const theme = useTheme();
  const scale = (Type as Record<string, TextStyle>)[type] ?? LEGACY[type] ?? Type.body;
  const color = theme[themeColor ?? (type === 'linkPrimary' ? 'accentText' : 'text')];
  return <Text style={[{ color }, scale, style]} {...rest} />;
}
