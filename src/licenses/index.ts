import { bsd2Dav1d, lgpl2, lgpl21, mitExpo, mitReactNative, ofl } from './texts';

export type LicenseEntry = {
  name: string;
  license: string;
  // 何に使っているか
  usage: string;
  // ソースコードの入手先
  source: string;
  text: string;
};

// 設定 › ライセンス（feature-spec.md §2-12、§7）。LGPL のものはソースの入手先と、差し替え用のビルド手順の場所も載せる
export const licenses: LicenseEntry[] = [
  {
    name: 'VLCKit (MobileVLCKit 3.6)',
    license: 'GNU LGPL 2.1',
    usage: 'WebM・MKV などの再生',
    source: 'https://code.videolan.org/videolan/VLCKit',
    text: lgpl21,
  },
  {
    name: 'FFmpeg 7.1.1',
    license: 'GNU LGPL 2.1',
    usage: 'MP4・音声への変換、トリミング、サムネイル作成',
    source: 'https://ffmpeg.org/releases/ffmpeg-7.1.1.tar.xz\nビルド手順: https://github.com/NekoCracker/moviedl/tree/main/modules/media-tools/core',
    text: lgpl21,
  },
  {
    name: 'LAME 3.100',
    license: 'GNU LGPL 2',
    usage: 'mp3 の作成',
    source: 'https://downloads.sourceforge.net/project/lame/lame/3.100/lame-3.100.tar.gz',
    text: lgpl2,
  },
  {
    name: 'dav1d 1.5.1',
    license: 'BSD 2-Clause',
    usage: 'AV1 の読み込み',
    source: 'https://code.videolan.org/videolan/dav1d',
    text: bsd2Dav1d,
  },
  {
    name: 'Zen Kaku Gothic New',
    license: 'SIL Open Font License 1.1',
    usage: 'フォント',
    source: 'https://github.com/googlefonts/zen-kakugothic',
    text: ofl,
  },
  {
    name: 'React Native',
    license: 'MIT',
    usage: 'アプリの土台',
    source: 'https://github.com/facebook/react-native',
    text: mitReactNative,
  },
  {
    name: 'Expo とその関連モジュール',
    license: 'MIT',
    usage: 'アプリの土台',
    source: 'https://github.com/expo/expo',
    text: mitExpo,
  },
];
