// デザイン案（https://claude.ai/artifact/1JQNWhTLhQ1qiVnLdqPV1G）のトークン
export const colors = {
  background: '#0E0F12',
  surface: '#1A1C21',
  surfaceRaised: '#24272E',
  surfaceMuted: '#16181C',
  tabBar: '#121317',
  border: '#22252B',
  text: '#F2F2F4',
  textSecondary: '#A3A7B0',
  textMuted: '#8A8E97',
  accent: '#FF8A3D',
  accentSoft: '#2A2118',
  onAccent: '#111111',
  info: '#4DA3FF',
  success: '#3DDC97',
  dangerText: '#FFB4A8',
  dangerSurface: '#2A1E1E',
} as const;

export const fonts = {
  regular: 'ZenKakuGothicNew_400Regular',
  medium: 'ZenKakuGothicNew_500Medium',
  bold: 'ZenKakuGothicNew_700Bold',
} as const;

export const radius = {
  sm: 8,
  md: 12,
  lg: 14,
  xl: 22,
} as const;

// サムネイル未生成時のプレースホルダー色（IDから決定的に選ぶ）
const placeholderTints = ['#2B3A4A', '#3A3448', '#4A3A2E', '#2E4A40', '#46333A', '#33404A', '#40382B'];

export function placeholderTint(id: number): string {
  return placeholderTints[Math.abs(id) % placeholderTints.length];
}
