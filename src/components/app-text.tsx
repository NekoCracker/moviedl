import { Text, type TextProps } from 'react-native';

import { colors, fonts } from '@/theme';

type Variant = 'largeTitle' | 'title' | 'body' | 'bodyBold' | 'caption' | 'small';
type Tone = 'primary' | 'secondary' | 'muted' | 'accent' | 'onAccent';

const variantStyles = {
  largeTitle: { fontFamily: fonts.bold, fontSize: 30, letterSpacing: 0.6 },
  title: { fontFamily: fonts.bold, fontSize: 18 },
  body: { fontFamily: fonts.medium, fontSize: 14 },
  bodyBold: { fontFamily: fonts.bold, fontSize: 15 },
  caption: { fontFamily: fonts.regular, fontSize: 13 },
  small: { fontFamily: fonts.regular, fontSize: 12 },
} as const;

const toneColors: Record<Tone, string> = {
  primary: colors.text,
  secondary: colors.textSecondary,
  muted: colors.textMuted,
  accent: colors.accent,
  onAccent: colors.onAccent,
};

export function AppText({
  variant = 'body',
  tone = 'primary',
  style,
  ...rest
}: TextProps & { variant?: Variant; tone?: Tone }) {
  return <Text {...rest} style={[variantStyles[variant], { color: toneColors[tone] }, style]} />;
}
