import { NativeModule, requireNativeView, requireOptionalNativeModule } from 'expo';
import type { ViewProps } from 'react-native';

type Events = {
  onVlcPlayingChange: (event: { isPlaying: boolean }) => void;
  onVlcLoad: (event: { duration: number }) => void;
  onVlcTimeUpdate: (event: { currentTime: number; duration: number }) => void;
  onVlcEnd: () => void;
  onVlcError: (event: { message: string }) => void;
  onVlcRemoteCommand: (event: { command: 'next' | 'previous' }) => void;
};

declare class VlcPlayerNative extends NativeModule<Events> {
  // artworkUri: ロック画面に出す画像（file://）。無ければ null
  load(uri: string, title: string, artworkUri: string | null, startSec: number, autoplay: boolean): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  stop(): Promise<void>;
  seek(seconds: number): Promise<void>;
  setRate(rate: number): Promise<void>;
  getStatus(): Promise<{ currentTime: number; duration: number; isPlaying: boolean }>;
}

// iOS 標準で再生できない形式（WebM・MKV など）用の再生エンジン。開発ビルドより前の環境では null
export const VlcPlayer = requireOptionalNativeModule<VlcPlayerNative>('VlcPlayer');

const NativeVlcVideoView = VlcPlayer ? requireNativeView<ViewProps>('VlcPlayer', 'VlcVideoView') : null;

// 置いてある間だけ VLC の映像を映す（外しても音声は続く）
export function VlcVideoView(props: ViewProps) {
  return NativeVlcVideoView ? <NativeVlcVideoView {...props} /> : null;
}
