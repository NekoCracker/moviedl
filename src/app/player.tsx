import { router } from 'expo-router';
import { SymbolView, type SFSymbol } from 'expo-symbols';
import { VideoView } from 'expo-video';
import { useEffect } from 'react';
import { ActionSheetIOS, Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { VlcVideoView } from 'media-tools';

import { AdBanner } from '@/ads/banner';
import { AppText } from '@/components/app-text';
import { Scrubber } from '@/components/scrubber';
import { usePlayback, usePlaybackTime } from '@/player/playback';
import { loopLabels, nextLoopMode, playbackRates } from '@/player/queue';
import { colors, radius } from '@/theme';
import { formatBytes } from '@/utils/format';

const sleepOptions = [
  { label: 'オフ', minutes: 0 },
  { label: '15分', minutes: 15 },
  { label: '30分', minutes: 30 },
  { label: '60分', minutes: 60 },
  { label: 'この動画の終わりまで', minutes: -1 },
];

export default function PlayerScreen() {
  const insets = useSafeAreaInsets();
  const playback = usePlayback();
  const { player, queue, index, current, engine, duration, loop, shuffle, rate, sleepEndsAt, sleepAtEnd, isPlaying } = playback;
  const currentTime = usePlaybackTime();
  const { width, height } = useWindowDimensions();
  const landscape = width > height;

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
    : sleepAtEnd
      ? 'この動画まで'
      : 'オフ';
  const isAudio = current?.mediaType === 'audio';

  const openMenu = () => {
    const options = ['10秒戻る', '10秒進む', `スリープタイマー（${sleepEndLabel}）`, '再生を終了', 'キャンセル'];
    const info = [current?.container?.toUpperCase(), current?.sizeBytes ? formatBytes(current.sizeBytes) : null, queue.length > 1 ? `${index + 1} / ${queue.length}` : null]
      .filter(Boolean)
      .join('・');
    ActionSheetIOS.showActionSheetWithOptions(
      { title: current?.title ?? undefined, message: info || undefined, options, cancelButtonIndex: 4, destructiveButtonIndex: 3 },
      (i) => {
        if (i === 0) playback.seekBy(-10);
        else if (i === 1) playback.seekBy(10);
        else if (i === 2) chooseSleep();
        else if (i === 3) playback.stop();
      },
    );
  };

  // 全画面にはせず、動画・バナー広告・シークバー・操作ボタンを縦に並べる。横向きでも同じ順で、動画が上に来る
  return (
    <View style={[styles.screen, { paddingTop: insets.top, paddingBottom: Math.max(insets.bottom, 8) }]}>
      <View style={[styles.videoBox, landscape ? styles.videoBoxLandscape : null]}>
        {isAudio && engine !== 'none' ? (
          <View style={styles.audioArt}>
            <SymbolView name="music.note" tintColor={colors.textSecondary} size={64} />
          </View>
        ) : engine === 'native' ? (
          <VideoView player={player} style={styles.video} contentFit="contain" allowsPictureInPicture nativeControls={false} />
        ) : engine === 'vlc' ? (
          // WebM・MKV など。VLCKit が映像を描く（ピクチャ・イン・ピクチャは iOS 標準形式のみ）
          <VlcVideoView style={styles.video} />
        ) : (
          <AppText variant="caption" tone="secondary" style={styles.unsupported}>
            {current ? `${(current.container ?? '').toUpperCase()} 形式はこのバージョンでは再生できません` : ''}
          </AppText>
        )}
      </View>

      <AdBanner closable />

      <View style={styles.seekArea}>
        <Scrubber position={currentTime} duration={duration} onSeek={playback.seek} combinedTime />
      </View>

      <View style={styles.controls}>
        <IconButton icon="chevron.down" label="閉じる" onPress={() => router.back()} />
        <IconButton
          icon={loop === 'one' ? 'repeat.1' : 'repeat'}
          label={`ループ、${loopLabels[loop]}`}
          active={loop !== 'off'}
          onPress={() => playback.setLoop(nextLoopMode(loop))}
        />
        <Pressable accessibilityRole="button" accessibilityLabel={`再生速度、${rate}倍`} onPress={chooseRate} style={styles.iconButton}>
          <AppText variant="bodyBold" style={{ color: rate !== 1 ? colors.accent : colors.text }}>
            x{rate}
          </AppText>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={isPlaying ? '一時停止' : '再生'}
          onPress={playback.togglePlay}
          style={styles.playButton}>
          <SymbolView name={isPlaying ? 'pause.fill' : 'play.fill'} tintColor="#000" size={22} />
        </Pressable>
        <IconButton icon="backward.end.fill" label="前へ" onPress={playback.previous} />
        <IconButton icon="forward.end.fill" label="次へ" onPress={playback.next} />
        <IconButton icon="shuffle" label={`ランダム、${shuffle ? 'オン' : 'オフ'}`} active={shuffle} onPress={playback.toggleShuffle} />
        <IconButton icon="ellipsis" label="メニュー" active={sleepEndsAt != null || sleepAtEnd} onPress={openMenu} />
      </View>
    </View>
  );
}

function IconButton({ icon, label, onPress, active = false }: { icon: SFSymbol; label: string; onPress: () => void; active?: boolean }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={styles.iconButton}>
      <SymbolView name={icon} tintColor={active ? colors.accent : colors.text} size={20} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#000' },
  videoBox: { flex: 1, backgroundColor: '#000', alignItems: 'center', justifyContent: 'center' },
  // 横向きでは高さが足りないので、下の操作部分を残して動画を上いっぱいに
  videoBoxLandscape: { marginHorizontal: 48 },
  video: { width: '100%', height: '100%' },
  audioArt: { width: 160, height: 160, borderRadius: radius.xl, backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center' },
  unsupported: { padding: 24, textAlign: 'center' },
  seekArea: { paddingHorizontal: 16, paddingTop: 8 },
  controls: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 4, paddingTop: 4 },
  iconButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  playButton: { width: 48, height: 48, borderRadius: 24, backgroundColor: colors.text, alignItems: 'center', justifyContent: 'center' },
});
