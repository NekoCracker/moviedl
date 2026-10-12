// 編集画面（トリミング・サムネイル選択）のプレビュー。
// MP4・MOV は専用の expo-video プレイヤー、WebM・MKV などは VLC を一時的に借りて映す
import { useEvent } from 'expo';
import { useVideoPlayer } from 'expo-video';
import { VlcPlayer } from 'media-tools';
import { useCallback, useEffect, useState } from 'react';

import type { MediaItem } from '@/db/library';
import { mediaFile } from '@/download/storage';
import { NATIVE_VIDEO_CONTAINERS } from '@/library/media-actions';
import { seekTo } from '@/player/controls';
import { borrowVlc } from '@/player/vlc-time';

export type PreviewKind = 'native' | 'vlc' | 'none';

export function previewKindOf(item: MediaItem | null): PreviewKind {
  if (!item) return 'none';
  if (NATIVE_VIDEO_CONTAINERS.includes(item.container ?? '')) return 'native';
  return VlcPlayer ? 'vlc' : 'none';
}

export function useEditPreview(item: MediaItem | null, pauseMain: () => void) {
  const kind = previewKindOf(item);
  const player = useVideoPlayer(null, (p) => {
    p.timeUpdateEventInterval = 0.25;
    p.loop = false;
  });
  const [vlc, setVlc] = useState({ time: 0, duration: 0, playing: false, ready: false });

  useEffect(() => {
    if (!item || kind !== 'native') return;
    // 編集中はメインの再生を止める
    pauseMain();
    player.replaceAsync({ uri: mediaFile(item.filePath).uri });
    // pauseMain は再生エンジンが変わったときだけ作り直される
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item, kind, player]);

  useEffect(() => {
    const vlcPlayer = VlcPlayer;
    if (!item || kind !== 'vlc' || !vlcPlayer) return;
    pauseMain();
    const release = borrowVlc();
    // 最初の1コマを映すために一度再生し、すぐ止める
    let showingFirstFrame = true;
    const subs = [
      vlcPlayer.addListener('onVlcPlayingChange', ({ isPlaying }) => {
        if (isPlaying && showingFirstFrame) {
          showingFirstFrame = false;
          vlcPlayer.pause();
        }
        setVlc((v) => ({ ...v, playing: isPlaying, ready: true }));
      }),
      vlcPlayer.addListener('onVlcLoad', ({ duration }) => setVlc((v) => ({ ...v, duration }))),
      vlcPlayer.addListener('onVlcTimeUpdate', ({ currentTime, duration }) =>
        setVlc((v) => ({ ...v, time: currentTime, duration: duration > 0 ? duration : v.duration })),
      ),
      vlcPlayer.addListener('onVlcEnd', () => setVlc((v) => ({ ...v, playing: false }))),
    ];
    vlcPlayer.load(mediaFile(item.filePath).uri, item.title, 0, true);
    return () => {
      subs.forEach((s) => s.remove());
      vlcPlayer.stop();
      release();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item, kind]);

  const { status } = useEvent(player, 'statusChange', { status: player.status });
  const { isPlaying: nativePlaying } = useEvent(player, 'playingChange', { isPlaying: player.playing });
  const { currentTime: nativeTime } = useEvent(player, 'timeUpdate', {
    currentTime: 0,
    currentLiveTimestamp: null,
    currentOffsetFromLive: null,
    bufferedPosition: 0,
  });

  const play = useCallback(() => {
    if (kind === 'native') player.play();
    else if (kind === 'vlc') VlcPlayer?.play();
  }, [kind, player]);

  const pause = useCallback(() => {
    if (kind === 'native') player.pause();
    else if (kind === 'vlc') VlcPlayer?.pause();
  }, [kind, player]);

  const seek = useCallback(
    (seconds: number) => {
      if (kind === 'native') {
        seekTo(player, seconds);
      } else if (kind === 'vlc') {
        setVlc((v) => ({ ...v, time: seconds }));
        VlcPlayer?.seek(seconds);
      }
    },
    [kind, player],
  );

  const getTime = useCallback(() => (kind === 'native' ? player.currentTime : kind === 'vlc' ? vlc.time : 0), [kind, player, vlc.time]);

  const fallbackDuration = kind === 'native' ? player.duration : vlc.duration;
  const duration = item?.durationSec ?? (fallbackDuration > 0 ? fallbackDuration : 0);

  return {
    kind,
    player,
    loading: kind === 'native' ? status === 'loading' : kind === 'vlc' ? !vlc.ready : false,
    isPlaying: kind === 'native' ? nativePlaying : vlc.playing,
    currentTime: kind === 'native' ? nativeTime : vlc.time,
    duration,
    play,
    pause,
    seek,
    getTime,
  };
}
