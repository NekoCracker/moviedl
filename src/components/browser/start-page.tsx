import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { AppText } from '@/components/app-text';
import { initialOf } from '@/components/browser/site-label';
import type { Bookmark } from '@/db/browser';
import { colors, placeholderTint, radius } from '@/theme';

// 新しいタブ・ホームで表示する開始ページ。ブックマークを並べる。
export function StartPage({
  bookmarks,
  isPrivate,
  onOpen,
}: {
  bookmarks: Bookmark[];
  isPrivate: boolean;
  onOpen: (url: string) => void;
}) {
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      {isPrivate ? (
        <View style={styles.privateNote}>
          <AppText variant="bodyBold">プライベートタブ</AppText>
          <AppText variant="caption" tone="secondary" style={styles.noteText}>
            このタブで見たページは履歴に残りません。タブを閉じるとCookieなどのサイトデータも消えます。
          </AppText>
        </View>
      ) : null}
      <AppText variant="caption" tone="secondary" style={styles.heading}>
        ブックマーク
      </AppText>
      {bookmarks.length === 0 ? (
        <AppText variant="caption" tone="muted" style={styles.empty}>
          ページを開いて ☆ を押すと、ここに表示されます。
        </AppText>
      ) : (
        <View style={styles.grid}>
          {bookmarks.map((b, i) => (
            <Pressable
              key={b.id}
              accessibilityRole="link"
              accessibilityLabel={b.title}
              onPress={() => onOpen(b.url)}
              style={({ pressed }) => [styles.tile, pressed && styles.pressed]}>
              <View style={[styles.icon, { backgroundColor: placeholderTint(i) }]}>
                <AppText variant="title">{initialOf(b.title, b.url)}</AppText>
              </View>
              <AppText variant="small" tone="secondary" numberOfLines={2} style={styles.tileLabel}>
                {b.title}
              </AppText>
            </Pressable>
          ))}
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: 20, gap: 12 },
  privateNote: { backgroundColor: colors.surface, borderRadius: radius.lg, padding: 16, gap: 6, marginBottom: 8 },
  noteText: { lineHeight: 19 },
  heading: { paddingHorizontal: 2 },
  empty: { paddingVertical: 12 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', rowGap: 18 },
  tile: { width: '25%', alignItems: 'center', gap: 6 },
  pressed: { opacity: 0.6 },
  icon: { width: 56, height: 56, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  tileLabel: { textAlign: 'center', paddingHorizontal: 4 },
});
