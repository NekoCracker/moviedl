import { Image } from 'expo-image';
import { router } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { Pressable, StyleSheet, View } from 'react-native';

import { AppText } from '@/components/app-text';
import { thumbnailUri } from '@/library/media-actions';
import { usePlayback, usePlaybackTime } from '@/player/playback';
import { colors, placeholderTint, radius } from '@/theme';

// 画面下に出す再生中の表示。タップでプレイヤーを開く。一時停止中は × で閉じられる。
// compact は iOS 26 のタブバーに収まる小さい表示（スクロールでタブバーが縮んだとき）
export function MiniPlayer({ compact = false }: { compact?: boolean }) {
  const { current, duration, isPlaying, togglePlay, next, stop } = usePlayback();
  const currentTime = usePlaybackTime();
  if (!current) return null;

  const progress = duration > 0 ? Math.min(1, currentTime / duration) : 0;
  const thumb = thumbnailUri(current.thumbnailPath);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`再生中: ${current.title}`}
      accessibilityHint="プレイヤーを開く"
      onPress={() => router.push('/player')}
      style={[styles.container, compact && styles.compact]}>
      <View style={[styles.thumb, compact && styles.thumbCompact, { backgroundColor: placeholderTint(current.id) }]}>
        {thumb ? <Image source={{ uri: thumb }} style={StyleSheet.absoluteFill} contentFit="cover" /> : null}
        {current.mediaType === 'audio' && !thumb ? <SymbolView name="music.note" tintColor={colors.text} size={14} /> : null}
      </View>
      <AppText variant="body" numberOfLines={1} style={styles.title}>
        {current.title}
      </AppText>
      <Pressable accessibilityRole="button" accessibilityLabel={isPlaying ? '一時停止' : '再生'} onPress={togglePlay} hitSlop={6} style={styles.button}>
        <SymbolView name={isPlaying ? 'pause.fill' : 'play.fill'} tintColor={colors.text} size={20} />
      </Pressable>
      {/* 一時停止中は「次へ」の代わりに閉じるボタンを出し、表示ごと消せるようにする */}
      {!isPlaying ? (
        <Pressable accessibilityRole="button" accessibilityLabel="再生を終了" onPress={stop} hitSlop={6} style={styles.button}>
          <SymbolView name="xmark" tintColor={colors.text} size={18} />
        </Pressable>
      ) : compact ? null : (
        <Pressable accessibilityRole="button" accessibilityLabel="次へ" onPress={next} hitSlop={6} style={styles.button}>
          <SymbolView name="forward.fill" tintColor={colors.text} size={20} />
        </Pressable>
      )}
      <View style={styles.progressTrack} pointerEvents="none">
        <View style={[styles.progressFill, { width: `${progress * 100}%` }]} />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingLeft: 8,
    paddingRight: 4,
    overflow: 'hidden',
  },
  compact: { minHeight: 36, paddingLeft: 4 },
  thumb: { width: 48, height: 32, borderRadius: radius.sm, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  thumbCompact: { width: 36, height: 24 },
  title: { flex: 1 },
  button: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  progressTrack: { position: 'absolute', left: 12, right: 12, bottom: 0, height: 2, backgroundColor: 'rgba(255,255,255,0.12)' },
  progressFill: { height: 2, backgroundColor: colors.accent },
});
