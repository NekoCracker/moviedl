import { Image } from 'expo-image';
import { router, useFocusEffect } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { SymbolView } from 'expo-symbols';
import { useCallback, useState } from 'react';
import { ActionSheetIOS, Alert, FlatList, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppText } from '@/components/app-text';
import { FolderPasscodeModal, type FolderPasscodeMode } from '@/components/folder-passcode-modal';
import { SegmentedControl } from '@/components/segmented-control';
import {
  ALL_FOLDER_ID,
  createFolder,
  deleteFolder,
  getLibraryTotals,
  listFoldersSorted,
  listMedia,
  moveFolder,
  renameFolder,
  setFolderHasPasscode,
  type FolderSort,
  type FolderSummary,
  type MediaType,
} from '@/db/library';
import { loadSettings, saveSetting } from '@/db/settings';
import { deleteMediaItems, thumbnailUri } from '@/library/media-actions';
import { requirePremium } from '@/premium/store';
import { folderUnlock } from '@/security/folder-unlock';
import { folderPasscode } from '@/security/passcode';
import { colors, placeholderTint, radius } from '@/theme';
import { formatBytes } from '@/utils/format';

const folderSortOptions: { value: FolderSort; label: string }[] = [
  { value: 'manual', label: '手動' },
  { value: 'name', label: '名前順' },
  { value: 'created', label: '作成日順（新しい順）' },
];

type FolderCard = FolderSummary & { isAll?: boolean };

export default function LibraryScreen() {
  const db = useSQLiteContext();
  const insets = useSafeAreaInsets();
  const [mediaType, setMediaType] = useState<MediaType>('video');
  const [folders, setFolders] = useState<FolderCard[]>([]);
  const [totals, setTotals] = useState({ count: 0, bytes: 0 });
  const [folderSort, setFolderSort] = useState<FolderSort>('manual');
  const [passcodeTarget, setPasscodeTarget] = useState<{ folder: FolderSummary; mode: FolderPasscodeMode } | null>(null);

  const load = useCallback(async () => {
    const settings = await loadSettings(db);
    setFolderSort(settings.folderSort);
    const [list, sum] = await Promise.all([
      listFoldersSorted(db, mediaType, settings.folderSort),
      getLibraryTotals(db, mediaType),
    ]);
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

  const openFolder = (folder: FolderCard) => {
    if (folder.hasPasscode && !folderUnlock.isUnlocked(folder.id)) {
      setPasscodeTarget({ folder, mode: 'unlock' });
      return;
    }
    router.push({ pathname: '/folder/[id]', params: { id: String(folder.id), type: mediaType } });
  };

  const onPasscodeDone = async () => {
    const target = passcodeTarget;
    setPasscodeTarget(null);
    if (!target) return;
    if (target.mode === 'unlock') {
      folderUnlock.unlock(target.folder.id);
      router.push({ pathname: '/folder/[id]', params: { id: String(target.folder.id), type: mediaType } });
    } else {
      await setFolderHasPasscode(db, target.folder.id, target.mode === 'set');
      if (target.mode === 'remove') folderUnlock.forget(target.folder.id);
      await load();
    }
  };

  const chooseFolderSort = () => {
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: 'フォルダの並び順',
        options: [...folderSortOptions.map((o) => o.label), 'キャンセル'],
        cancelButtonIndex: folderSortOptions.length,
      },
      async (i) => {
        if (i >= folderSortOptions.length) return;
        await saveSetting(db, 'folderSort', folderSortOptions[i].value);
        await load();
      },
    );
  };

  const confirmDeleteFolder = (folder: FolderCard) => {
    const run = async (withContents: boolean) => {
      if (withContents) {
        // 動画と音声の両方を消す
        const [videos, audios] = await Promise.all([
          listMedia(db, folder.id, 'video', { key: 'created_at', dir: 'desc' }),
          listMedia(db, folder.id, 'audio', { key: 'created_at', dir: 'desc' }),
        ]);
        await deleteMediaItems(db, [...videos, ...audios]);
      }
      if (folder.hasPasscode) await folderPasscode.clear(folder.id);
      await deleteFolder(db, folder.id);
      await load();
    };
    Alert.alert(`「${folder.name}」を削除`, '中の動画をどうしますか？', [
      { text: '「未分類」へ移動', onPress: () => run(false) },
      { text: '中の動画も削除', style: 'destructive', onPress: () => run(true) },
      { text: 'キャンセル', style: 'cancel' },
    ]);
  };

  const folderMenu = (folder: FolderCard) => {
    if (folder.isAll) return;
    const editable = !folder.isSystem;
    const index = folders.filter((f) => !f.isSystem).findIndex((f) => f.id === folder.id);
    const editableCount = folders.filter((f) => !f.isSystem).length;
    const actions: { label: string; run: () => void; destructive?: boolean }[] = [];
    if (editable) {
      actions.push({
        label: '名前を変更',
        run: () =>
          Alert.prompt(
            '名前を変更',
            undefined,
            async (name) => {
              try {
                await renameFolder(db, folder.id, name ?? '');
                await load();
              } catch (e) {
                Alert.alert('変更できませんでした', e instanceof Error ? e.message : String(e));
              }
            },
            'plain-text',
            folder.name,
          ),
      });
      if (folder.hasPasscode) {
        actions.push({ label: 'パスコードを外す', run: () => setPasscodeTarget({ folder, mode: 'remove' }) });
      } else {
        actions.push({
          label: 'パスコードを設定',
          run: () => {
            if (requirePremium('folderPasscode')) setPasscodeTarget({ folder, mode: 'set' });
          },
        });
      }
      if (folderSort === 'manual' && index > 0) actions.push({ label: '前へ移動', run: () => moveFolder(db, folder.id, -1).then(load) });
      if (folderSort === 'manual' && index < editableCount - 1) actions.push({ label: '後ろへ移動', run: () => moveFolder(db, folder.id, 1).then(load) });
      actions.push({ label: 'フォルダを削除', destructive: true, run: () => confirmDeleteFolder(folder) });
    }
    if (actions.length === 0) return;
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: folder.name,
        options: [...actions.map((a) => a.label), 'キャンセル'],
        cancelButtonIndex: actions.length,
        destructiveButtonIndex: actions.findIndex((a) => a.destructive),
      },
      (i) => actions[i]?.run(),
    );
  };

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

      <View style={styles.summaryRow}>
        <AppText variant="caption" tone="secondary">
          {folderCount} フォルダ・{totals.count} 本・{formatBytes(totals.bytes)}
        </AppText>
        <Pressable accessibilityRole="button" accessibilityLabel="フォルダの並び順" onPress={chooseFolderSort} style={styles.sortButton}>
          <SymbolView name="arrow.up.arrow.down" tintColor={colors.textSecondary} size={14} />
          <AppText variant="small" tone="secondary">
            {folderSortOptions.find((o) => o.value === folderSort)?.label.replace(/（.*）/, '')}
          </AppText>
        </Pressable>
      </View>

      <FlatList
        data={folders}
        keyExtractor={(item) => String(item.id)}
        numColumns={2}
        columnWrapperStyle={styles.row}
        contentContainerStyle={styles.grid}
        ListFooterComponent={
          <AppText variant="small" tone="muted" style={styles.hint}>
            フォルダを長押しすると、名前の変更・パスコード・並べ替え・削除ができます。
          </AppText>
        }
        renderItem={({ item }) => <FolderTile folder={item} onPress={() => openFolder(item)} onLongPress={() => folderMenu(item)} />}
      />

      <FolderPasscodeModal
        folder={passcodeTarget?.folder ?? null}
        mode={passcodeTarget?.mode ?? 'unlock'}
        onCancel={() => setPasscodeTarget(null)}
        onDone={onPasscodeDone}
      />
    </View>
  );
}

function FolderTile({ folder, onPress, onLongPress }: { folder: FolderCard; onPress: () => void; onLongPress: () => void }) {
  const cover = folder.hasPasscode ? null : thumbnailUri(folder.coverThumbnail);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${folder.name}、${folder.itemCount}本${folder.hasPasscode ? '、ロック中' : ''}`}
      accessibilityHint={folder.isSystem ? undefined : '長押しでメニュー'}
      onPress={onPress}
      onLongPress={onLongPress}
      style={({ pressed }) => [styles.tile, pressed && styles.pressed]}>
        <View style={[styles.cover, { backgroundColor: placeholderTint(folder.id + 1) }]}>
          {cover ? <Image source={{ uri: cover }} style={StyleSheet.absoluteFill} contentFit="cover" /> : null}
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
  summaryRow: { paddingHorizontal: 20, paddingBottom: 6, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sortButton: { flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 36, paddingLeft: 8 },
  hint: { textAlign: 'center', paddingTop: 8 },
  pressed: { opacity: 0.7 },
  grid: { paddingHorizontal: 20, paddingBottom: 120, gap: 14 },
  row: { gap: 14 },
  tile: { flex: 1, gap: 8 },
  cover: {
    height: 104,
    borderRadius: radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
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
