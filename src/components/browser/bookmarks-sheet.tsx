import { useSQLiteContext } from 'expo-sqlite';
import { SymbolView } from 'expo-symbols';
import { useCallback, useEffect, useState } from 'react';
import { ActionSheetIOS, Alert, FlatList, Modal, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppText } from '@/components/app-text';
import { hostOf } from '@/components/browser/site-label';
import { SegmentedControl } from '@/components/segmented-control';
import {
  clearHistory,
  deleteBookmark,
  deleteHistoryEntry,
  listBookmarks,
  listHistory,
  moveBookmark,
  updateBookmark,
  type Bookmark,
  type HistoryEntry,
} from '@/db/browser';
import { colors, fonts, radius } from '@/theme';

type Mode = 'bookmarks' | 'history';

// 履歴の削除範囲（feature-spec.md §2-7）
export const historyRanges: { label: string; since: () => number | null }[] = [
  { label: '過去1時間', since: () => Date.now() - 60 * 60 * 1000 },
  { label: '今日', since: () => new Date().setHours(0, 0, 0, 0) },
  { label: '今日と昨日', since: () => new Date().setHours(0, 0, 0, 0) - 24 * 60 * 60 * 1000 },
  { label: 'すべて', since: () => null },
];

export function chooseHistoryRange(title: string, onChoose: (sinceMs: number | null) => void) {
  ActionSheetIOS.showActionSheetWithOptions(
    {
      title,
      message: 'ダウンロードした動画とブックマークは消えません。',
      options: [...historyRanges.map((r) => r.label), 'キャンセル'],
      cancelButtonIndex: historyRanges.length,
      destructiveButtonIndex: historyRanges.map((_, i) => i),
    },
    (i) => {
      if (i < historyRanges.length) onChoose(historyRanges[i].since());
    },
  );
}

function dayLabel(ms: number): string {
  const d = new Date(ms);
  const today = new Date().setHours(0, 0, 0, 0);
  const day = new Date(ms).setHours(0, 0, 0, 0);
  if (day === today) return '今日';
  if (day === today - 24 * 60 * 60 * 1000) return '昨日';
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

function timeLabel(ms: number): string {
  const d = new Date(ms);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function BookmarksSheet({
  visible,
  onClose,
  onOpen,
  onOpenInNewTab,
}: {
  visible: boolean;
  onClose: () => void;
  onOpen: (url: string) => void;
  onOpenInNewTab: (url: string) => void;
}) {
  const db = useSQLiteContext();
  const insets = useSafeAreaInsets();
  const [mode, setMode] = useState<Mode>('bookmarks');
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [search, setSearch] = useState('');

  const reload = useCallback(async () => {
    const [b, h] = await Promise.all([listBookmarks(db), listHistory(db, search)]);
    setBookmarks(b);
    setHistory(h);
  }, [db, search]);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    Promise.all([listBookmarks(db), listHistory(db, search)]).then(([b, h]) => {
      if (cancelled) return;
      setBookmarks(b);
      setHistory(h);
    });
    return () => {
      cancelled = true;
    };
  }, [visible, db, search]);

  const bookmarkMenu = (b: Bookmark, index: number) => {
    const actions: { label: string; run: () => void; destructive?: boolean }[] = [
      { label: '新しいタブで開く', run: () => onOpenInNewTab(b.url) },
      {
        label: '名前を変更',
        run: () =>
          Alert.prompt('名前を変更', undefined, (title) => updateBookmark(db, b.id, title, b.url).then(reload), 'plain-text', b.title),
      },
      {
        label: 'URLを変更',
        run: () =>
          Alert.prompt(
            'URLを変更',
            undefined,
            (url) => {
              if (/^https?:\/\/\S+$/i.test(url.trim())) {
                updateBookmark(db, b.id, b.title, url.trim()).then(reload);
              } else {
                Alert.alert('URLの形式が正しくありません', 'https:// から始まるURLを入力してください。');
              }
            },
            'plain-text',
            b.url,
            'url',
          ),
      },
    ];
    if (index > 0) actions.push({ label: '上へ移動', run: () => moveBookmark(db, b.id, -1).then(reload) });
    if (index < bookmarks.length - 1) actions.push({ label: '下へ移動', run: () => moveBookmark(db, b.id, 1).then(reload) });
    actions.push({ label: '削除', destructive: true, run: () => deleteBookmark(db, b.id).then(reload) });

    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: b.title,
        options: [...actions.map((a) => a.label), 'キャンセル'],
        cancelButtonIndex: actions.length,
        destructiveButtonIndex: actions.findIndex((a) => a.destructive),
      },
      (i) => actions[i]?.run(),
    );
  };

  const historyMenu = (h: HistoryEntry) => {
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: h.title || hostOf(h.url),
        options: ['新しいタブで開く', 'この履歴を削除', 'キャンセル'],
        cancelButtonIndex: 2,
        destructiveButtonIndex: 1,
      },
      (i) => {
        if (i === 0) onOpenInNewTab(h.url);
        if (i === 1) deleteHistoryEntry(db, h.id).then(reload);
      },
    );
  };

  const onClearHistory = () =>
    chooseHistoryRange('履歴を削除', (since) => {
      clearHistory(db, since).then(reload);
    });

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={[styles.screen, { paddingBottom: insets.bottom }]}>
        <View style={styles.header}>
          <View style={styles.headerSide}>
            {mode === 'history' ? (
              <Pressable accessibilityRole="button" onPress={onClearHistory} style={styles.headerButton}>
                <AppText variant="body" style={{ color: colors.dangerText }}>
                  削除…
                </AppText>
              </Pressable>
            ) : null}
          </View>
          <View style={styles.segment}>
            <SegmentedControl
              accessibilityLabel="表示する一覧"
              options={[
                { value: 'bookmarks', label: 'ブックマーク' },
                { value: 'history', label: '履歴' },
              ]}
              value={mode}
              onChange={setMode}
            />
          </View>
          <View style={[styles.headerSide, styles.headerRight]}>
            <Pressable accessibilityRole="button" onPress={onClose} style={styles.headerButton}>
              <AppText variant="bodyBold" tone="accent">
                完了
              </AppText>
            </Pressable>
          </View>
        </View>

        {mode === 'bookmarks' ? (
          <FlatList
            data={bookmarks}
            keyExtractor={(b) => String(b.id)}
            contentContainerStyle={styles.list}
            ListEmptyComponent={
              <AppText variant="caption" tone="muted" style={styles.empty}>
                ブックマークはまだありません。ページを開いてアドレスバーの ☆ を押すと追加できます。
              </AppText>
            }
            ListFooterComponent={
              bookmarks.length ? (
                <AppText variant="small" tone="muted" style={styles.hint}>
                  長押しで名前の変更・並べ替え・削除ができます。
                </AppText>
              ) : null
            }
            renderItem={({ item, index }) => (
              <Pressable
                accessibilityRole="link"
                accessibilityHint="長押しでメニュー"
                onPress={() => onOpen(item.url)}
                onLongPress={() => bookmarkMenu(item, index)}
                style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
                <SymbolView name="star.fill" tintColor={colors.accent} size={16} />
                <View style={styles.rowText}>
                  <AppText variant="body" numberOfLines={1}>
                    {item.title}
                  </AppText>
                  <AppText variant="small" tone="muted" numberOfLines={1}>
                    {hostOf(item.url)}
                  </AppText>
                </View>
                <Pressable accessibilityRole="button" accessibilityLabel={`${item.title}のメニュー`} hitSlop={8} onPress={() => bookmarkMenu(item, index)} style={styles.more}>
                  <SymbolView name="ellipsis" tintColor={colors.textSecondary} size={16} />
                </Pressable>
              </Pressable>
            )}
          />
        ) : (
          <FlatList
            data={history}
            keyExtractor={(h) => String(h.id)}
            contentContainerStyle={styles.list}
            keyboardShouldPersistTaps="handled"
            ListHeaderComponent={
              <View style={styles.searchField}>
                <SymbolView name="magnifyingglass" tintColor={colors.textMuted} size={14} />
                <TextInput
                  accessibilityLabel="履歴を検索"
                  placeholder="履歴を検索"
                  placeholderTextColor={colors.textMuted}
                  value={search}
                  onChangeText={setSearch}
                  autoCapitalize="none"
                  autoCorrect={false}
                  clearButtonMode="while-editing"
                  style={styles.searchInput}
                />
              </View>
            }
            ListEmptyComponent={
              <AppText variant="caption" tone="muted" style={styles.empty}>
                {search ? '見つかりませんでした。' : '履歴はありません。プライベートタブで見たページは記録されません。'}
              </AppText>
            }
            renderItem={({ item, index }) => {
              const showDay = index === 0 || dayLabel(history[index - 1].visitedAt) !== dayLabel(item.visitedAt);
              return (
                <View>
                  {showDay ? (
                    <AppText variant="caption" tone="secondary" style={styles.day}>
                      {dayLabel(item.visitedAt)}
                    </AppText>
                  ) : null}
                  <Pressable
                    accessibilityRole="link"
                    accessibilityHint="長押しでメニュー"
                    onPress={() => onOpen(item.url)}
                    onLongPress={() => historyMenu(item)}
                    style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
                    <View style={styles.rowText}>
                      <AppText variant="body" numberOfLines={1}>
                        {item.title || hostOf(item.url)}
                      </AppText>
                      <AppText variant="small" tone="muted" numberOfLines={1}>
                        {timeLabel(item.visitedAt)}・{hostOf(item.url)}
                      </AppText>
                    </View>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="この履歴を削除"
                      hitSlop={8}
                      onPress={() => deleteHistoryEntry(db, item.id).then(reload)}
                      style={styles.more}>
                      <SymbolView name="xmark" tintColor={colors.textMuted} size={13} />
                    </Pressable>
                  </Pressable>
                </View>
              );
            }}
          />
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 4, paddingTop: 8, paddingBottom: 8 },
  headerSide: { width: 76 },
  headerRight: { alignItems: 'flex-end' },
  headerButton: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 12 },
  segment: { flex: 1 },
  list: { paddingHorizontal: 16, paddingBottom: 24 },
  empty: { textAlign: 'center', paddingVertical: 40, paddingHorizontal: 16, lineHeight: 20 },
  hint: { textAlign: 'center', paddingVertical: 16 },
  row: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  pressed: { opacity: 0.6 },
  rowText: { flex: 1, gap: 2 },
  more: { width: 36, height: 44, alignItems: 'center', justifyContent: 'center' },
  day: { paddingTop: 16, paddingBottom: 4 },
  searchField: {
    height: 38,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    marginTop: 4,
  },
  searchInput: { flex: 1, color: colors.text, fontFamily: fonts.regular, fontSize: 14, height: 38 },
});
