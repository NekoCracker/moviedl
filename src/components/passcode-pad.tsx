import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { AppText } from '@/components/app-text';
import { colors } from '@/theme';

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'bio', '0', 'del'] as const;

// 数字キーパッド。length 桁そろったら onComplete を呼び、入力をクリアする。
export function PasscodePad({
  title,
  message,
  length = 4,
  onComplete,
  onBiometrics,
  error,
}: {
  title: string;
  message?: string;
  length?: 4 | 6;
  onComplete: (code: string) => void;
  onBiometrics?: () => void;
  error?: string | null;
}) {
  const [code, setCode] = useState('');

  const press = (key: (typeof KEYS)[number]) => {
    if (key === 'bio') {
      onBiometrics?.();
      return;
    }
    if (key === 'del') {
      setCode((c) => c.slice(0, -1));
      return;
    }
    const next = code + key;
    if (next.length >= length) {
      setCode('');
      onComplete(next);
    } else {
      setCode(next);
    }
  };

  return (
    <View style={styles.container}>
      <AppText variant="title" accessibilityRole="header">
        {title}
      </AppText>
      {message ? (
        <AppText variant="caption" tone="secondary" style={styles.center}>
          {message}
        </AppText>
      ) : null}
      <View style={styles.dots} accessibilityLabel={`${code.length}桁入力済み`}>
        {Array.from({ length }, (_, i) => (
          <View key={i} style={[styles.dot, i < code.length && styles.dotFilled]} />
        ))}
      </View>
      <AppText variant="caption" style={[styles.center, styles.error]}>
        {error ?? ' '}
      </AppText>
      <View style={styles.grid}>
        {KEYS.map((key) => {
          if (key === 'bio' && !onBiometrics) return <View key={key} style={styles.key} />;
          return (
            <Pressable
              key={key}
              accessibilityRole="button"
              accessibilityLabel={key === 'bio' ? 'Face IDで解除' : key === 'del' ? '1文字削除' : key}
              onPress={() => press(key)}
              style={({ pressed }) => [styles.key, key !== 'bio' && key !== 'del' && styles.digitKey, pressed && styles.pressed]}>
              {key === 'bio' ? (
                <SymbolView name="faceid" tintColor={colors.text} size={28} />
              ) : key === 'del' ? (
                <SymbolView name="delete.left" tintColor={colors.text} size={24} />
              ) : (
                <AppText variant="title" style={styles.digit}>
                  {key}
                </AppText>
              )}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { alignItems: 'center', gap: 12, paddingHorizontal: 24 },
  center: { textAlign: 'center' },
  dots: { flexDirection: 'row', gap: 16, marginTop: 12 },
  dot: { width: 14, height: 14, borderRadius: 7, borderWidth: 1.5, borderColor: colors.textSecondary },
  dotFilled: { backgroundColor: colors.text, borderColor: colors.text },
  error: { color: colors.dangerText, minHeight: 20 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', width: 288, justifyContent: 'space-between', rowGap: 16 },
  key: { width: 80, height: 80, borderRadius: 40, alignItems: 'center', justifyContent: 'center' },
  digitKey: { backgroundColor: colors.surface },
  pressed: { opacity: 0.6 },
  digit: { fontSize: 30 },
});
