import { router } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { AppText } from '@/components/app-text';
import { licenses } from '@/licenses';
import { colors, radius } from '@/theme';

export default function LicensesScreen() {
  const [open, setOpen] = useState<number | null>(null);

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <View style={styles.headerButton} />
        <AppText variant="bodyBold" accessibilityRole="header">
          ライセンス
        </AppText>
        <Pressable accessibilityRole="button" onPress={() => router.back()} style={styles.headerButton}>
          <AppText variant="body" tone="accent">
            閉じる
          </AppText>
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        <AppText variant="small" tone="secondary" style={styles.lead}>
          このアプリは次のソフトウェアを利用しています。LGPL のライブラリは動的フレームワークとして組み込んでおり、下記の入手先のソースから差し替えることができます。
        </AppText>
        {licenses.map((entry, i) => {
          const expanded = open === i;
          return (
            <View key={entry.name} style={styles.card}>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ expanded }}
                onPress={() => setOpen(expanded ? null : i)}
                style={styles.cardHeader}>
                <View style={styles.cardText}>
                  <AppText variant="bodyBold">{entry.name}</AppText>
                  <AppText variant="small" tone="secondary">
                    {entry.license}・{entry.usage}
                  </AppText>
                </View>
                <SymbolView name={expanded ? 'chevron.up' : 'chevron.down'} tintColor={colors.textMuted} size={14} />
              </Pressable>
              {expanded ? (
                <View style={styles.body}>
                  <AppText variant="small" tone="secondary" selectable>
                    ソースコード: {entry.source}
                  </AppText>
                  <AppText variant="small" selectable style={styles.licenseText}>
                    {entry.text}
                  </AppText>
                </View>
              ) : null}
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 4, paddingTop: 8 },
  headerButton: { minHeight: 44, minWidth: 64, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 12 },
  content: { padding: 16, gap: 10, paddingBottom: 48 },
  lead: { lineHeight: 18, paddingHorizontal: 4, paddingBottom: 6 },
  card: { backgroundColor: colors.surface, borderRadius: radius.lg, overflow: 'hidden' },
  cardHeader: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, minHeight: 56 },
  cardText: { flex: 1, gap: 2 },
  body: { paddingHorizontal: 14, paddingBottom: 14, gap: 10 },
  licenseText: { color: '#C9CCD2', lineHeight: 17 },
});
