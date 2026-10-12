// アプリ全体で1つの再生プレイヤー。プレイヤー画面を閉じてもミニプレイヤーで再生を続ける（feature-spec.md §2-4）
import { useEvent, useEventListener } from 'expo';
import { useSQLiteContext } from 'expo-sqlite';
import { useVideoPlayer, type VideoPlayer } from 'expo-video';
import { VlcPlayer } from 'media-tools';
import { createContext, use, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { AppState } from 'react-native';

import { listMedia, saveMediaDuration, savePlaybackPosition, type MediaItem, type MediaType, type SortDir, type SortKey } from '@/db/library';
import { loadSettings, saveSetting } from '@/db/settings';
import { mediaFile } from '@/download/storage';
import { NATIVE_CONTAINERS } from '@/library/media-actions';
import { seekTo, setBackgroundPlayback, setPlaybackRate } from '@/player/controls';
import { indexAfterEnd, indexForNext, indexForPrevious, shuffledOrder, type LoopMode } from '@/player/queue';
import { getVlcTime, setVlcTime, subscribeVlcTime, vlcBorrowed, vlcGeneration } from '@/player/vlc-time';

// native: expo-video（MP4・MOV・M4A・MP3）／ vlc: VLCKit（WebM・MKV など）／ none: 再生できない（VLC が無い開発環境など）
export type PlaybackEngine = 'native' | 'vlc' | 'none';

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
  engine: PlaybackEngine;
  duration: number;
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
  pause: () => void;
  seek: (seconds: number) => void;
  seekBy: (deltaSec: number) => void;
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
  const [vlcPlaying, setVlcPlaying] = useState(false);
  // どの動画の長さかも持っておき、切り替え直後に前の動画の長さを使わないようにする
  const [vlcDuration, setVlcDuration] = useState({ id: 0, sec: 0 });
  const originalOrder = useRef<MediaItem[]>([]);
  const lastRequest = useRef<QueueRequest | null>(null);
  const rememberRate = useRef(true);
  const backgroundVideo = useRef(true);
  // VLC に今の動画を読み込んだときの世代（編集画面が VLC を借りると変わる）
  const vlcLoadedGeneration = useRef(-1);

  const current = queue[index] ?? null;
  const playable = isNativePlayable(current);
  const engine: PlaybackEngine = !current ? 'none' : playable ? 'native' : VlcPlayer ? 'vlc' : 'none';
  const source = useMemo(
    () => (current && playable ? { uri: mediaFile(current.filePath).uri, metadata: { title: current.title } } : null),
    [current, playable],
  );

  const player = useVideoPlayer(null, (p) => {
    p.staysActiveInBackground = true;
    p.showNowPlayingNotification = true;
    p.timeUpdateEventInterval = 1;
  });

  // 音声ファイルは設定に関係なくバックグラウンドで再生を続ける
  const isAudio = current?.mediaType === 'audio';
  const applyBackground = useCallback(
    (enabled: boolean) => {
      backgroundVideo.current = enabled;
      setBackgroundPlayback(player, enabled || isAudio);
    },
    [player, isAudio],
  );

  // 設定（バックグラウンド再生・速度の記憶）を反映する
  useEffect(() => {
    loadSettings(db).then((s) => {
      rememberRate.current = s.rememberPlaybackRate;
      applyBackground(s.backgroundVideoAudio);
      if (s.rememberPlaybackRate) setRateState(s.lastPlaybackRate);
    });
  }, [db, applyBackground]);

  const start = useCallback(
    async (request: QueueRequest) => {
      const settings = await loadSettings(db);
      rememberRate.current = settings.rememberPlaybackRate;
      applyBackground(settings.backgroundVideoAudio);
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
    [db, applyBackground],
  );

  // 曲が切り替わったら読み込み、前回の位置から再開する
  useEffect(() => {
    if (!current || engine === 'none') {
      player.pause();
      VlcPlayer?.stop();
      return;
    }
    const resumeAt = current.durationSec && current.lastPositionSec < current.durationSec - 5 ? current.lastPositionSec : 0;
    if (engine === 'vlc') {
      player.pause();
      setVlcTime(resumeAt);
      vlcLoadedGeneration.current = vlcGeneration();
      VlcPlayer?.load(mediaFile(current.filePath).uri, current.title, resumeAt, true);
      return;
    }
    VlcPlayer?.stop();
    let cancelled = false;
    if (source) {
      player.replaceAsync(source).then(() => {
        if (cancelled) return;
        seekTo(player, resumeAt);
        player.play();
      });
    }
    return () => {
      cancelled = true;
    };
    // current の中身（再生位置など）が更新されても読み込み直さない
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [player, source, engine, current?.id]);

  useEffect(() => {
    setPlaybackRate(player, rate);
    VlcPlayer?.setRate(rate);
  }, [player, rate]);

  const { isPlaying: nativePlaying } = useEvent(player, 'playingChange', { isPlaying: player.playing });
  const isPlaying = engine === 'vlc' ? vlcPlaying : engine === 'native' ? nativePlaying : false;

  const getTime = useCallback(() => (engine === 'vlc' ? getVlcTime() : player.currentTime), [engine, player]);

  const play = useCallback(() => {
    if (engine === 'vlc') {
      if (current && vlcLoadedGeneration.current !== vlcGeneration()) {
        // 編集画面のプレビューに使われていたので、止めた位置から読み込み直す
        vlcLoadedGeneration.current = vlcGeneration();
        VlcPlayer?.load(mediaFile(current.filePath).uri, current.title, getVlcTime(), true);
      } else {
        VlcPlayer?.play();
      }
    } else if (engine === 'native') {
      player.play();
    }
  }, [engine, player, current]);

  const pause = useCallback(() => {
    player.pause();
    VlcPlayer?.pause();
  }, [player]);

  const seek = useCallback(
    (seconds: number) => {
      if (engine === 'vlc') {
        setVlcTime(seconds);
        VlcPlayer?.seek(seconds);
      } else {
        seekTo(player, seconds);
      }
    },
    [engine, player],
  );

  // 5秒ごとに再生位置を保存する
  const lastSaved = useRef(0);
  const onTime = (currentTime: number) => {
    if (!current) return;
    if (Math.abs(currentTime - lastSaved.current) >= 5) {
      lastSaved.current = currentTime;
      savePlaybackPosition(db, current.id, currentTime);
    }
  };
  useEventListener(player, 'timeUpdate', ({ currentTime }) => onTime(currentTime));

  // 取り込んだファイルなど、長さが分からないものは読み込み時に記録する
  const onDuration = (duration: number) => {
    if (current && engine === 'vlc' && duration > 0 && (vlcDuration.id !== current.id || vlcDuration.sec !== duration)) {
      setVlcDuration({ id: current.id, sec: duration });
    }
    if (current && current.durationSec == null && duration > 0) {
      saveMediaDuration(db, current.id, duration);
      setQueue((q) => q.map((m) => (m.id === current.id ? { ...m, durationSec: duration } : m)));
    }
  };
  useEventListener(player, 'sourceLoad', ({ duration }) => onDuration(duration));

  const goTo = useCallback(
    (nextIndex: number) => {
      if (current) savePlaybackPosition(db, current.id, getTime());
      lastSaved.current = 0;
      if (nextIndex === index) {
        seek(0);
        play();
      } else {
        setIndex(nextIndex);
      }
    },
    [db, current, index, getTime, seek, play],
  );

  const onEnd = () => {
    if (current) savePlaybackPosition(db, current.id, 0);
    const next = indexAfterEnd(index, queue.length, loop);
    if (next !== null) goTo(next);
  };
  useEventListener(player, 'playToEnd', onEnd);

  const next = () => goTo(indexForNext(index, queue.length));
  const previous = () => goTo(indexForPrevious(index, queue.length, getTime()));

  // VLC のイベント。ハンドラが毎回変わるので最新のものを ref から呼ぶ
  const vlcHandlers = useRef({ onTime, onDuration, onEnd, next, previous });
  useEffect(() => {
    vlcHandlers.current = { onTime, onDuration, onEnd, next, previous };
  });
  useEffect(() => {
    if (!VlcPlayer) return;
    const subs = [
      VlcPlayer.addListener('onVlcPlayingChange', ({ isPlaying: playing }) => setVlcPlaying(playing && !vlcBorrowed())),
      VlcPlayer.addListener('onVlcLoad', ({ duration }) => {
        if (vlcBorrowed()) return;
        vlcHandlers.current.onDuration(duration);
      }),
      VlcPlayer.addListener('onVlcTimeUpdate', ({ currentTime, duration }) => {
        if (vlcBorrowed()) return;
        setVlcTime(currentTime);
        vlcHandlers.current.onDuration(duration);
        vlcHandlers.current.onTime(currentTime);
      }),
      VlcPlayer.addListener('onVlcEnd', () => {
        if (!vlcBorrowed()) vlcHandlers.current.onEnd();
      }),
      VlcPlayer.addListener('onVlcError', () => setVlcPlaying(false)),
      VlcPlayer.addListener('onVlcRemoteCommand', ({ command }) => {
        if (vlcBorrowed()) return;
        if (command === 'next') vlcHandlers.current.next();
        else vlcHandlers.current.previous();
      }),
    ];
    return () => subs.forEach((s) => s.remove());
  }, []);

  // VLC はバックグラウンドでも鳴り続けるので、動画のバックグラウンド再生がオフなら止める
  useEffect(() => {
    if (engine !== 'vlc' || isAudio) return;
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'background' && !backgroundVideo.current) VlcPlayer?.pause();
    });
    return () => sub.remove();
  }, [engine, isAudio]);

  // スリープタイマー
  useEffect(() => {
    if (sleepEndsAt == null) return;
    const timer = setTimeout(() => {
      pause();
      setSleepEndsAt(null);
    }, Math.max(0, sleepEndsAt - Date.now()));
    return () => clearTimeout(timer);
  }, [pause, sleepEndsAt]);

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
    (value: number) => {
      setRateState(value);
      if (rememberRate.current) saveSetting(db, 'lastPlaybackRate', value);
    },
    [db],
  );

  const stop = useCallback(() => {
    if (current) savePlaybackPosition(db, current.id, getTime());
    player.pause();
    VlcPlayer?.stop();
    setQueue([]);
    setIndex(0);
    setSleepEndsAt(null);
    lastRequest.current = null;
  }, [db, current, player, getTime]);

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

  const duration = current?.durationSec ?? (engine === 'vlc' ? (vlcDuration.id === current?.id ? vlcDuration.sec : 0) : player.duration);

  const value: PlaybackState = {
    player,
    queue,
    index,
    current,
    playable,
    engine,
    duration: duration > 0 ? duration : 0,
    loop,
    shuffle,
    rate,
    sleepEndsAt,
    isPlaying,
    start,
    goTo,
    next,
    previous,
    togglePlay: () => (isPlaying ? pause() : play()),
    pause,
    seek,
    seekBy: (delta) => seek(Math.max(0, getTime() + delta)),
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
export function usePlaybackTime() {
  const { player, engine } = usePlayback();
  const { currentTime } = useEvent(player, 'timeUpdate', {
    currentTime: player.currentTime,
    currentLiveTimestamp: null,
    currentOffsetFromLive: null,
    bufferedPosition: 0,
  });
  const vlcTime = useSyncExternalStore(subscribeVlcTime, getVlcTime);
  return engine === 'vlc' ? vlcTime : currentTime;
}
