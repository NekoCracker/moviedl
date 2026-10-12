import { router } from 'expo-router';
import { SymbolView, type SFSymbol } from 'expo-symbols';
import { VideoView } from 'expo-video';
import { useEffect } from 'react';
import { ActionSheetIOS, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppText } from '@/components/app-text';
import { Scrubber } from '@/components/scrubber';
import { seekTo } from '@/player/controls';
import { usePlayback, usePlaybackTime } from '@/player/playback';
import { indexForNext, loopLabels, nextLoopMode, playbackRates } from '@/player/queue';
import { colors, radius } from '@/theme';
import { formatBytes } from '@/utils/format';

const sleepOptions = [
  { label: 'オフ', minutes: 0 },
  { label: '15分', minutes: 15 },
  { label: '30分', minutes: 30 },
  { label: '60分', minutes: 60 },
];

export default function PlayerScreen() {
  const insets = useSafeAreaInsets();
  const playback = usePlayback();
  const { player, queue, index, current, playable, loop, shuffle, rate, sleepEndsAt, isPlaying } = playback;
  const currentTime = usePlaybackTime(player);

  // キューが空になったら（全部削除された等）閉じる
  useEffect(() => {
    if (queue.length === 0) router.back();
  }, [queue.length]);

  const chooseRate = () => {
    ActionSheetIOS.showActionSheetWithOptions(
      { title: '再生速度', options: [...playbackRates.map((r) => `${r}x`), 'キャンセル'], cancelButtonIndex: playbackRates.length },
      (i) => {
        if (i < playbackRates.length) playback.setRate(playbackRates[i]);
      },
    );
  };

  const chooseSleep = () => {
    ActionSheetIOS.showActionSheetWithOptions(
      { title: 'スリープタイマー', options: [...sleepOptions.map((o) => o.label), 'キャンセル'], cancelButtonIndex: sleepOptions.length },
      (i) => {
        if (i < sleepOptions.length) playback.setSleepMinutes(sleepOptions[i].minutes);
      },
    );
  };

  const sleepEndLabel = sleepEndsAt
    ? `〜${new Date(sleepEndsAt).getHours()}:${String(new Date(sleepEndsAt).getMinutes()).padStart(2, '0')}`
    : 'オフ';
  const duration = current?.durationSec ?? player.duration;
  const upNext = queue[indexForNext(index, queue.length)];
  const isAudio = current?.mediaType === 'audio';

  return (
    <View style={[styles.screen, { paddingTop: insets.top + 4 }]}>
      <View style={styles.topBar}>
        <IconButton icon="chevron.down" label="閉じる" onPress={() => router.back()} />
        <AppText variant="caption" tone="secondary">
          {queue.length > 0 ? `${index + 1} / ${queue.length}` : ''}
        </AppText>
        <IconButton
          icon="stop.fill"
          label="再生を終了"
          onPress={() => {
            playback.stop();
          }}
        />
      </View>

      <View style={styles.videoBox}>
        {playable && !isAudio ? (
          <VideoView player={player} style={styles.video} contentFit="contain" allowsPictureInPicture nativeControls={false} />
        ) : isAudio && playable ? (
          <View style={styles.audioArt}>
            <SymbolView name="music.note" tintColor={colors.textSecondary} size={64} />
          </View>
        ) : (
          // TODO: VLCKit のネイティブモジュールを組み込んだら、ここで WebM/MKV 等を再生する（feature-spec.md §2-12）
          <AppText variant="caption" tone="secondary" style={styles.unsupported}>
            {current ? `${(current.container ?? '').toUpperCase()} 形式の再生を準備しています` : ''}
          </AppText>
        )}
      </View>

      <View style={styles.info}>
        <AppText variant="title" numberOfLines={2}>
          {current?.title ?? ''}
        </AppText>
        <AppText variant="caption" tone="secondary">
          {[current?.container?.toUpperCase(), current?.sizeBytes ? formatBytes(current.sizeBytes) : null].filter(Boolean).join('・')}
        </AppText>
      </View>

      <View style={styles.seekArea}>
        <Scrubber position={currentTime} duration={duration} onSeek={(s) => seekTo(player, s)} />
      </View>

      <View style={styles.transport}>
        <IconButton icon="backward.end.fill" label="前へ" size={26} onPress={playback.previous} />
        <IconButton icon="gobackward.10" label="10秒戻る" size={24} onPress={() => player.seekBy(-10)} />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={isPlaying ? '一時停止' : '再生'}
          onPress={playback.togglePlay}
          style={styles.playButton}>
          <SymbolView name={isPlaying ? 'pause.fill' : 'play.fill'} tintColor="#000" size={30} />
        </Pressable>
        <IconButton icon="goforward.10" label="10秒進む" size={24} onPress={() => player.seekBy(10)} />
        <IconButton icon="forward.end.fill" label="次へ" size={26} onPress={playback.next} />
      </View>

      <View style={styles.tools}>
        <ToolTile label="速度" value={`${rate}x`} active={rate !== 1} onPress={chooseRate} />
        <ToolTile label="ループ" value={loopLabels[loop]} active={loop !== 'off'} onPress={() => playback.setLoop(nextLoopMode(loop))} />
        <ToolTile label="ランダム" value={shuffle ? 'オン' : 'オフ'} active={shuffle} onPress={playback.toggleShuffle} />
        <ToolTile label="タイマー" value={sleepEndLabel} active={sleepEndsAt != null} onPress={chooseSleep} />
      </View>

      {upNext && queue.length > 1 ? (
        <View style={styles.upNext}>
          <AppText variant="caption" tone="secondary">
            次に再生
          </AppText>
          <AppText variant="body" numberOfLines={1}>
            {upNext.title}
          </AppText>
        </View>
      ) : null}
    </View>
  );
}

function IconButton({ icon, label, onPress, size = 22 }: { icon: SFSymbol; label: string; onPress: () => void; size?: number }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={styles.iconButton}>
      <SymbolView name={icon} tintColor={colors.text} size={size} />
    </Pressable>
  );
}

function ToolTile({ label, value, active, onPress }: { label: string; value: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}、${value}`}
      onPress={onPress}
      style={[styles.tool, { backgroundColor: active ? colors.accentSoft : colors.surfaceMuted }]}>
      <AppText variant="bodyBold" style={{ color: active ? colors.accent : '#D5D7DC' }}>
        {value}
      </AppText>
      <AppText variant="small" style={{ color: active ? colors.accent : '#D5D7DC' }}>
        {label}
      </AppText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#000' },
  topBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 8 },
  iconButton: { width: 52, height: 52, alignItems: 'center', justifyContent: 'center' },
  videoBox: { height: 220, backgroundColor: '#111', marginTop: 8, alignItems: 'center', justifyContent: 'center' },
  video: { width: '100%', height: '100%' },
  audioArt: { width: 160, height: 160, borderRadius: radius.xl, backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center' },
  unsupported: { padding: 24, textAlign: 'center' },
  info: { paddingHorizontal: 24, paddingTop: 20, gap: 4 },
  seekArea: { paddingHorizontal: 24, paddingTop: 16 },
  transport: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 24, paddingTop: 16 },
  playButton: { width: 76, height: 76, borderRadius: 38, backgroundColor: colors.text, alignItems: 'center', justifyContent: 'center' },
  tools: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingTop: 28 },
  tool: { flex: 1, height: 64, borderRadius: radius.lg, alignItems: 'center', justifyContent: 'center', gap: 4 },
  upNext: { paddingHorizontal: 24, paddingTop: 28, gap: 4 },
});
