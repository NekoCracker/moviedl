import type { VideoPlayer } from 'expo-video';

// expo-video の VideoPlayer はネイティブ側の可変オブジェクト。
// React Compiler の不変性チェックに引っかからないよう、プロパティの書き換えはここに集める。

export function setPlaybackRate(player: VideoPlayer, rate: number) {
  player.playbackRate = rate;
}

export function seekTo(player: VideoPlayer, seconds: number) {
  player.currentTime = seconds;
}
