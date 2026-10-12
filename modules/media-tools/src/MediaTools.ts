import { NativeModule, requireOptionalNativeModule } from 'expo';

export type ProbeResult = {
  durationSec: number;
  hasVideo: boolean;
  hasAudio: boolean;
  width: number;
  height: number;
  videoCodec: string;
  audioCodec: string;
  container: string;
};

export type ConvertMode = 'mp4' | 'm4a' | 'mp3';

export type ConvertOptions = {
  input: string;
  output: string;
  mode: ConvertMode;
  // 切り出す範囲（秒）。指定すると再エンコードになる
  startSec?: number;
  endSec?: number;
  forceEncode?: boolean;
  videoBitrate?: number;
  audioBitrate?: number;
  maxHeight?: number;
  // iOS 26 のバックグラウンド処理の表示に使う
  title?: string;
};

type Events = {
  onConvertProgress: (event: { jobId: string; fraction: number }) => void;
};

declare class MediaToolsNative extends NativeModule<Events> {
  probe(uri: string): Promise<ProbeResult>;
  convert(jobId: string, options: ConvertOptions): Promise<'done' | 'cancelled'>;
  thumbnail(uri: string, timeSec: number, maxWidth: number, output: string): Promise<void>;
  concat(jobId: string, inputs: string[], output: string): Promise<'done' | 'cancelled'>;
  cancel(jobId: string): void;
  supportsContinuedProcessing(): boolean;
  excludeFromBackup(uri: string): void;
  clearWebsiteData(types: ('cache' | 'cookies')[], sinceMs: number | null): Promise<void>;
  websiteDataSize(): Promise<number>;
}

// 開発ビルドより前の環境（Expo Go など）では null
export const MediaTools = requireOptionalNativeModule<MediaToolsNative>('MediaTools');

export function mediaToolsAvailable(): boolean {
  return MediaTools != null;
}
