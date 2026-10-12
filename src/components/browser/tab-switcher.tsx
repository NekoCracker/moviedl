import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
import { Alert, Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppText } from '@/components/app-text';
import { hostOf, initialOf } from '@/components/browser/site-label';
import { SegmentedControl } from '@/components/segmented-control';
import { MAX_TABS, START_PAGE_URL, type BrowserTab } from '@/db/browser';
import { colors, placeholderTint, radius } from '@/theme';

type Mode = 'normal' | 'private';

// タブ一覧。通常タブとプライベートタブを切り替えて表示する。
export function TabSwitcher({
  visible,
  tabs,
  activePrivate,
  onClose,
  onSelect,
  onCloseTab,
  onCloseAll,
  onNewTab,
}: {
  visible: boolean;
  tabs: BrowserTab[];
  activePrivate: boolean;
  onClose: () => void;
  onSelect: (id: number) => void;
  onCloseTab: (id: number) => void;
  onCloseAll: (isPrivate: boolean) => void;
  onNewTab: (isPrivate: boolean) => void;
}) {
  const insets = useSafeAreaInsets();
  const [mode, setMode] = useState<Mode>(activePrivate ? 'private' : 'normal');
  const isPrivate = mode === 'private';
  const shown = tabs.filter((t) => t.isPrivate === isPrivate);
  const full = tabs.length >= MAX_TABS;

  const confirmCloseAll = () => {
    if (shown.length === 0) return;
    Alert.alert(isPrivate ? 'プライベートタブをすべて閉じる' : 'タブをすべて閉じる', `${shown.length}個のタブを閉じます。`, [
      { text: 'キャンセル', style: 'cancel' },
      { text: '閉じる', style: 'destructive', onPress: () => onCloseAll(isPrivate) },
    ]);
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={[styles.screen, { paddingBottom: insets.bottom + 8 }]}>
        <View style={styles.header}>
          <Pressable accessibilityRole="button" onPress={confirmCloseAll} style={styles.headerButton}>
            <AppText variant="body" tone={shown.length ? 'accent' : 'muted'}>
              すべて閉じる
            </AppText>
          </Pressable>
          <AppText variant="bodyBold" accessibilityRole="header">
            タブ {tabs.length}/{MAX_TABS}
          </AppText>
          <Pressable accessibilityRole="button" onPress={onClose} style={styles.headerButton}>
            <AppText variant="bodyBold" tone="accent">
              完了
            </AppText>
          </Pressable>
        </View>
        <View style={styles.segment}>
          <SegmentedControl
            accessibilityLabel="タブの種類"
            options={[
              { value: 'normal', label: '通常' },
              { value: 'private', label: 'プライベート' },
            ]}
            value={mode}
            onChange={setMode}
          />
        </View>

        <ScrollView contentContainerStyle={styles.grid}>
          {shown.length === 0 ? (
            <AppText variant="caption" tone="muted" style={styles.empty}>
              {isPrivate ? 'プライベートタブはありません。履歴を残さずに見たいときに使えます。' : 'タブはありません。'}
            </AppText>
          ) : null}
          {shown.map((tab, i) => {
            const title = tab.url === START_PAGE_URL ? '新しいタブ' : tab.title || hostOf(tab.url);
            return (
              <Pressable
                key={tab.id}
                accessibilityRole="button"
                accessibilityLabel={`${title}${tab.isActive ? '（表示中）' : ''}`}
                onPress={() => onSelect(tab.id)}
                style={[styles.card, tab.isActive && styles.cardActive]}>
                <View style={styles.cardHeader}>
                  <AppText variant="small" numberOfLines={1} style={styles.cardTitle}>
                    {title}
                  </AppText>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`${title}を閉じる`}
                    hitSlop={8}
                    onPress={() => onCloseTab(tab.id)}
                    style={styles.closeButton}>
                    <SymbolView name="xmark" tintColor={colors.textSecondary} size={12} weight="bold" />
                  </Pressable>
                </View>
                <View style={[styles.preview, { backgroundColor: placeholderTint(i) }]}>
                  <AppText variant="largeTitle">{tab.url === START_PAGE_URL ? '＋' : initialOf(tab.title, tab.url)}</AppText>
                  {tab.url !== START_PAGE_URL ? (
                    <AppText variant="small" tone="secondary" numberOfLines={1} style={styles.host}>
                      {hostOf(tab.url)}
                    </AppText>
                  ) : null}
                </View>
              </Pressable>
            );
          })}
        </ScrollView>

        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: full }}
          disabled={full}
          onPress={() => onNewTab(isPrivate)}
          style={[styles.newTab, full && styles.disabled]}>
          <SymbolView name="plus" tintColor={colors.onAccent} size={16} weight="bold" />
          <AppText variant="bodyBold" tone="onAccent">
            {full ? `タブは${MAX_TABS}個までです` : isPrivate ? '新しいプライベートタブ' : '新しいタブ'}
          </AppText>
        </Pressable>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 8, paddingTop: 8 },
  headerButton: { minHeight: 44, minWidth: 44, justifyContent: 'center', paddingHorizontal: 12 },
  segment: { paddingHorizontal: 16, paddingVertical: 8 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', padding: 16, rowGap: 14 },
  empty: { width: '100%', textAlign: 'center', paddingVertical: 40 },
  card: { width: '48%', backgroundColor: colors.surface, borderRadius: radius.lg, overflow: 'hidden', borderWidth: 2, borderColor: 'transparent' },
  cardActive: { borderColor: colors.accent },
  cardHeader: { flexDirection: 'row', alignItems: 'center', paddingLeft: 10, height: 34 },
  cardTitle: { flex: 1 },
  closeButton: { width: 34, height: 34, alignItems: 'center', justifyContent: 'center' },
  preview: { height: 150, alignItems: 'center', justifyContent: 'center', gap: 6 },
  host: { paddingHorizontal: 8 },
  newTab: {
    marginHorizontal: 16,
    height: 50,
    borderRadius: 25,
    backgroundColor: colors.accent,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  disabled: { opacity: 0.4 },
});
