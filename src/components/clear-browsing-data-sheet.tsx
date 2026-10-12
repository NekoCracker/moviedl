import { useSQLiteContext } from 'expo-sqlite';
import { SymbolView } from 'expo-symbols';
import { MediaTools } from 'media-tools';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { AppText } from '@/components/app-text';
import { historyRanges } from '@/components/browser/bookmarks-sheet';
import { notifyBrowsingDataCleared } from '@/browser/events';
import { clearHistory } from '@/db/browser';
import { colors, radius } from '@/theme';
import { formatBytes } from '@/utils/format';

type Target = 'history' | 'cache' | 'cookies' | 'detected';

// 設定 › 閲覧データを削除（feature-spec.md §2-7）。消すものと期間を選んで一括削除する
export function ClearBrowsingDataSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const db = useSQLiteContext();
  const [targets, setTargets] = useState<Record<Target, boolean>>({ history: true, cache: true, cookies: false, detected: true });
  const [rangeIndex, setRangeIndex] = useState(historyRanges.length - 1);
  const [cacheBytes, setCacheBytes] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!visible || !MediaTools) return;
    let cancelled = false;
    MediaTools.websiteDataSize()
      .then((bytes) => {
        if (!cancelled) setCacheBytes(bytes);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [visible]);

  const toggle = (t: Target) => setTargets((prev) => ({ ...prev, [t]: !prev[t] }));
  const anySelected = Object.values(targets).some(Boolean);

  const run = async () => {
    const since = historyRanges[rangeIndex].since();
    setBusy(true);
    try {
      if (targets.history) await clearHistory(db, since);
      const web: ('cache' | 'cookies')[] = [];
      if (targets.cache) web.push('cache');
      if (targets.cookies) web.push('cookies');
      if (web.length > 0 && MediaTools) await MediaTools.clearWebsiteData(web, since);
      notifyBrowsingDataCleared({ detected: targets.detected });
      onClose();
      Alert.alert('削除しました');
    } catch (e) {
      Alert.alert('削除できませんでした', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const confirm = () => {
    if (!targets.cookies) {
      run();
      return;
    }
    Alert.alert('Cookieとサイトデータを削除', 'サイトのログイン状態も消えます。', [
      { text: 'キャンセル', style: 'cancel' },
      { text: '削除', style: 'destructive', onPress: run },
    ]);
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={styles.screen}>
        <View style={styles.header}>
          <Pressable accessibilityRole="button" onPress={onClose} style={styles.headerButton}>
            <AppText variant="body" tone="accent">
              キャンセル
            </AppText>
          </Pressable>
          <AppText variant="bodyBold" accessibilityRole="header">
            閲覧データを削除
          </AppText>
          <View style={styles.headerButton} />
        </View>

        <ScrollView contentContainerStyle={styles.content}>
          <AppText variant="caption" tone="secondary" style={styles.sectionTitle}>
            期間
          </AppText>
          <View style={styles.card}>
            {historyRanges.map((r, i) => (
              <Check key={r.label} label={r.label} checked={rangeIndex === i} radio onPress={() => setRangeIndex(i)} />
            ))}
          </View>

          <AppText variant="caption" tone="secondary" style={styles.sectionTitle}>
            削除するもの
          </AppText>
          <View style={styles.card}>
            <Check label="閲覧履歴" checked={targets.history} onPress={() => toggle('history')} />
            <Check
              label="キャッシュ（画像・ファイル）"
              detail={cacheBytes != null ? `使用中 ${formatBytes(cacheBytes)}` : undefined}
              checked={targets.cache}
              onPress={() => toggle('cache')}
            />
            <Check label="Cookieとサイトデータ" detail="ログイン状態も消えます" checked={targets.cookies} onPress={() => toggle('cookies')} />
            <Check label="検出した動画のリスト" checked={targets.detected} onPress={() => toggle('detected')} />
          </View>

          <AppText variant="small" tone="secondary" style={styles.note}>
            ダウンロードした動画とブックマークは消えません。プライベートタブの閲覧データは、タブを閉じたときに消えています。
          </AppText>

          <Pressable
            accessibilityRole="button"
            disabled={!anySelected || busy}
            onPress={confirm}
            style={[styles.button, (!anySelected || busy) && styles.disabled]}>
            {busy ? <ActivityIndicator color={colors.text} /> : <AppText variant="bodyBold" style={{ color: colors.dangerText }}>削除する</AppText>}
          </Pressable>
        </ScrollView>
      </View>
    </Modal>
  );
}

function Check({ label, detail, checked, radio, onPress }: { label: string; detail?: string; checked: boolean; radio?: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole={radio ? 'radio' : 'checkbox'}
      accessibilityState={{ checked }}
      onPress={onPress}
      style={styles.row}>
      <View style={styles.rowText}>
        <AppText variant="body">{label}</AppText>
        {detail ? (
          <AppText variant="small" tone="secondary">
            {detail}
          </AppText>
        ) : null}
      </View>
      {radio ? (
        checked ? <SymbolView name="checkmark" tintColor={colors.accent} size={16} weight="bold" /> : null
      ) : (
        <SymbolView name={checked ? 'checkmark.circle.fill' : 'circle'} tintColor={checked ? colors.accent : colors.textMuted} size={22} />
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 4, paddingTop: 8 },
  headerButton: { minHeight: 44, minWidth: 80, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 12 },
  content: { padding: 16, gap: 6, paddingBottom: 48 },
  sectionTitle: { paddingHorizontal: 4, paddingTop: 14 },
  card: { backgroundColor: colors.surface, borderRadius: radius.lg, overflow: 'hidden' },
  row: {
    minHeight: 52,
    paddingHorizontal: 16,
    paddingVertical: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  rowText: { flex: 1, gap: 2 },
  note: { paddingHorizontal: 4, paddingTop: 10, lineHeight: 18 },
  button: { marginTop: 20, height: 50, borderRadius: radius.lg, backgroundColor: colors.dangerSurface, alignItems: 'center', justifyContent: 'center' },
  disabled: { opacity: 0.4 },
});
