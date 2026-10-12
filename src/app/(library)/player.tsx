import { useEvent, useEventListener } from 'expo';
import { router, useLocalSearchParams } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { SymbolView, type SFSymbol } from 'expo-symbols';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActionSheetIOS, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppText } from '@/components/app-text';
import { listMedia, savePlaybackPosition, type MediaItem, type MediaType, type SortDir, type SortKey } from '@/db/library';
import { mediaFile } from '@/download/storage';
import { seekTo, setPlaybackRate } from '@/player/controls';
import {
  indexAfterEnd,
  indexForNext,
  indexForPrevious,
  loopLabels,
  nextLoopMode,
  playbackRates,
  shuffledOrder,
  type LoopMode,
} from '@/player/queue';
import { colors, radius } from '@/theme';
import { formatBytes, formatDuration } from '@/utils/format';

// iOS 標準プレイヤーで再生できる形式。それ以外は VLCKit 組み込み後に対応（feature-spec.md §2-12）
const NATIVE_CONTAINERS = new Set(['mp4', 'm4v', 'mov', 'm4a', 'mp3']);

const sleepOptions = [
  { label: 'オフ', minutes: 0 },
  { label: '15分', minutes: 15 },
  { label: '30分', minutes: 30 },
  { label: '60分', minutes: 60 },
];

export default function PlayerScreen() {
  const db = useSQLiteContext();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{
    folderId: string;
    type?: MediaType;
    startId?: string;
    sortKey?: SortKey;
    sortDir?: SortDir;
    shuffle?: string;
  }>();

  const [queue, setQueue] = useState<MediaItem[]>([]);
  const [index, setIndex] = useState(0);
  const [loop, setLoop] = useState<LoopMode>('off');
  const [shuffle, setShuffle] = useState(params.shuffle === '1');
  const [rate, setRate] = useState(1);
  const [sleepMinutes, setSleepMinutes] = useState(0);
  const originalOrder = useRef<MediaItem[]>([]);

  const current = queue[index] ?? null;
  const playable = current ? NATIVE_CONTAINERS.has((current.container ?? '').toLowerCase()) : false;
  const source = useMemo(() => (current && playable ? { uri: mediaFile(current.filePath).uri, metadata: { title: current.title } } : null), [current, playable]);

  const player = useVideoPlayer(null, (p) => {
    p.staysActiveInBackground = true;
    p.showNowPlayingNotification = true;
    p.timeUpdateEventInterval = 1;
  });

  // キューを読み込む
  useEffect(() => {
    (async () => {
      const items = await listMedia(
        db,
        Number(params.folderId),
        params.type === 'audio' ? 'audio' : 'video',
        { key: params.sortKey ?? 'created_at', dir: params.sortDir ?? 'desc' },
      );
      originalOrder.current = items;
      const start = Math.max(0, items.findIndex((m) => String(m.id) === params.startId));
      if (params.shuffle === '1') {
        setQueue(shuffledOrder(items, params.startId ? start : Math.floor(Math.random() * Math.max(1, items.length))));
        setIndex(0);
      } else {
        setQueue(items);
        setIndex(start);
      }
    })();
  }, [db, params.folderId, params.type, params.startId, params.sortKey, params.sortDir, params.shuffle]);

  // 動画が切り替わったら読み込み、前回の位置から再開する
  useEffect(() => {
    if (!source || !current) {
      player.pause();
      return;
    }
    player.replaceAsync(source).then(() => {
      const resumeAt = current.durationSec && current.lastPositionSec < current.durationSec - 5 ? current.lastPositionSec : 0;
      seekTo(player, resumeAt);
      setPlaybackRate(player, rate);
      player.play();
    });
    // rate は別の effect で反映する
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [player, source, current?.id]);

  useEffect(() => {
    setPlaybackRate(player, rate);
  }, [player, rate]);

  const { isPlaying } = useEvent(player, 'playingChange', { isPlaying: player.playing });
  const { currentTime } = useEvent(player, 'timeUpdate', {
    currentTime: 0,
    currentLiveTimestamp: null,
    currentOffsetFromLive: null,
    bufferedPosition: 0,
  });

  // 5秒ごとと、切り替え時に再生位置を保存する
  const lastSaved = useRef(0);
  useEffect(() => {
    if (!current) return;
    if (Math.abs(currentTime - lastSaved.current) >= 5) {
      lastSaved.current = currentTime;
      savePlaybackPosition(db, current.id, currentTime);
    }
  }, [db, current, currentTime]);

  const goTo = useCallback(
    (nextIndex: number) => {
      if (current) savePlaybackPosition(db, current.id, player.currentTime);
      lastSaved.current = 0;
      if (nextIndex === index) {
        seekTo(player, 0);
        player.play();
      } else {
        setIndex(nextIndex);
      }
    },
    [db, current, index, player],
  );

  useEventListener(player, 'playToEnd', () => {
    if (current) savePlaybackPosition(db, current.id, 0);
    const next = indexAfterEnd(index, queue.length, loop);
    if (next !== null) goTo(next);
  });

  // スリープタイマー
  useEffect(() => {
    if (sleepMinutes === 0) return;
    const timer = setTimeout(() => {
      player.pause();
      setSleepMinutes(0);
    }, sleepMinutes * 60 * 1000);
    return () => clearTimeout(timer);
  }, [player, sleepMinutes]);

  const toggleShuffle = () => {
    if (!current) return;
    if (shuffle) {
      const restored = originalOrder.current;
      setQueue(restored);
      setIndex(Math.max(0, restored.findIndex((m) => m.id === current.id)));
    } else {
      setQueue(shuffledOrder(queue, index));
      setIndex(0);
    }
    setShuffle(!shuffle);
  };

  const chooseRate = () => {
    ActionSheetIOS.showActionSheetWithOptions(
      { title: '再生速度', options: [...playbackRates.map((r) => `${r}x`), 'キャンセル'], cancelButtonIndex: playbackRates.length },
      (i) => {
        if (i < playbackRates.length) setRate(playbackRates[i]);
      },
    );
  };

  const chooseSleep = () => {
    ActionSheetIOS.showActionSheetWithOptions(
      { title: 'スリープタイマー', options: [...sleepOptions.map((o) => o.label), 'キャンセル'], cancelButtonIndex: sleepOptions.length },
      (i) => {
        if (i < sleepOptions.length) setSleepMinutes(sleepOptions[i].minutes);
      },
    );
  };

  const duration = current?.durationSec ?? player.duration;
  const progress = duration > 0 ? Math.min(1, currentTime / duration) : 0;
  const upNext = queue[indexForNext(index, queue.length)];

  return (
    <View style={[styles.screen, { paddingTop: insets.top + 4 }]}>
      <View style={styles.topBar}>
        <IconButton icon="chevron.down" label="閉じる" onPress={() => router.back()} />
        <AppText variant="caption" tone="secondary">
          {queue.length > 0 ? `${index + 1} / ${queue.length}` : ''}
        </AppText>
        <View style={styles.iconButton} />
      </View>

      <View style={styles.videoBox}>
        {playable ? (
          <VideoView player={player} style={styles.video} contentFit="contain" allowsPictureInPicture nativeControls={false} />
        ) : (
          <AppText variant="caption" tone="secondary" style={styles.unsupported}>
            {current ? `${(current.container ?? '').toUpperCase()} 形式の再生は次の更新で対応します` : ''}
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
        <View style={styles.track}>
          <View style={[styles.trackFill, { width: `${progress * 100}%` }]} />
        </View>
        <View style={styles.times}>
          <AppText variant="small" tone="secondary">
            {formatDuration(currentTime)}
          </AppText>
          <AppText variant="small" tone="secondary">
            -{formatDuration(Math.max(0, duration - currentTime))}
          </AppText>
        </View>
      </View>

      <View style={styles.transport}>
        <IconButton icon="backward.end.fill" label="前へ" size={26} onPress={() => goTo(indexForPrevious(index, queue.length, player.currentTime))} />
        <IconButton icon="gobackward.10" label="10秒戻る" size={24} onPress={() => player.seekBy(-10)} />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={isPlaying ? '一時停止' : '再生'}
          onPress={() => (isPlaying ? player.pause() : player.play())}
          style={styles.playButton}>
          <SymbolView name={isPlaying ? 'pause.fill' : 'play.fill'} tintColor="#000" size={30} />
        </Pressable>
        <IconButton icon="goforward.10" label="10秒進む" size={24} onPress={() => player.seekBy(10)} />
        <IconButton icon="forward.end.fill" label="次へ" size={26} onPress={() => goTo(indexForNext(index, queue.length))} />
      </View>

      <View style={styles.tools}>
        <ToolTile label="速度" value={`${rate}x`} active={rate !== 1} onPress={chooseRate} />
        <ToolTile label="ループ" value={loopLabels[loop]} active={loop !== 'off'} onPress={() => setLoop(nextLoopMode(loop))} />
        <ToolTile label="ランダム" value={shuffle ? 'オン' : 'オフ'} active={shuffle} onPress={toggleShuffle} />
        <ToolTile label="タイマー" value={sleepMinutes ? `${sleepMinutes}分` : 'オフ'} active={sleepMinutes > 0} onPress={chooseSleep} />
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
  unsupported: { padding: 24, textAlign: 'center' },
  info: { paddingHorizontal: 24, paddingTop: 20, gap: 4 },
  seekArea: { paddingHorizontal: 24, paddingTop: 24 },
  track: { height: 4, borderRadius: 2, backgroundColor: '#33363D', overflow: 'hidden' },
  trackFill: { height: 4, backgroundColor: colors.accent },
  times: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 10 },
  transport: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 24, paddingTop: 20 },
  playButton: { width: 76, height: 76, borderRadius: 38, backgroundColor: colors.text, alignItems: 'center', justifyContent: 'center' },
  tools: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingTop: 28 },
  tool: { flex: 1, height: 64, borderRadius: radius.lg, alignItems: 'center', justifyContent: 'center', gap: 4 },
  upNext: { paddingHorizontal: 24, paddingTop: 28, gap: 4 },
});
