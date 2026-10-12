import { Image } from 'expo-image';
import { useSQLiteContext } from 'expo-sqlite';
import * as VideoThumbnails from 'expo-video-thumbnails';
import { SymbolView } from 'expo-symbols';
import { useEffect, useState } from 'react';
import { ActionSheetIOS, Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppText } from '@/components/app-text';
import type { DetectedMedia } from '@/browser/detector';
import type { DownloadOutput } from '@/db/downloads';
import { listFolders } from '@/db/library';
import { UNSORTED_FOLDER_ID } from '@/db/schema';
import { colors, placeholderTint, radius } from '@/theme';

const outputOptions: { value: DownloadOutput; label: string }[] = [
  { value: 'video', label: '動画' },
  { value: 'm4a', label: '音声 m4a' },
  { value: 'mp3', label: '音声 mp3' },
];

export function DetectedSheet({
  visible,
  media,
  onClose,
  onDismiss,
  onDownload,
}: {
  visible: boolean;
  media: DetectedMedia[];
  onClose: () => void;
  // 閉じるアニメーションが終わったとき（このあとでないと広告や確認ダイアログを出せない）
  onDismiss?: () => void;
  onDownload: (item: DetectedMedia, output: DownloadOutput, folderId: number) => void;
}) {
  const db = useSQLiteContext();
  const insets = useSafeAreaInsets();
  const [folder, setFolder] = useState({ id: UNSORTED_FOLDER_ID, name: '未分類' });

  const chooseFolder = async () => {
    const folders = await listFolders(db, 'video');
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: '保存先のフォルダ',
        options: [...folders.map((f) => (f.hasPasscode ? `🔒 ${f.name}` : f.name)), 'キャンセル'],
        cancelButtonIndex: folders.length,
      },
      (i) => {
        const f = folders[i];
        if (f) setFolder({ id: f.id, name: f.name });
      },
    );
  };
  const [selectedUrl, setSelectedUrl] = useState<string | null>(null);
  const [output, setOutput] = useState<DownloadOutput>('video');
  const selected = media.find((m) => m.url === selectedUrl) ?? media[0];

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} onDismiss={onDismiss}>
      <Pressable accessibilityLabel="閉じる" style={styles.backdrop} onPress={onClose} />
      <View style={[styles.sheet, { paddingBottom: insets.bottom + 16 }]}>
        <View style={styles.grabber} />
        <View style={styles.headerRow}>
          <AppText variant="title" accessibilityRole="header">
            検出した動画
          </AppText>
          <AppText variant="caption" tone="secondary">
            {media.length}件
          </AppText>
        </View>

        <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
          {media.map((item, index) => {
            const isSelected = item.url === selected?.url;
            return (
              <Pressable
                key={item.url}
                accessibilityRole="radio"
                accessibilityState={{ selected: isSelected }}
                onPress={() => setSelectedUrl(item.url)}
                style={[styles.item, isSelected && styles.itemSelected]}>
                <DetectedThumb item={item} index={index} />
                <View style={styles.itemText}>
                  <AppText variant="bodyBold" numberOfLines={1}>
                    {item.pageTitle}
                  </AppText>
                  <AppText variant="small" tone="secondary" numberOfLines={1}>
                    {item.kind === 'hls' ? 'HLS' : (item.container ?? '不明').toUpperCase()}・{hostOf(item.url)}
                  </AppText>
                </View>
              </Pressable>
            );
          })}
        </ScrollView>

        <View style={styles.modes} accessibilityRole="radiogroup" accessibilityLabel="保存形式">
          {outputOptions.map((option) => {
            const isSelected = option.value === output;
            return (
              <Pressable
                key={option.value}
                accessibilityRole="radio"
                accessibilityState={{ selected: isSelected }}
                onPress={() => setOutput(option.value)}
                style={[styles.mode, isSelected && styles.modeSelected]}>
                <AppText variant="bodyBold" tone={isSelected ? 'accent' : 'primary'}>
                  {option.label}
                </AppText>
              </Pressable>
            );
          })}
        </View>

        <Pressable accessibilityRole="button" accessibilityLabel={`保存先、${folder.name}`} onPress={chooseFolder} style={styles.folderRow}>
          <SymbolView name="folder" tintColor={colors.textSecondary} size={16} />
          <AppText variant="body" tone="secondary" style={styles.folderLabel}>
            保存先
          </AppText>
          <AppText variant="bodyBold" numberOfLines={1} style={styles.folderName}>
            {folder.name}
          </AppText>
          <SymbolView name="chevron.right" tintColor={colors.textMuted} size={12} />
        </Pressable>

        <Pressable
          accessibilityRole="button"
          disabled={!selected}
          onPress={() => selected && onDownload(selected, output, folder.id)}
          style={styles.downloadButton}>
          <AppText variant="bodyBold" tone="onAccent" style={styles.downloadLabel}>
            ダウンロード
          </AppText>
        </Pressable>
      </View>
    </Modal>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

// ポスター画像があればそれを、無ければ（MP4 など iOS が読める形式なら）動画の1秒目から作る
function DetectedThumb({ item, index }: { item: DetectedMedia; index: number }) {
  const [generated, setGenerated] = useState<{ url: string; uri: string } | null>(null);
  const canGenerate = !item.poster && item.kind === 'file' && ['mp4', 'm4v', 'mov'].includes(item.container ?? '');

  useEffect(() => {
    if (!canGenerate) return;
    let cancelled = false;
    VideoThumbnails.getThumbnailAsync(item.url, { time: 1000, quality: 0.5, headers: { Referer: item.pageUrl } })
      .then((r) => {
        if (!cancelled) setGenerated({ url: item.url, uri: r.uri });
      })
      .catch(() => {
        // 作れなければアイコンのまま
      });
    return () => {
      cancelled = true;
    };
  }, [canGenerate, item.url, item.pageUrl]);

  const uri = item.poster ?? (generated?.url === item.url ? generated.uri : null);
  return (
    <View style={[styles.thumb, { backgroundColor: placeholderTint(index) }]}>
      {uri ? (
        <Image source={{ uri, headers: item.poster ? { Referer: item.pageUrl } : undefined }} style={StyleSheet.absoluteFill} contentFit="cover" />
      ) : (
        <SymbolView name={item.kind === 'hls' ? 'play.rectangle' : 'film'} tintColor="rgba(255,255,255,0.7)" size={18} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    paddingHorizontal: 20,
    paddingTop: 10,
    gap: 14,
    maxHeight: '75%',
  },
  grabber: { width: 40, height: 5, borderRadius: 3, backgroundColor: '#44474F', alignSelf: 'center' },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  list: { flexGrow: 0 },
  listContent: { gap: 10 },
  item: {
    flexDirection: 'row',
    gap: 12,
    alignItems: 'center',
    padding: 10,
    borderRadius: radius.lg,
    backgroundColor: '#202329',
    borderWidth: 2,
    borderColor: 'transparent',
  },
  itemSelected: { backgroundColor: colors.surfaceRaised, borderColor: colors.accent },
  thumb: { width: 88, height: 50, borderRadius: radius.sm, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  itemText: { flex: 1, gap: 3 },
  modes: { flexDirection: 'row', gap: 8 },
  mode: {
    flex: 1,
    height: 44,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#3A3D44',
    alignItems: 'center',
    justifyContent: 'center',
  },
  modeSelected: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  folderRow: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 40 },
  folderLabel: { flexShrink: 0 },
  folderName: { flex: 1, textAlign: 'right' },
  downloadButton: {
    height: 52,
    borderRadius: radius.lg,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  downloadLabel: { fontSize: 16 },
});
