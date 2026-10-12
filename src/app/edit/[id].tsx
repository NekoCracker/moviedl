import { router, useLocalSearchParams } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { VideoView } from 'expo-video';
import { VlcVideoView } from 'media-tools';
import { useEffect, useState } from 'react';
import { ActionSheetIOS, ActivityIndicator, Alert, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppText } from '@/components/app-text';
import { RangeSlider } from '@/components/range-slider';
import { Scrubber } from '@/components/scrubber';
import { getMediaByIds, type MediaItem } from '@/db/library';
import { createThumbnail, queueConversion } from '@/library/media-actions';
import { checkDeviceBeforeConvert, runConversions } from '@/convert/engine';
import { usePlayback } from '@/player/playback';
import { useEditPreview } from '@/player/use-edit-preview';
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

  useEffect(() => {
    getMediaByIds(db, [Number(params.id)]).then(([found]) => setItem(found ?? null));
  }, [db, params.id]);

  const preview = useEditPreview(item, playback.pause);
  const { isPlaying, currentTime, duration } = preview;
  const previewable = preview.kind !== 'none';
  const selected = range ?? { start: 0, end: duration };

  // トリミングのプレビューは選んだ範囲の終わりで止める
  useEffect(() => {
    if (mode === 'trim' && isPlaying && currentTime >= selected.end) {
      preview.pause();
    }
  }, [mode, isPlaying, currentTime, selected.end, preview]);

  const nudgeRange = (edge: 'start' | 'end', delta: number) => {
    const next = { ...selected };
    if (edge === 'start') next.start = Math.min(Math.max(0, round1(next.start + delta)), next.end - 1);
    else next.end = Math.max(Math.min(duration, round1(next.end + delta)), next.start + 1);
    setRange(next);
    preview.pause();
    preview.seek(edge === 'start' ? next.start : next.end);
  };

  const stepFrame = (direction: 1 | -1) => {
    preview.pause();
    preview.seek(Math.min(duration, Math.max(0, preview.getTime() + direction / 30)));
  };

  const playRange = () => {
    if (isPlaying) {
      preview.pause();
      return;
    }
    if (mode === 'trim' && (currentTime < selected.start || currentTime >= selected.end - 0.2)) {
      preview.seek(selected.start);
    }
    preview.play();
  };

  const saveThumbnail = async () => {
    if (!item) return;
    setSaving(true);
    try {
      await createThumbnail(db, item, preview.getTime());
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
        if (!(await checkDeviceBeforeConvert())) return;
        // 書き出しはネイティブの変換キューで行う（区間ごとに保存し、中断しても再開できる。feature-spec.md §2-12）
        await queueConversion(db, item.id, 'trim', { start, end, replace: i === 1 });
        runConversions(db);
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
        {preview.kind === 'native' ? (
          <VideoView player={preview.player} style={styles.video} contentFit="contain" nativeControls={false} />
        ) : preview.kind === 'vlc' ? (
          <VlcVideoView style={styles.video} />
        ) : (
          <AppText variant="caption" tone="secondary" style={styles.note}>
            {item ? 'この形式はプレビューできません。MP4に変換すると編集しやすくなります。' : ''}
          </AppText>
        )}
        {previewable && preview.loading ? <ActivityIndicator style={StyleSheet.absoluteFill} color={colors.text} /> : null}
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
                preview.pause();
                preview.seek(s);
              }}
            />
            <View style={styles.rangeLabels}>
              <AppText variant="small" tone="secondary">
                開始 {formatTenths(selected.start)}
              </AppText>
              <AppText variant="small" tone="accent">
                {formatDuration(selected.end - selected.start)}
              </AppText>
              <AppText variant="small" tone="secondary">
                終了 {formatTenths(selected.end)}
              </AppText>
            </View>
            {/* 0.1秒単位の微調整（feature-spec.md §2-16） */}
            <View style={styles.nudgeRow}>
              <NudgeButton label="−0.1" hint="開始を0.1秒前へ" onPress={() => nudgeRange('start', -0.1)} />
              <NudgeButton label="+0.1" hint="開始を0.1秒後へ" onPress={() => nudgeRange('start', 0.1)} />
              <View style={styles.nudgeGap} />
              <NudgeButton label="−0.1" hint="終了を0.1秒前へ" onPress={() => nudgeRange('end', -0.1)} />
              <NudgeButton label="+0.1" hint="終了を0.1秒後へ" onPress={() => nudgeRange('end', 0.1)} />
            </View>
          </>
        ) : (
          <>
            <Scrubber position={currentTime} duration={duration} onSeek={preview.seek} />
            {/* 1コマずつ動かす（フレームレートは分からないので 1/30 秒刻み。feature-spec.md §2-17） */}
            <View style={styles.nudgeRow}>
              <NudgeButton label="前のコマ" hint="1コマ戻る" onPress={() => stepFrame(-1)} />
              <AppText variant="small" tone="secondary" style={styles.nudgeTime}>
                {formatTenths(currentTime)}
              </AppText>
              <NudgeButton label="次のコマ" hint="1コマ進む" onPress={() => stepFrame(1)} />
            </View>
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

function round1(t: number) {
  return Math.round(t * 10) / 10;
}

// 1:23.4 の形（0.1秒まで）
function formatTenths(t: number) {
  const whole = Math.floor(t);
  return `${formatDuration(whole)}.${Math.floor((t - whole) * 10)}`;
}

function NudgeButton({ label, hint, onPress }: { label: string; hint: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={hint} onPress={onPress} style={styles.nudge}>
      <AppText variant="small">{label}</AppText>
    </Pressable>
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
  nudgeRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  nudgeGap: { flex: 1 },
  nudgeTime: { flex: 1, textAlign: 'center' },
  nudge: { minHeight: 44, minWidth: 56, paddingHorizontal: 12, borderRadius: radius.md, backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center' },
  play: { height: 48, borderRadius: radius.lg, backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center', marginTop: 8 },
  disabled: { opacity: 0.4 },
});
