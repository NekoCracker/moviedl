import { Link, useFocusEffect } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { SymbolView } from 'expo-symbols';
import { useCallback, useState } from 'react';
import { Alert, FlatList, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppText } from '@/components/app-text';
import { SegmentedControl } from '@/components/segmented-control';
import {
  ALL_FOLDER_ID,
  createFolder,
  getLibraryTotals,
  listFolders,
  type FolderSummary,
  type MediaType,
} from '@/db/library';
import { colors, placeholderTint, radius } from '@/theme';
import { formatBytes } from '@/utils/format';

type FolderCard = FolderSummary & { isAll?: boolean };

export default function LibraryScreen() {
  const db = useSQLiteContext();
  const insets = useSafeAreaInsets();
  const [mediaType, setMediaType] = useState<MediaType>('video');
  const [folders, setFolders] = useState<FolderCard[]>([]);
  const [totals, setTotals] = useState({ count: 0, bytes: 0 });

  const load = useCallback(async () => {
    const [list, sum] = await Promise.all([listFolders(db, mediaType), getLibraryTotals(db, mediaType)]);
    const all: FolderCard = {
      id: ALL_FOLDER_ID,
      name: mediaType === 'video' ? 'すべての動画' : 'すべての音声',
      hasPasscode: false,
      isSystem: true,
      itemCount: sum.count,
      totalBytes: sum.bytes,
      coverThumbnail: null,
      isAll: true,
    };
    setFolders([all, ...list]);
    setTotals(sum);
  }, [db, mediaType]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const onCreateFolder = () => {
    Alert.prompt('新しいフォルダ', 'フォルダ名を入力してください', async (name) => {
      try {
        await createFolder(db, name ?? '');
        await load();
      } catch (e) {
        Alert.alert('フォルダを作成できませんでした', e instanceof Error ? e.message : String(e));
      }
    });
  };

  const folderCount = folders.length - 1;

  return (
    <View style={[styles.screen, { paddingTop: insets.top + 12 }]}>
      <View style={styles.header}>
        <AppText variant="largeTitle" accessibilityRole="header">
          ライブラリ
        </AppText>
        <Pressable accessibilityRole="button" accessibilityLabel="新しいフォルダ" onPress={onCreateFolder} style={styles.addButton}>
          <SymbolView name="plus" tintColor={colors.onAccent} size={20} weight="bold" />
        </Pressable>
      </View>

      <View style={styles.segmentWrap}>
        <SegmentedControl
          accessibilityLabel="種類"
          value={mediaType}
          onChange={setMediaType}
          options={[
            { value: 'video', label: '動画' },
            { value: 'audio', label: '音声' },
          ]}
        />
      </View>

      <AppText variant="caption" tone="secondary" style={styles.summary}>
        {folderCount} フォルダ・{totals.count} 本・{formatBytes(totals.bytes)}
      </AppText>

      <FlatList
        data={folders}
        keyExtractor={(item) => String(item.id)}
        numColumns={2}
        columnWrapperStyle={styles.row}
        contentContainerStyle={styles.grid}
        renderItem={({ item }) => <FolderTile folder={item} mediaType={mediaType} />}
      />
    </View>
  );
}

function FolderTile({ folder, mediaType }: { folder: FolderCard; mediaType: MediaType }) {
  return (
    <Link href={{ pathname: '/folder/[id]', params: { id: String(folder.id), type: mediaType } }} asChild>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${folder.name}、${folder.itemCount}本${folder.hasPasscode ? '、ロック中' : ''}`}
        style={styles.tile}>
        <View style={[styles.cover, { backgroundColor: placeholderTint(folder.id + 1) }]}>
          {folder.hasPasscode ? (
            <View style={styles.lockBadge}>
              <SymbolView name="lock.fill" tintColor={colors.text} size={18} />
            </View>
          ) : null}
          <View style={styles.countBadge}>
            <AppText variant="small">{folder.itemCount}</AppText>
          </View>
        </View>
        <AppText variant="bodyBold" numberOfLines={1}>
          {folder.name}
        </AppText>
      </Pressable>
    </Link>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  header: {
    paddingHorizontal: 20,
    paddingBottom: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  addButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  segmentWrap: { paddingHorizontal: 20, paddingBottom: 12 },
  summary: { paddingHorizontal: 20, paddingBottom: 10 },
  grid: { paddingHorizontal: 20, paddingBottom: 120, gap: 14 },
  row: { gap: 14 },
  tile: { flex: 1, gap: 8 },
  cover: {
    height: 104,
    borderRadius: radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  lockBadge: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  countBadge: {
    position: 'absolute',
    right: 8,
    bottom: 8,
    backgroundColor: 'rgba(0,0,0,0.6)',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 8,
  },
});
