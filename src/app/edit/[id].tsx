import { useEvent } from 'expo';
import { router, useLocalSearchParams } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useEffect, useState } from 'react';
import { ActionSheetIOS, ActivityIndicator, Alert, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppText } from '@/components/app-text';
import { RangeSlider } from '@/components/range-slider';
import { Scrubber } from '@/components/scrubber';
import { getMediaByIds, type MediaItem } from '@/db/library';
import { mediaFile } from '@/download/storage';
import { createThumbnail, NATIVE_VIDEO_CONTAINERS, queueConversion } from '@/library/media-actions';
import { seekTo } from '@/player/controls';
import { usePlayback } from '@/player/playback';
import { colors, radius } from '@/theme';
import { formatDuration } from '@/utils/format';

// プレミアム機能: トリミングとサムネイル選択（feature-spec.md §3）
export default function EditScreen() {
  const db = useSQLiteContext();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ id: string; mode?: 'trim' | 'thumbnail' }>();
  const mode = params.mode === 'thumbnail' ? 'thumbnail' : 'trim';
  const playback = usePlayback();
  const [item, setItem] = useState<MediaItem | null>(null);
  const [range, setRange] = useState<{ start: number; end: number } | null>(null);
  const [saving, setSaving] = useState(false);

  const player = useVideoPlayer(null, (p) => {
    p.timeUpdateEventInterval = 0.25;
    p.loop = false;
  });

  useEffect(() => {
    getMediaByIds(db, [Number(params.id)]).then(([found]) => setItem(found ?? null));
  }, [db, params.id]);

  const previewable = item ? NATIVE_VIDEO_CONTAINERS.includes(item.container ?? '') : false;

  useEffect(() => {
    if (!item || !previewable) return;
    // 編集中はメインの再生を止める
    playback.player.pause();
    player.replaceAsync({ uri: mediaFile(item.filePath).uri });
    // playback.player は同じオブジェクトのまま
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item, previewable, player]);

  const { status } = useEvent(player, 'statusChange', { status: player.status });
  const { isPlaying } = useEvent(player, 'playingChange', { isPlaying: player.playing });
  const { currentTime } = useEvent(player, 'timeUpdate', {
    currentTime: 0,
    currentLiveTimestamp: null,
    currentOffsetFromLive: null,
    bufferedPosition: 0,
  });
  const duration = item?.durationSec ?? (player.duration > 0 ? player.duration : 0);
  const selected = range ?? { start: 0, end: duration };

  // トリミングのプレビューは選んだ範囲の終わりで止める
  useEffect(() => {
    if (mode === 'trim' && isPlaying && currentTime >= selected.end) {
      player.pause();
    }
  }, [mode, isPlaying, currentTime, selected.end, player]);

  const playRange = () => {
    if (isPlaying) {
      player.pause();
      return;
    }
    if (mode === 'trim' && (currentTime < selected.start || currentTime >= selected.end - 0.2)) {
      seekTo(player, selected.start);
    }
    player.play();
  };

  const saveThumbnail = async () => {
    if (!item) return;
    setSaving(true);
    try {
      await createThumbnail(db, item, player.currentTime);
      await playback.refresh();
      router.back();
    } catch (e) {
      Alert.alert('サムネイルを作れませんでした', e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const saveTrim = () => {
    if (!item) return;
    const { start, end } = selected;
    if (end - start < 1) return;
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: `${formatDuration(start)} 〜 ${formatDuration(end)}（${formatDuration(end - start)}）`,
        options: ['新しい動画として保存', '元の動画を置き換える', 'キャンセル'],
        cancelButtonIndex: 2,
        destructiveButtonIndex: 1,
      },
      async (i) => {
        if (i > 1) return;
        // 書き出しはネイティブの変換キューで行う（区間ごとに保存し、中断しても再開できる。feature-spec.md §2-12）
        await queueConversion(db, item.id, 'trim', { start, end, replace: i === 1 });
        Alert.alert('トリミングを開始しました', '進み具合は「ダウンロード」タブで確認できます。');
        router.back();
      },
    );
  };

  return (
    <View style={[styles.screen, { paddingBottom: insets.bottom + 16 }]}>
      <View style={styles.header}>
        <Pressable accessibilityRole="button" onPress={() => router.back()} style={styles.headerButton}>
          <AppText variant="body" tone="accent">
            キャンセル
          </AppText>
        </Pressable>
        <AppText variant="bodyBold" accessibilityRole="header">
          {mode === 'trim' ? 'トリミング' : 'サムネイルを選ぶ'}
        </AppText>
        <Pressable
          accessibilityRole="button"
          disabled={saving || !item || duration <= 0}
          onPress={mode === 'trim' ? saveTrim : saveThumbnail}
          style={styles.headerButton}>
          {saving ? (
            <ActivityIndicator color={colors.accent} />
          ) : (
            <AppText variant="bodyBold" tone={duration > 0 ? 'accent' : 'muted'}>
              {mode === 'trim' ? '保存' : '決定'}
            </AppText>
          )}
        </Pressable>
      </View>

      <View style={styles.videoBox}>
        {previewable ? (
          <VideoView player={player} style={styles.video} contentFit="contain" nativeControls={false} />
        ) : (
          // TODO: VLCKit 組み込み後は WebM/MKV もここでプレビューする
          <AppText variant="caption" tone="secondary" style={styles.note}>
            {item ? 'この形式はプレビューできません。MP4に変換すると編集しやすくなります。' : ''}
          </AppText>
        )}
        {previewable && status === 'loading' ? <ActivityIndicator style={StyleSheet.absoluteFill} color={colors.text} /> : null}
      </View>

      <AppText variant="body" numberOfLines={1} style={styles.title}>
        {item?.title ?? ''}
      </AppText>

      <View style={styles.controls}>
        {mode === 'trim' ? (
          <>
            <RangeSlider
              duration={duration}
              start={selected.start}
              end={selected.end}
              position={currentTime}
              onChange={(start, end) => setRange({ start, end })}
              onScrub={(s) => {
                player.pause();
                seekTo(player, s);
              }}
            />
            <View style={styles.rangeLabels}>
              <AppText variant="small" tone="secondary">
                開始 {formatDuration(selected.start)}
              </AppText>
              <AppText variant="small" tone="accent">
                {formatDuration(selected.end - selected.start)}
              </AppText>
              <AppText variant="small" tone="secondary">
                終了 {formatDuration(selected.end)}
              </AppText>
            </View>
          </>
        ) : (
          <>
            <Scrubber position={currentTime} duration={duration} onSeek={(s) => seekTo(player, s)} />
            <AppText variant="caption" tone="secondary" style={styles.hint}>
              バーを動かして、サムネイルにしたい場面で「決定」を押してください。
            </AppText>
          </>
        )}

        <Pressable accessibilityRole="button" onPress={playRange} disabled={!previewable} style={[styles.play, !previewable && styles.disabled]}>
          <AppText variant="bodyBold">{isPlaying ? '一時停止' : mode === 'trim' ? '範囲を再生' : '再生'}</AppText>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 4, paddingTop: 8 },
  headerButton: { minHeight: 44, minWidth: 64, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 12 },
  videoBox: { height: 240, backgroundColor: '#000', marginTop: 8, alignItems: 'center', justifyContent: 'center' },
  video: { width: '100%', height: '100%' },
  note: { padding: 24, textAlign: 'center', lineHeight: 20 },
  title: { paddingHorizontal: 20, paddingTop: 16 },
  controls: { paddingHorizontal: 20, paddingTop: 20, gap: 12 },
  rangeLabels: { flexDirection: 'row', justifyContent: 'space-between' },
  hint: { lineHeight: 19 },
  play: { height: 48, borderRadius: radius.lg, backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center', marginTop: 8 },
  disabled: { opacity: 0.4 },
});
