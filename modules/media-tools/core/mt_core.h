// 動画・音声の変換コア（FFmpeg の libav* を直接呼ぶ）。
// iOS 用には GitHub Actions でこのファイルと FFmpeg をまとめて MediaToolsCore.framework にビルドする。
// 公開するのはこのヘッダの関数だけ（FFmpeg のシンボルは外に出さない。VLCKit 内蔵の FFmpeg と衝突させないため）。
#ifndef MT_CORE_H
#define MT_CORE_H

#ifdef __cplusplus
extern "C" {
#endif

enum {
  MT_OK = 0,
  MT_CANCELLED = 1,
  MT_ERROR = -1,
};

typedef enum {
  // 映像+音声を MP4（H.264 / AAC）に。H.264/HEVC・AAC は範囲指定がなければそのままコピー
  MT_MODE_MP4 = 0,
  // 音声だけを M4A（AAC）に
  MT_MODE_M4A = 1,
  // 音声だけを MP3 に
  MT_MODE_MP3 = 2,
} MTMode;

typedef struct {
  const char *input;
  const char *output;
  MTMode mode;
  // 切り出す範囲（秒）。負の値なら指定なし。範囲を指定すると映像・音声とも再エンコードする
  double start_sec;
  double end_sec;
  // 1 にすると、コピーできる形式でも再エンコードする
  int force_encode;
  // 0 なら解像度から自動
  int video_bitrate;
  // 0 なら AAC 192kbps / MP3 192kbps
  int audio_bitrate;
  // 0 なら元の高さのまま
  int max_height;
  // 映像エンコーダの名前（NULL なら h264_videotoolbox → libx264 → mpeg4 の順に探す）
  const char *video_encoder;
} MTConvertOptions;

typedef struct {
  double duration_sec;
  int has_video;
  int has_audio;
  int width;
  int height;
  char video_codec[32];
  char audio_codec[32];
  char container[64];
} MTProbeResult;

// fraction は 0〜1
typedef void (*MTProgressCallback)(void *context, double fraction);

int mt_probe(const char *input, MTProbeResult *result, char *error, int error_len);

// cancel が 0 以外になったら途中でやめて MT_CANCELLED を返す（出力ファイルは呼び出し側で削除する）
int mt_convert(const MTConvertOptions *options, MTProgressCallback progress, void *context, volatile int *cancel,
               char *error, int error_len);

// 同じ形式の MP4（区間ごとに変換したもの）を、再エンコードせずに1本につなげる
int mt_concat(const char *const *inputs, int count, const char *output, volatile int *cancel, char *error,
              int error_len);

#ifdef __cplusplus
}
#endif

#endif
