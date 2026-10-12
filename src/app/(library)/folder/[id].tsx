import { Image } from 'expo-image';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { SymbolView, type SFSymbol } from 'expo-symbols';
import { useCallback, useState } from 'react';
import { ActionSheetIOS, ActivityIndicator, Alert, AppState, FlatList, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppText } from '@/components/app-text';
import {
  ALL_FOLDER_ID,
  folderHasPasscode,
  getFolderName,
  getFolderSort,
  listFolders,
  listMedia,
  moveMedia,
  moveMediaManual,
  renameMedia,
  setFolderSort,
  type MediaItem,
  type MediaType,
  type SortDir,
  type SortKey,
} from '@/db/library';
import { UNSORTED_FOLDER_ID } from '@/db/schema';
import {
  deleteMediaItems,
  importFromFiles,
  NATIVE_VIDEO_CONTAINERS,
  queueConversion,
  saveToCameraRoll,
  thumbnailUri,
} from '@/library/media-actions';
import { folderUnlock } from '@/security/folder-unlock';
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
  const [sortIndex, setSortIndex] = useState<number | null>(null);
  const sort = sortOptions[sortIndex ?? 0];
  const [selection, setSelection] = useState<Set<number> | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // ロック中のフォルダに解除せず来た場合（バックグラウンドから戻った時を含む）はライブラリへ戻す
  const guardLock = useCallback(async () => {
    if (folderId !== ALL_FOLDER_ID && !folderUnlock.isUnlocked(folderId) && (await folderHasPasscode(db, folderId))) {
      router.back();
      return false;
    }
    return true;
  }, [db, folderId]);

  // 画面が前面にあるときだけ見張る（上にプレイヤーが開いているときに戻してしまわないように）
  useFocusEffect(
    useCallback(() => {
      const sub = AppState.addEventListener('change', (state) => {
        if (state === 'active') guardLock();
      });
      return () => sub.remove();
    }, [guardLock]),
  );

  const load = useCallback(async () => {
    if (!(await guardLock())) return;
    let index = sortIndex;
    if (index == null) {
      const saved = await getFolderSort(db, folderId);
      index = Math.max(0, sortOptions.findIndex((o) => o.key === saved.key && o.dir === saved.dir));
      setSortIndex(index);
    }
    const s = sortOptions[index];
    const [folderName, media] = await Promise.all([
      getFolderName(db, folderId),
      listMedia(db, folderId, mediaType, { key: s.key, dir: s.dir }, search),
    ]);
    setName(folderName ?? '');
    setItems(media);
  }, [db, folderId, mediaType, sortIndex, search, guardLock]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const selectedItems = selection ? items.filter((i) => selection.has(i.id)) : [];

  const toggleSelected = (id: number) => {
    setSelection((prev) => {
      const next = new Set(prev ?? []);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const runBusy = async (label: string, task: () => Promise<void>) => {
    setBusy(label);
    try {
      await task();
    } catch (e) {
      Alert.alert('できませんでした', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
      await load();
    }
  };

  const confirmDelete = (targets: MediaItem[]) => {
    if (targets.length === 0) return;
    Alert.alert(
      targets.length === 1 ? `「${targets[0].title}」を削除` : `${targets.length}件を削除`,
      '端末から完全に削除されます。元に戻せません。',
      [
        { text: 'キャンセル', style: 'cancel' },
        {
          text: '削除',
          style: 'destructive',
          onPress: () =>
            runBusy('削除しています', async () => {
              await deleteMediaItems(db, targets);
              setSelection(null);
            }),
        },
      ],
    );
  };

  const chooseMoveTarget = async (targets: MediaItem[]) => {
    if (targets.length === 0) return;
    const folders = (await listFolders(db, mediaType)).filter((f) => f.id !== folderId);
    if (folders.length === 0) {
      Alert.alert('移動先がありません', 'ライブラリの ＋ からフォルダを作成してください。');
      return;
    }
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: `${targets.length}件を移動`,
        options: [...folders.map((f) => (f.hasPasscode ? `🔒 ${f.name}` : f.name)), 'キャンセル'],
        cancelButtonIndex: folders.length,
      },
      (i) => {
        const target = folders[i];
        if (!target) return;
        runBusy('移動しています', async () => {
          await moveMedia(db, targets.map((t) => t.id), target.id);
          setSelection(null);
        });
      },
    );
  };

  const copyToCameraRoll = (targets: MediaItem[]) =>
    runBusy('写真に保存しています', async () => {
      const result = await saveToCameraRoll(targets);
      setSelection(null);
      const lines = [];
      if (result.saved > 0) lines.push(`${result.saved}件を写真アプリに保存しました。`);
      if (result.needsConversion.length > 0) {
        lines.push(`${result.needsConversion.length}件は写真アプリが対応していない形式です。メニューの「MP4に変換」のあとで保存してください。`);
      }
      if (targets.some((t) => t.mediaType === 'audio')) lines.push('音声は写真アプリに保存できません。');
      Alert.alert('写真に保存', lines.join('\n'));
    });

  const queue = (item: MediaItem, kind: 'mp4' | 'm4a' | 'mp3') =>
    runBusy('', async () => {
      const added = await queueConversion(db, item.id, kind, kind === 'mp3' ? { bitrate: 192 } : {});
      Alert.alert(added ? '変換を開始しました' : 'すでに変換待ちです', '進み具合は「ダウンロード」タブで確認できます。');
    });

  const itemMenu = (item: MediaItem) => {
    const index = items.findIndex((i) => i.id === item.id);
    const actions: { label: string; run: () => void; destructive?: boolean }[] = [
      {
        label: 'タイトルを変更',
        run: () =>
          Alert.prompt(
            'タイトルを変更',
            undefined,
            (title) => runBusy('', () => renameMedia(db, item.id, title ?? '')),
            'plain-text',
            item.title,
          ),
      },
      { label: 'フォルダへ移動', run: () => chooseMoveTarget([item]) },
    ];
    if (item.mediaType === 'video') {
      actions.push({ label: '写真アプリに保存', run: () => copyToCameraRoll([item]) });
      if (!NATIVE_VIDEO_CONTAINERS.includes(item.container ?? '')) {
        actions.push({ label: 'MP4に変換', run: () => queue(item, 'mp4') });
      }
      actions.push({ label: '音声を書き出す（m4a）', run: () => queue(item, 'm4a') });
      actions.push({ label: '音声を書き出す（mp3）', run: () => queue(item, 'mp3') });
    }
    if (sort.key === 'manual_order' && !search) {
      if (index > 0) actions.push({ label: '上へ移動', run: () => moveMediaManual(db, folderId, mediaType, item.id, -1).then(load) });
      if (index < items.length - 1) actions.push({ label: '下へ移動', run: () => moveMediaManual(db, folderId, mediaType, item.id, 1).then(load) });
    }
    actions.push({ label: '削除', destructive: true, run: () => confirmDelete([item]) });
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: item.title,
        options: [...actions.map((a) => a.label), 'キャンセル'],
        cancelButtonIndex: actions.length,
        destructiveButtonIndex: actions.findIndex((a) => a.destructive),
      },
      (i) => actions[i]?.run(),
    );
  };

  const onImport = () =>
    runBusy('取り込んでいます', async () => {
      const result = await importFromFiles(db, folderId === ALL_FOLDER_ID ? UNSORTED_FOLDER_ID : folderId, mediaType);
      if (result && result.skipped.length > 0) {
        Alert.alert('取り込めなかったファイル', `動画・音声ではないため取り込めませんでした。\n${result.skipped.join('\n')}`);
      }
    });

  const totalBytes = items.reduce((sum, item) => sum + (item.sizeBytes ?? 0), 0);

  const openPlayer = (options: { startId?: number; shuffle?: boolean }) => {
    router.push({
      pathname: '/player',
      params: {
        folderId: String(folderId),
        type: mediaType,
        sortKey: sort.key,
        sortDir: sort.dir,
        ...(options.startId != null ? { startId: String(options.startId) } : {}),
        ...(options.shuffle ? { shuffle: '1' } : {}),
      },
    });
  };

  const chooseSort = () => {
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: '並び替え',
        options: [...sortOptions.map((o) => o.label), 'キャンセル'],
        cancelButtonIndex: sortOptions.length,
      },
      (index) => {
        if (index >= sortOptions.length) return;
        setSortIndex(index);
        setFolderSort(db, folderId, { key: sortOptions[index].key, dir: sortOptions[index].dir });
      },
    );
  };

  return (
    <View style={[styles.screen, { paddingTop: insets.top + 4 }]}>
      <View style={styles.nav}>
        {selection ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => setSelection(selection.size === items.length ? new Set() : new Set(items.map((i) => i.id)))}
            style={styles.textButton}>
            <AppText variant="body" tone="accent">
              {selection.size === items.length && items.length > 0 ? '選択を解除' : 'すべて選択'}
            </AppText>
          </Pressable>
        ) : (
          <Pressable accessibilityRole="button" accessibilityLabel="ライブラリに戻る" onPress={() => router.back()} style={styles.iconButton}>
            <SymbolView name="chevron.left" tintColor={colors.accent} size={22} weight="semibold" />
          </Pressable>
        )}
        <View style={styles.navRight}>
          {selection ? null : (
            <Pressable accessibilityRole="button" accessibilityLabel="ファイルから取り込む" onPress={onImport} style={styles.iconButton}>
              <SymbolView name="square.and.arrow.down" tintColor={colors.accent} size={20} />
            </Pressable>
          )}
          <Pressable
            accessibilityRole="button"
            onPress={() => setSelection(selection ? null : new Set())}
            disabled={!selection && items.length === 0}
            style={styles.textButton}>
            <AppText variant="bodyBold" tone={!selection && items.length === 0 ? 'muted' : 'accent'}>
              {selection ? '完了' : '選択'}
            </AppText>
          </Pressable>
        </View>
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
        <Pressable
          accessibilityRole="button"
          style={[styles.actionButton, styles.primaryAction]}
          disabled={items.length === 0}
          onPress={() => openPlayer({ startId: items[0]?.id })}>
          <SymbolView name="play.fill" tintColor={colors.onAccent} size={16} />
          <AppText variant="bodyBold" tone="onAccent">
            再生
          </AppText>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          style={styles.actionButton}
          disabled={items.length === 0}
          onPress={() => openPlayer({ shuffle: true })}>
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
            {search ? '一致するものがありません' : 'まだ何もありません。ブラウザから保存するか、右上のボタンからファイルを取り込んでください。'}
          </AppText>
        }
        renderItem={({ item }) => (
          <MediaRow
            item={item}
            selected={selection ? selection.has(item.id) : undefined}
            onPress={() => (selection ? toggleSelected(item.id) : openPlayer({ startId: item.id }))}
            onLongPress={() => (selection ? toggleSelected(item.id) : itemMenu(item))}
            onMore={() => itemMenu(item)}
          />
        )}
      />

      {selection ? (
        <View style={[styles.selectionBar, { paddingBottom: insets.bottom + 56 }]}>
          <SelectionAction icon="folder" label="移動" disabled={selectedItems.length === 0} onPress={() => chooseMoveTarget(selectedItems)} />
          {mediaType === 'video' ? (
            <SelectionAction icon="photo.on.rectangle" label="写真に保存" disabled={selectedItems.length === 0} onPress={() => copyToCameraRoll(selectedItems)} />
          ) : null}
          <SelectionAction icon="trash" label="削除" destructive disabled={selectedItems.length === 0} onPress={() => confirmDelete(selectedItems)} />
        </View>
      ) : null}

      {busy ? (
        <View style={styles.busy} accessibilityLiveRegion="polite">
          <ActivityIndicator color={colors.text} />
          {busy ? <AppText variant="caption">{busy}</AppText> : null}
        </View>
      ) : null}
    </View>
  );
}

function SelectionAction({
  icon,
  label,
  onPress,
  disabled,
  destructive,
}: {
  icon: SFSymbol;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  destructive?: boolean;
}) {
  const tint = disabled ? colors.textMuted : destructive ? colors.dangerText : colors.text;
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ disabled: !!disabled }} disabled={disabled} onPress={onPress} style={styles.selectionAction}>
      <SymbolView name={icon} tintColor={tint} size={20} />
      <AppText variant="small" style={{ color: tint }}>
        {label}
      </AppText>
    </Pressable>
  );
}

function MediaRow({
  item,
  selected,
  onPress,
  onLongPress,
  onMore,
}: {
  item: MediaItem;
  selected?: boolean;
  onPress: () => void;
  onLongPress: () => void;
  onMore: () => void;
}) {
  const progress = item.durationSec ? Math.min(1, item.lastPositionSec / item.durationSec) : 0;
  const meta = [item.container?.toUpperCase(), item.sizeBytes ? formatBytes(item.sizeBytes) : null]
    .filter(Boolean)
    .join('・');
  const thumb = thumbnailUri(item.thumbnailPath);
  const selecting = selected !== undefined;
  return (
    <Pressable
      accessibilityRole={selecting ? 'checkbox' : 'button'}
      accessibilityState={selecting ? { checked: selected } : undefined}
      accessibilityLabel={item.title}
      accessibilityHint={selecting ? undefined : '長押しでメニュー'}
      onPress={onPress}
      onLongPress={onLongPress}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
      {selecting ? (
        <SymbolView
          name={selected ? 'checkmark.circle.fill' : 'circle'}
          tintColor={selected ? colors.accent : colors.textMuted}
          size={22}
        />
      ) : null}
      <View style={[styles.thumb, { backgroundColor: placeholderTint(item.id) }]}>
        {thumb ? <Image source={{ uri: thumb }} style={StyleSheet.absoluteFill} contentFit="cover" /> : null}
        {item.mediaType === 'audio' && !thumb ? (
          <View style={styles.audioIcon}>
            <SymbolView name="music.note" tintColor={colors.text} size={22} />
          </View>
        ) : null}
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
      {selecting ? null : (
        <Pressable accessibilityRole="button" accessibilityLabel={`${item.title}のメニュー`} hitSlop={6} onPress={onMore} style={styles.more}>
          <SymbolView name="ellipsis" tintColor={colors.textSecondary} size={16} />
        </Pressable>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  nav: { paddingHorizontal: 8, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  navRight: { flexDirection: 'row', alignItems: 'center' },
  textButton: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 12 },
  pressed: { opacity: 0.7 },
  audioIcon: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center' },
  more: { width: 32, height: 44, alignItems: 'center', justifyContent: 'center' },
  selectionBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    justifyContent: 'space-around',
    paddingTop: 8,
    backgroundColor: colors.tabBar,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  selectionAction: { minWidth: 72, minHeight: 48, alignItems: 'center', justifyContent: 'center', gap: 2 },
  busy: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
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
