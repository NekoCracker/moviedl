import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { SymbolView } from 'expo-symbols';
import { useCallback, useState } from 'react';
import { ActionSheetIOS, FlatList, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppText } from '@/components/app-text';
import {
  getFolderName,
  listMedia,
  type MediaItem,
  type MediaType,
  type SortDir,
  type SortKey,
} from '@/db/library';
import { colors, fonts, placeholderTint, radius } from '@/theme';
import { formatBytes, formatDuration } from '@/utils/format';

const sortOptions: { key: SortKey; dir: SortDir; label: string }[] = [
  { key: 'created_at', dir: 'desc', label: '追加日（新しい順）' },
  { key: 'created_at', dir: 'asc', label: '追加日（古い順）' },
  { key: 'title', dir: 'asc', label: 'タイトル（A→Z）' },
  { key: 'duration_sec', dir: 'desc', label: '長さ（長い順）' },
  { key: 'size_bytes', dir: 'desc', label: 'サイズ（大きい順）' },
  { key: 'last_played_at', dir: 'desc', label: '最後に再生した日' },
  { key: 'manual_order', dir: 'asc', label: '手動' },
];

export default function FolderScreen() {
  const db = useSQLiteContext();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ id: string; type?: MediaType }>();
  const folderId = Number(params.id);
  const mediaType: MediaType = params.type === 'audio' ? 'audio' : 'video';

  const [name, setName] = useState('');
  const [items, setItems] = useState<MediaItem[]>([]);
  const [search, setSearch] = useState('');
  const [sortIndex, setSortIndex] = useState(0);
  const sort = sortOptions[sortIndex];

  const load = useCallback(async () => {
    const [folderName, media] = await Promise.all([
      getFolderName(db, folderId),
      listMedia(db, folderId, mediaType, { key: sort.key, dir: sort.dir }, search),
    ]);
    setName(folderName ?? '');
    setItems(media);
  }, [db, folderId, mediaType, sort.key, sort.dir, search]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const totalBytes = items.reduce((sum, item) => sum + (item.sizeBytes ?? 0), 0);

  const chooseSort = () => {
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: '並び替え',
        options: [...sortOptions.map((o) => o.label), 'キャンセル'],
        cancelButtonIndex: sortOptions.length,
      },
      (index) => {
        if (index < sortOptions.length) setSortIndex(index);
      },
    );
  };

  return (
    <View style={[styles.screen, { paddingTop: insets.top + 4 }]}>
      <View style={styles.nav}>
        <Pressable accessibilityRole="button" accessibilityLabel="ライブラリに戻る" onPress={() => router.back()} style={styles.iconButton}>
          <SymbolView name="chevron.left" tintColor={colors.accent} size={22} weight="semibold" />
        </Pressable>
      </View>

      <View style={styles.titleBlock}>
        <AppText variant="largeTitle" accessibilityRole="header" numberOfLines={1}>
          {name}
        </AppText>
        <AppText variant="caption" tone="secondary">
          {items.length} 本・{formatBytes(totalBytes)}
        </AppText>
      </View>

      <View style={styles.actions}>
        <Pressable accessibilityRole="button" style={[styles.actionButton, styles.primaryAction]} disabled={items.length === 0}>
          <SymbolView name="play.fill" tintColor={colors.onAccent} size={16} />
          <AppText variant="bodyBold" tone="onAccent">
            再生
          </AppText>
        </Pressable>
        <Pressable accessibilityRole="button" style={styles.actionButton} disabled={items.length === 0}>
          <SymbolView name="shuffle" tintColor={colors.text} size={16} />
          <AppText variant="bodyBold">シャッフル</AppText>
        </Pressable>
      </View>

      <View style={styles.searchRow}>
        <TextInput
          accessibilityLabel="タイトルで検索"
          placeholder="タイトルで検索"
          placeholderTextColor={colors.textMuted}
          value={search}
          onChangeText={setSearch}
          style={styles.search}
          clearButtonMode="while-editing"
        />
        <Pressable accessibilityRole="button" accessibilityLabel="並び替え" onPress={chooseSort} style={styles.sortButton}>
          <SymbolView name="arrow.up.arrow.down" tintColor={colors.text} size={18} />
        </Pressable>
      </View>
      <AppText variant="small" tone="secondary" style={styles.sortLabel}>
        {sort.label}
      </AppText>

      <FlatList
        data={items}
        keyExtractor={(item) => String(item.id)}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <AppText variant="caption" tone="secondary" style={styles.empty}>
            {search ? '一致するものがありません' : 'まだ何もありません。ブラウザから保存するか、ファイルから取り込んでください。'}
          </AppText>
        }
        renderItem={({ item }) => <MediaRow item={item} />}
      />
    </View>
  );
}

function MediaRow({ item }: { item: MediaItem }) {
  const progress = item.durationSec ? Math.min(1, item.lastPositionSec / item.durationSec) : 0;
  const meta = [item.container?.toUpperCase(), item.sizeBytes ? formatBytes(item.sizeBytes) : null]
    .filter(Boolean)
    .join('・');
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={item.title} style={styles.row}>
      <View style={[styles.thumb, { backgroundColor: placeholderTint(item.id) }]}>
        <View style={styles.duration}>
          <AppText variant="small">{formatDuration(item.durationSec)}</AppText>
        </View>
        {progress > 0 ? <View style={[styles.progress, { width: `${progress * 100}%` }]} /> : null}
      </View>
      <View style={styles.rowText}>
        <AppText variant="body" numberOfLines={2}>
          {item.title}
        </AppText>
        <AppText variant="small" tone="secondary">
          {meta}
        </AppText>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  nav: { paddingHorizontal: 8, flexDirection: 'row' },
  iconButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  titleBlock: { paddingHorizontal: 20, paddingBottom: 12, gap: 4 },
  actions: { flexDirection: 'row', gap: 10, paddingHorizontal: 20, paddingBottom: 12 },
  actionButton: {
    flex: 1,
    height: 44,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  primaryAction: { backgroundColor: colors.accent },
  searchRow: { flexDirection: 'row', gap: 8, paddingHorizontal: 20 },
  search: {
    flex: 1,
    height: 40,
    borderRadius: 10,
    backgroundColor: colors.surface,
    color: colors.text,
    paddingHorizontal: 12,
    fontFamily: fonts.regular,
    fontSize: 14,
  },
  sortButton: {
    width: 44,
    height: 40,
    borderRadius: 10,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sortLabel: { paddingHorizontal: 20, paddingVertical: 8 },
  list: { paddingHorizontal: 12, paddingBottom: 120 },
  empty: { padding: 24, textAlign: 'center', lineHeight: 20 },
  row: { flexDirection: 'row', gap: 12, alignItems: 'center', padding: 8 },
  thumb: { width: 120, height: 68, borderRadius: radius.sm, overflow: 'hidden' },
  duration: {
    position: 'absolute',
    right: 4,
    bottom: 4,
    backgroundColor: 'rgba(0,0,0,0.7)',
    paddingHorizontal: 5,
    borderRadius: 4,
  },
  progress: { position: 'absolute', left: 0, bottom: 0, height: 3, backgroundColor: colors.accent },
  rowText: { flex: 1, gap: 4 },
});
