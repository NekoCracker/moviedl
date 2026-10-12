// アプリ全体で1つの再生プレイヤー。プレイヤー画面を閉じてもミニプレイヤーで再生を続ける（feature-spec.md §2-4）
import { useEvent, useEventListener } from 'expo';
import { useSQLiteContext } from 'expo-sqlite';
import { useVideoPlayer, type VideoPlayer } from 'expo-video';
import { createContext, use, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { listMedia, saveMediaDuration, savePlaybackPosition, type MediaItem, type MediaType, type SortDir, type SortKey } from '@/db/library';
import { loadSettings, saveSetting } from '@/db/settings';
import { mediaFile } from '@/download/storage';
import { NATIVE_CONTAINERS } from '@/library/media-actions';
import { seekTo, setBackgroundPlayback, setPlaybackRate } from '@/player/controls';
import { indexAfterEnd, indexForNext, indexForPrevious, shuffledOrder, type LoopMode } from '@/player/queue';

export type QueueRequest = {
  folderId: number;
  type: MediaType;
  sort: { key: SortKey; dir: SortDir };
  startId?: number;
  shuffle?: boolean;
};

type PlaybackState = {
  player: VideoPlayer;
  queue: MediaItem[];
  index: number;
  current: MediaItem | null;
  playable: boolean;
  loop: LoopMode;
  shuffle: boolean;
  rate: number;
  sleepEndsAt: number | null;
  isPlaying: boolean;
  start: (request: QueueRequest) => Promise<void>;
  goTo: (index: number) => void;
  next: () => void;
  previous: () => void;
  togglePlay: () => void;
  toggleShuffle: () => void;
  setLoop: (loop: LoopMode) => void;
  setRate: (rate: number) => void;
  setSleepMinutes: (minutes: number) => void;
  stop: () => void;
  // タイトル変更や削除のあとにキューの情報を読み直す
  refresh: () => Promise<void>;
};

const PlaybackContext = createContext<PlaybackState | null>(null);

export function usePlayback(): PlaybackState {
  const value = use(PlaybackContext);
  if (!value) throw new Error('PlaybackProvider がありません');
  return value;
}

export function isNativePlayable(item: MediaItem | null): boolean {
  return item ? NATIVE_CONTAINERS.includes((item.container ?? '').toLowerCase()) : false;
}

export function PlaybackProvider({ children }: { children: ReactNode }) {
  const db = useSQLiteContext();
  const [queue, setQueue] = useState<MediaItem[]>([]);
  const [index, setIndex] = useState(0);
  const [loop, setLoop] = useState<LoopMode>('off');
  const [shuffle, setShuffle] = useState(false);
  const [rate, setRateState] = useState(1);
  const [sleepEndsAt, setSleepEndsAt] = useState<number | null>(null);
  const originalOrder = useRef<MediaItem[]>([]);
  const lastRequest = useRef<QueueRequest | null>(null);
  const rememberRate = useRef(true);

  const current = queue[index] ?? null;
  const playable = isNativePlayable(current);
  const source = useMemo(
    () => (current && playable ? { uri: mediaFile(current.filePath).uri, metadata: { title: current.title } } : null),
    [current, playable],
  );

  const player = useVideoPlayer(null, (p) => {
    p.staysActiveInBackground = true;
    p.showNowPlayingNotification = true;
    p.timeUpdateEventInterval = 1;
  });

  // 設定（バックグラウンド再生・速度の記憶）を反映する
  useEffect(() => {
    loadSettings(db).then((s) => {
      rememberRate.current = s.rememberPlaybackRate;
      setBackgroundPlayback(player, s.backgroundVideoAudio);
      if (s.rememberPlaybackRate) setRateState(s.lastPlaybackRate);
    });
  }, [db, player]);

  const start = useCallback(
    async (request: QueueRequest) => {
      const settings = await loadSettings(db);
      rememberRate.current = settings.rememberPlaybackRate;
      setBackgroundPlayback(player, settings.backgroundVideoAudio);
      lastRequest.current = request;
      const items = await listMedia(db, request.folderId, request.type, request.sort);
      originalOrder.current = items;
      const found = items.findIndex((m) => m.id === request.startId);
      if (request.shuffle) {
        const first = found >= 0 ? found : Math.floor(Math.random() * Math.max(1, items.length));
        setQueue(shuffledOrder(items, first));
        setIndex(0);
      } else {
        setQueue(items);
        setIndex(Math.max(0, found));
      }
      setShuffle(!!request.shuffle);
    },
    [db, player],
  );

  // 曲が切り替わったら読み込み、前回の位置から再開する
  useEffect(() => {
    if (!source || !current) {
      player.pause();
      return;
    }
    let cancelled = false;
    player.replaceAsync(source).then(() => {
      if (cancelled) return;
      const resumeAt = current.durationSec && current.lastPositionSec < current.durationSec - 5 ? current.lastPositionSec : 0;
      seekTo(player, resumeAt);
      player.play();
    });
    return () => {
      cancelled = true;
    };
    // current の中身（再生位置など）が更新されても読み込み直さない
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [player, source, current?.id]);

  useEffect(() => {
    setPlaybackRate(player, rate);
  }, [player, rate]);

  const { isPlaying } = useEvent(player, 'playingChange', { isPlaying: player.playing });

  // 5秒ごとに再生位置を保存する
  const lastSaved = useRef(0);
  useEventListener(player, 'timeUpdate', ({ currentTime }) => {
    if (!current) return;
    if (Math.abs(currentTime - lastSaved.current) >= 5) {
      lastSaved.current = currentTime;
      savePlaybackPosition(db, current.id, currentTime);
    }
  });

  // 取り込んだファイルなど、長さが分からないものは読み込み時に記録する
  useEventListener(player, 'sourceLoad', ({ duration }) => {
    if (current && current.durationSec == null && duration > 0) {
      saveMediaDuration(db, current.id, duration);
      setQueue((q) => q.map((m) => (m.id === current.id ? { ...m, durationSec: duration } : m)));
    }
  });

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
    if (sleepEndsAt == null) return;
    const timer = setTimeout(() => {
      player.pause();
      setSleepEndsAt(null);
    }, Math.max(0, sleepEndsAt - Date.now()));
    return () => clearTimeout(timer);
  }, [player, sleepEndsAt]);

  const toggleShuffle = useCallback(() => {
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
  }, [current, shuffle, queue, index]);

  const setRate = useCallback(
    (next: number) => {
      setRateState(next);
      if (rememberRate.current) saveSetting(db, 'lastPlaybackRate', next);
    },
    [db],
  );

  const stop = useCallback(() => {
    if (current) savePlaybackPosition(db, current.id, player.currentTime);
    player.pause();
    setQueue([]);
    setIndex(0);
    setSleepEndsAt(null);
    lastRequest.current = null;
  }, [db, current, player]);

  const refresh = useCallback(async () => {
    const request = lastRequest.current;
    if (!request || !current) return;
    const items = await listMedia(db, request.folderId, request.type, request.sort);
    const byId = new Map(items.map((m) => [m.id, m]));
    originalOrder.current = items;
    // 削除されたものはキューから外し、残りは新しい情報に置き換える
    const nextQueue = queue.flatMap((m) => {
      const fresh = byId.get(m.id);
      return fresh ? [fresh] : [];
    });
    if (nextQueue.length === 0) {
      stop();
      return;
    }
    const stillCurrent = nextQueue.findIndex((m) => m.id === current.id);
    setQueue(nextQueue);
    setIndex(stillCurrent >= 0 ? stillCurrent : Math.min(index, nextQueue.length - 1));
  }, [db, current, queue, index, stop]);

  const value: PlaybackState = {
    player,
    queue,
    index,
    current,
    playable,
    loop,
    shuffle,
    rate,
    sleepEndsAt,
    isPlaying,
    start,
    goTo,
    next: () => goTo(indexForNext(index, queue.length)),
    previous: () => goTo(indexForPrevious(index, queue.length, player.currentTime)),
    togglePlay: () => (isPlaying ? player.pause() : player.play()),
    toggleShuffle,
    setLoop,
    setRate,
    setSleepMinutes: (minutes) => setSleepEndsAt(minutes > 0 ? Date.now() + minutes * 60 * 1000 : null),
    stop,
    refresh,
  };

  return <PlaybackContext value={value}>{children}</PlaybackContext>;
}

// 再生位置（1秒ごとに変わる）は、使う画面だけが購読する
export function usePlaybackTime(player: VideoPlayer) {
  const { currentTime } = useEvent(player, 'timeUpdate', {
    currentTime: player.currentTime,
    currentLiveTimestamp: null,
    currentOffsetFromLive: null,
    bufferedPosition: 0,
  });
  return currentTime;
}
