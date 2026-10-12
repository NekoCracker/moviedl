// 動画・音声の変換コア。仕様は mt_core.h を参照。
// FFmpeg 6.1 / 7.x の公開APIだけを使う（Linux での単体テストは 6.1、iOS 版は 7.1 でビルド）。
#include "mt_core.h"

#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/audio_fifo.h>
#include <libavutil/avstring.h>
#include <libavutil/channel_layout.h>
#include <libavutil/opt.h>
#include <libavutil/samplefmt.h>
#include <libswresample/swresample.h>
#include <libswscale/swscale.h>
#include <math.h>
#include <stdarg.h>
#include <stdio.h>
#include <string.h>

#define MT_EXPORT __attribute__((visibility("default")))

static void set_error(char *buf, int len, const char *fmt, ...) {
  if (!buf || len <= 0) return;
  va_list args;
  va_start(args, fmt);
  vsnprintf(buf, (size_t)len, fmt, args);
  va_end(args);
}

static void set_av_error(char *buf, int len, const char *what, int err) {
  char reason[AV_ERROR_MAX_STRING_SIZE] = {0};
  av_strerror(err, reason, sizeof(reason));
  set_error(buf, len, "%s: %s", what, reason);
}

// ---------------------------------------------------------------- probe

MT_EXPORT int mt_probe(const char *input, MTProbeResult *result, char *error, int error_len) {
  memset(result, 0, sizeof(*result));
  AVFormatContext *fmt = NULL;
  int ret = avformat_open_input(&fmt, input, NULL, NULL);
  if (ret < 0) {
    set_av_error(error, error_len, "ファイルを開けません", ret);
    return MT_ERROR;
  }
  ret = avformat_find_stream_info(fmt, NULL);
  if (ret < 0) {
    avformat_close_input(&fmt);
    set_av_error(error, error_len, "形式を判別できません", ret);
    return MT_ERROR;
  }
  if (fmt->duration > 0) result->duration_sec = fmt->duration / (double)AV_TIME_BASE;
  av_strlcpy(result->container, fmt->iformat->name, sizeof(result->container));

  for (unsigned i = 0; i < fmt->nb_streams; i++) {
    AVStream *st = fmt->streams[i];
    AVCodecParameters *par = st->codecpar;
    if (par->codec_type == AVMEDIA_TYPE_VIDEO && !(st->disposition & AV_DISPOSITION_ATTACHED_PIC) && !result->has_video) {
      result->has_video = 1;
      result->width = par->width;
      result->height = par->height;
      av_strlcpy(result->video_codec, avcodec_get_name(par->codec_id), sizeof(result->video_codec));
    } else if (par->codec_type == AVMEDIA_TYPE_AUDIO && !result->has_audio) {
      result->has_audio = 1;
      av_strlcpy(result->audio_codec, avcodec_get_name(par->codec_id), sizeof(result->audio_codec));
    }
  }
  avformat_close_input(&fmt);
  return MT_OK;
}

// ---------------------------------------------------------------- convert

typedef struct {
  const MTConvertOptions *opt;
  AVFormatContext *in;
  AVFormatContext *out;
  AVPacket *pkt;
  AVFrame *frame;

  int has_range;
  double start;  // 秒
  double end;    // 秒（負なら最後まで）
  double offset; // 出力の時刻 0 にあたる入力の時刻（秒）
  double total;  // 進捗計算に使う長さ（秒）

  // 映像
  int vin, vout, vcopy, vdone;
  AVCodecContext *vdec, *venc;
  struct SwsContext *sws;
  int sws_src_w, sws_src_h, sws_src_fmt;
  AVFrame *scaled;
  int64_t v_last_pts;

  // 音声
  int ain, aout, acopy, adone;
  AVCodecContext *adec, *aenc;
  SwrContext *swr;
  AVAudioFifo *fifo;
  int64_t a_next_pts;
  int a_started;
} Job;

static int is_mp4_video_copyable(enum AVCodecID id) { return id == AV_CODEC_ID_H264 || id == AV_CODEC_ID_HEVC; }

static const AVCodec *find_video_encoder(const char *preferred) {
  if (preferred) {
    const AVCodec *c = avcodec_find_encoder_by_name(preferred);
    if (c) return c;
  }
  const char *names[] = {"h264_videotoolbox", "libx264", "mpeg4"};
  for (size_t i = 0; i < sizeof(names) / sizeof(names[0]); i++) {
    const AVCodec *c = avcodec_find_encoder_by_name(names[i]);
    if (c) return c;
  }
  return NULL;
}

static int auto_video_bitrate(int height) {
  if (height <= 480) return 1500000;
  if (height <= 720) return 3500000;
  if (height <= 1080) return 6000000;
  if (height <= 1440) return 10000000;
  return 16000000;
}

static int open_decoder(AVStream *st, AVCodecContext **out, char *error, int error_len) {
  const AVCodec *dec = NULL;
  // AV1 は dav1d を優先（FFmpeg 内蔵の AV1 デコーダはハードウェア前提のため）
  if (st->codecpar->codec_id == AV_CODEC_ID_AV1) dec = avcodec_find_decoder_by_name("libdav1d");
  if (!dec) dec = avcodec_find_decoder(st->codecpar->codec_id);
  if (!dec) {
    set_error(error, error_len, "%s の読み込みに対応していません", avcodec_get_name(st->codecpar->codec_id));
    return MT_ERROR;
  }
  AVCodecContext *ctx = avcodec_alloc_context3(dec);
  if (!ctx) return MT_ERROR;
  int ret = avcodec_parameters_to_context(ctx, st->codecpar);
  if (ret >= 0) {
    ctx->pkt_timebase = st->time_base;
    ctx->thread_count = 0;
    ret = avcodec_open2(ctx, dec, NULL);
  }
  if (ret < 0) {
    avcodec_free_context(&ctx);
    set_av_error(error, error_len, "デコーダを開けません", ret);
    return MT_ERROR;
  }
  *out = ctx;
  return MT_OK;
}

static int setup_video(Job *job, char *error, int error_len) {
  AVStream *ist = job->in->streams[job->vin];
  AVStream *ost = avformat_new_stream(job->out, NULL);
  if (!ost) return MT_ERROR;
  job->vout = ost->index;

  job->vcopy = !job->has_range && !job->opt->force_encode && is_mp4_video_copyable(ist->codecpar->codec_id) &&
               (job->opt->max_height <= 0 || ist->codecpar->height <= job->opt->max_height);
  if (job->vcopy) {
    int ret = avcodec_parameters_copy(ost->codecpar, ist->codecpar);
    if (ret < 0) return MT_ERROR;
    // iPhone で再生できるよう HEVC は hvc1 で書く
    ost->codecpar->codec_tag = ist->codecpar->codec_id == AV_CODEC_ID_HEVC ? MKTAG('h', 'v', 'c', '1') : 0;
    ost->time_base = ist->time_base;
    return MT_OK;
  }

  if (open_decoder(ist, &job->vdec, error, error_len) != MT_OK) return MT_ERROR;
  const AVCodec *enc = find_video_encoder(job->opt->video_encoder);
  if (!enc) {
    set_error(error, error_len, "H.264 エンコーダが見つかりません");
    return MT_ERROR;
  }
  AVCodecContext *c = avcodec_alloc_context3(enc);
  if (!c) return MT_ERROR;
  job->venc = c;

  int w = job->vdec->width, h = job->vdec->height;
  if (job->opt->max_height > 0 && h > job->opt->max_height) {
    w = (int)llround((double)w * job->opt->max_height / h);
    h = job->opt->max_height;
  }
  // H.264 は偶数サイズが必要
  c->width = w & ~1;
  c->height = h & ~1;
  c->pix_fmt = AV_PIX_FMT_YUV420P;
  c->sample_aspect_ratio = job->vdec->sample_aspect_ratio;
  c->time_base = ist->time_base;
  AVRational fr = av_guess_frame_rate(job->in, ist, NULL);
  if (fr.num > 0 && fr.den > 0) c->framerate = fr;
  // mpeg4 は time_base の分母が 65535 以下でないと開けない
  if (strcmp(enc->name, "mpeg4") == 0 && c->time_base.den > 65535) {
    c->time_base = (fr.num > 0 && fr.den > 0) ? av_inv_q(fr) : (AVRational){1, 30};
  }
  c->bit_rate = job->opt->video_bitrate > 0 ? job->opt->video_bitrate : auto_video_bitrate(c->height);
  c->color_range = AVCOL_RANGE_MPEG;
  if (job->out->oformat->flags & AVFMT_GLOBALHEADER) c->flags |= AV_CODEC_FLAG_GLOBAL_HEADER;

  AVDictionary *opts = NULL;
  if (strcmp(enc->name, "libx264") == 0) av_dict_set(&opts, "preset", "veryfast", 0);
  if (strcmp(enc->name, "h264_videotoolbox") == 0) {
    av_dict_set(&opts, "profile", "high", 0);
    av_dict_set(&opts, "allow_sw", "1", 0);
  }
  int ret = avcodec_open2(c, enc, &opts);
  av_dict_free(&opts);
  if (ret < 0) {
    set_av_error(error, error_len, "映像エンコーダを開けません", ret);
    return MT_ERROR;
  }
  ret = avcodec_parameters_from_context(ost->codecpar, c);
  if (ret < 0) return MT_ERROR;
  ost->time_base = c->time_base;
  if (fr.num > 0 && fr.den > 0) ost->avg_frame_rate = fr;

  job->scaled = av_frame_alloc();
  job->scaled->format = c->pix_fmt;
  job->scaled->width = c->width;
  job->scaled->height = c->height;
  if (av_frame_get_buffer(job->scaled, 0) < 0) return MT_ERROR;
  job->v_last_pts = AV_NOPTS_VALUE;
  return MT_OK;
}

static int pick_sample_rate(const AVCodec *enc, int wanted) {
  const int *rates = NULL;
#if LIBAVCODEC_VERSION_INT >= AV_VERSION_INT(61, 13, 100)
  avcodec_get_supported_config(NULL, enc, AV_CODEC_CONFIG_SAMPLE_RATE, 0, (const void **)&rates, NULL);
#else
  rates = enc->supported_samplerates;
#endif
  if (!rates) return wanted;
  int best = 0;
  for (const int *r = rates; *r; r++) {
    if (*r == wanted) return wanted;
    if (*r == 48000 || (*r == 44100 && best != 48000)) best = *r;
  }
  return best ? best : rates[0];
}

static int setup_audio(Job *job, char *error, int error_len) {
  AVStream *ist = job->in->streams[job->ain];
  AVStream *ost = avformat_new_stream(job->out, NULL);
  if (!ost) return MT_ERROR;
  job->aout = ost->index;
  enum AVCodecID in_id = ist->codecpar->codec_id;
  MTMode mode = job->opt->mode;

  int copyable = mode == MT_MODE_MP3 ? in_id == AV_CODEC_ID_MP3 : in_id == AV_CODEC_ID_AAC;
  job->acopy = !job->has_range && !job->opt->force_encode && copyable;
  if (job->acopy) {
    if (avcodec_parameters_copy(ost->codecpar, ist->codecpar) < 0) return MT_ERROR;
    ost->codecpar->codec_tag = 0;
    ost->time_base = ist->time_base;
    return MT_OK;
  }

  if (open_decoder(ist, &job->adec, error, error_len) != MT_OK) return MT_ERROR;
  const AVCodec *enc = mode == MT_MODE_MP3 ? avcodec_find_encoder_by_name("libmp3lame") : avcodec_find_encoder(AV_CODEC_ID_AAC);
  if (!enc) {
    set_error(error, error_len, mode == MT_MODE_MP3 ? "MP3 エンコーダがありません" : "AAC エンコーダがありません");
    return MT_ERROR;
  }
  AVCodecContext *c = avcodec_alloc_context3(enc);
  if (!c) return MT_ERROR;
  job->aenc = c;
  int channels = job->adec->ch_layout.nb_channels >= 2 ? 2 : 1;
  av_channel_layout_default(&c->ch_layout, channels);
  c->sample_rate = pick_sample_rate(enc, job->adec->sample_rate > 0 ? job->adec->sample_rate : 48000);
  c->sample_fmt = AV_SAMPLE_FMT_FLTP;
  c->bit_rate = job->opt->audio_bitrate > 0 ? job->opt->audio_bitrate : 192000;
  c->time_base = (AVRational){1, c->sample_rate};
  if (job->out->oformat->flags & AVFMT_GLOBALHEADER) c->flags |= AV_CODEC_FLAG_GLOBAL_HEADER;
  int ret = avcodec_open2(c, enc, NULL);
  if (ret < 0) {
    set_av_error(error, error_len, "音声エンコーダを開けません", ret);
    return MT_ERROR;
  }
  if (avcodec_parameters_from_context(ost->codecpar, c) < 0) return MT_ERROR;
  ost->time_base = c->time_base;

  AVChannelLayout in_layout;
  if (job->adec->ch_layout.order == AV_CHANNEL_ORDER_UNSPEC || job->adec->ch_layout.nb_channels == 0) {
    av_channel_layout_default(&in_layout, job->adec->ch_layout.nb_channels > 0 ? job->adec->ch_layout.nb_channels : 2);
  } else {
    av_channel_layout_copy(&in_layout, &job->adec->ch_layout);
  }
  ret = swr_alloc_set_opts2(&job->swr, &c->ch_layout, c->sample_fmt, c->sample_rate, &in_layout, job->adec->sample_fmt,
                            job->adec->sample_rate, 0, NULL);
  av_channel_layout_uninit(&in_layout);
  if (ret < 0 || swr_init(job->swr) < 0) {
    set_error(error, error_len, "音声の変換を準備できません");
    return MT_ERROR;
  }
  job->fifo = av_audio_fifo_alloc(c->sample_fmt, c->ch_layout.nb_channels, c->frame_size > 0 ? c->frame_size * 4 : 4096);
  return job->fifo ? MT_OK : MT_ERROR;
}

static void seek_to_file_start(Job *job, double file_start) {
  // 時刻での移動は形式によって不正確なので、できればファイルの先頭バイトへ戻す
  if (!(job->in->iformat->flags & AVFMT_NO_BYTE_SEEK) && av_seek_frame(job->in, -1, 0, AVSEEK_FLAG_BYTE) >= 0) return;
  int64_t ts = (int64_t)(file_start * AV_TIME_BASE);
  avformat_seek_file(job->in, -1, INT64_MIN, ts, ts, 0);
}

// 開始位置より前のキーフレームへ移動する。MPEG-TS などは移動先が不正確なので、
// 実際に読めた位置が開始位置を過ぎていたら、さらに前へ戻してやり直す
static void seek_before(Job *job, double file_start) {
  int check_stream = job->vin >= 0 ? job->vin : job->ain;
  AVPacket *probe = av_packet_alloc();
  if (!probe) {
    seek_to_file_start(job, file_start);
    return;
  }
  for (double back = 1.0; back < 600; back *= 4) {
    double target_sec = job->start - back;
    if (target_sec <= file_start) break;
    int64_t target = (int64_t)(target_sec * AV_TIME_BASE);
    if (avformat_seek_file(job->in, -1, INT64_MIN, target, target, 0) < 0) break;
    // 移動先から最初に読めるキーフレームの位置を調べる（デコードはそこから始まるため）
    double first = -1;
    for (int n = 0; n < 3000 && first < 0; n++) {
      if (av_read_frame(job->in, probe) < 0) break;
      if (probe->stream_index == check_stream && probe->pts != AV_NOPTS_VALUE && (probe->flags & AV_PKT_FLAG_KEY)) {
        first = probe->pts * av_q2d(job->in->streams[check_stream]->time_base);
      }
      av_packet_unref(probe);
    }
    if (first >= 0 && first <= job->start) {
      avformat_seek_file(job->in, -1, INT64_MIN, target, target, 0);
      av_packet_free(&probe);
      return;
    }
  }
  av_packet_free(&probe);
  seek_to_file_start(job, file_start);
}

static int write_encoded(Job *job, AVCodecContext *enc, int out_index) {
  AVStream *ost = job->out->streams[out_index];
  for (;;) {
    int ret = avcodec_receive_packet(enc, job->pkt);
    if (ret == AVERROR(EAGAIN) || ret == AVERROR_EOF) return 0;
    if (ret < 0) return ret;
    av_packet_rescale_ts(job->pkt, enc->time_base, ost->time_base);
    job->pkt->stream_index = out_index;
    ret = av_interleaved_write_frame(job->out, job->pkt);
    if (ret < 0) return ret;
  }
}

// 入力の時刻（秒）が切り出し範囲の前なら -1、範囲内なら 0、後ろなら 1
static int range_position(const Job *job, double t, double duration) {
  if (!job->has_range) return 0;
  if (t + duration < job->start - 0.0005) return -1;
  if (job->end >= 0 && t >= job->end) return 1;
  return 0;
}

static int encode_video_frame(Job *job, AVFrame *frame) {
  if (!frame) {
    int ret = avcodec_send_frame(job->venc, NULL);
    if (ret < 0 && ret != AVERROR_EOF) return ret;
    return write_encoded(job, job->venc, job->vout);
  }
  AVStream *ist = job->in->streams[job->vin];
  int64_t pts = frame->best_effort_timestamp;
  if (pts == AV_NOPTS_VALUE) pts = frame->pts;
  if (pts == AV_NOPTS_VALUE) pts = job->v_last_pts == AV_NOPTS_VALUE ? 0 : job->v_last_pts + 1;
  double t = pts * av_q2d(ist->time_base);
  int pos = range_position(job, t, 0);
  if (pos < 0) return 0;
  if (pos > 0) {
    job->vdone = 1;
    return 0;
  }

  if (!job->sws || job->sws_src_w != frame->width || job->sws_src_h != frame->height || job->sws_src_fmt != frame->format) {
    sws_freeContext(job->sws);
    job->sws = sws_getContext(frame->width, frame->height, (enum AVPixelFormat)frame->format, job->venc->width,
                              job->venc->height, job->venc->pix_fmt, SWS_BICUBIC, NULL, NULL, NULL);
    if (!job->sws) return AVERROR(EINVAL);
    job->sws_src_w = frame->width;
    job->sws_src_h = frame->height;
    job->sws_src_fmt = frame->format;
  }
  int ret = av_frame_make_writable(job->scaled);
  if (ret < 0) return ret;
  sws_scale(job->sws, (const uint8_t *const *)frame->data, frame->linesize, 0, frame->height, job->scaled->data,
            job->scaled->linesize);

  int64_t offset = (int64_t)llround(job->offset / av_q2d(job->venc->time_base));
  int64_t out_pts = av_rescale_q(pts, ist->time_base, job->venc->time_base) - offset;
  if (out_pts < 0) out_pts = 0;
  if (job->v_last_pts != AV_NOPTS_VALUE && out_pts <= job->v_last_pts) out_pts = job->v_last_pts + 1;
  job->v_last_pts = out_pts;
  job->scaled->pts = out_pts;
  job->scaled->pict_type = AV_PICTURE_TYPE_NONE;

  ret = avcodec_send_frame(job->venc, job->scaled);
  if (ret < 0) return ret;
  return write_encoded(job, job->venc, job->vout);
}

static int encode_audio_from_fifo(Job *job, int flush) {
  AVCodecContext *c = job->aenc;
  int frame_size = c->frame_size > 0 ? c->frame_size : 1024;
  while (av_audio_fifo_size(job->fifo) >= frame_size || (flush && av_audio_fifo_size(job->fifo) > 0)) {
    int available = av_audio_fifo_size(job->fifo);
    int n = available < frame_size ? available : frame_size;
    AVFrame *f = av_frame_alloc();
    if (!f) return AVERROR(ENOMEM);
    // 最後の半端なフレームは、対応していないエンコーダ向けに無音で埋める
    int padded = (n < frame_size && !(c->codec->capabilities & AV_CODEC_CAP_SMALL_LAST_FRAME)) ? frame_size : n;
    f->nb_samples = padded;
    f->format = c->sample_fmt;
    f->sample_rate = c->sample_rate;
    av_channel_layout_copy(&f->ch_layout, &c->ch_layout);
    int ret = av_frame_get_buffer(f, 0);
    if (ret >= 0 && padded > n) {
      av_samples_set_silence(f->data, 0, padded, c->ch_layout.nb_channels, c->sample_fmt);
    }
    if (ret >= 0 && av_audio_fifo_read(job->fifo, (void **)f->data, n) < n) ret = AVERROR(EIO);
    if (ret >= 0) {
      f->pts = job->a_next_pts;
      job->a_next_pts += padded;
      ret = avcodec_send_frame(c, f);
    }
    av_frame_free(&f);
    if (ret < 0) return ret;
    ret = write_encoded(job, c, job->aout);
    if (ret < 0) return ret;
  }
  return 0;
}

static int push_resampled(Job *job, const uint8_t **in_data, int in_samples) {
  AVCodecContext *c = job->aenc;
  int max_out = swr_get_out_samples(job->swr, in_samples);
  if (max_out <= 0) return 0;
  uint8_t **buf = NULL;
  int ret = av_samples_alloc_array_and_samples(&buf, NULL, c->ch_layout.nb_channels, max_out, c->sample_fmt, 0);
  if (ret < 0) return ret;
  int got = swr_convert(job->swr, buf, max_out, in_data, in_samples);
  if (got > 0 && av_audio_fifo_write(job->fifo, (void **)buf, got) < got) got = AVERROR(ENOMEM);
  av_freep(&buf[0]);
  av_freep(&buf);
  return got < 0 ? got : 0;
}

static int encode_audio_frame(Job *job, AVFrame *frame) {
  if (!frame) {
    if (!job->a_started) return 0;
    int ret = push_resampled(job, NULL, 0);
    if (ret < 0) return ret;
    ret = encode_audio_from_fifo(job, 1);
    if (ret < 0) return ret;
    ret = avcodec_send_frame(job->aenc, NULL);
    if (ret < 0 && ret != AVERROR_EOF) return ret;
    return write_encoded(job, job->aenc, job->aout);
  }
  AVStream *ist = job->in->streams[job->ain];
  int64_t pts = frame->best_effort_timestamp;
  if (pts == AV_NOPTS_VALUE) pts = frame->pts;
  double t = pts == AV_NOPTS_VALUE ? -1 : pts * av_q2d(ist->time_base);
  double dur = frame->sample_rate > 0 ? (double)frame->nb_samples / frame->sample_rate : 0;
  if (t >= 0) {
    int pos = range_position(job, t, dur);
    if (pos < 0) return 0;
    if (pos > 0) {
      job->adone = 1;
      return 0;
    }
  }
  if (!job->a_started) {
    // 映像と合わせるため、最初の音声の位置を出力の時刻に合わせる
    double start_at = t >= 0 ? t - job->offset : 0;
    job->a_next_pts = start_at > 0 ? (int64_t)llround(start_at * job->aenc->sample_rate) : 0;
    job->a_started = 1;
  }
  int ret = push_resampled(job, (const uint8_t **)frame->extended_data, frame->nb_samples);
  if (ret < 0) return ret;
  return encode_audio_from_fifo(job, 0);
}

static int decode_packet(Job *job, AVCodecContext *dec, AVPacket *pkt, int is_video) {
  int ret = avcodec_send_packet(dec, pkt);
  if (ret < 0 && ret != AVERROR_EOF && ret != AVERROR_INVALIDDATA) return ret;
  for (;;) {
    ret = avcodec_receive_frame(dec, job->frame);
    if (ret == AVERROR(EAGAIN) || ret == AVERROR_EOF) return 0;
    if (ret < 0) return ret;
    ret = is_video ? encode_video_frame(job, job->frame) : encode_audio_frame(job, job->frame);
    av_frame_unref(job->frame);
    if (ret < 0) return ret;
  }
}

static void report_progress(Job *job, AVPacket *pkt, MTProgressCallback progress, void *context) {
  if (!progress || job->total <= 0 || pkt->pts == AV_NOPTS_VALUE) return;
  double t = pkt->pts * av_q2d(job->in->streams[pkt->stream_index]->time_base);
  double done = t - (job->has_range ? job->start : job->offset);
  double fraction = done / job->total;
  if (fraction < 0) fraction = 0;
  if (fraction > 1) fraction = 1;
  progress(context, fraction);
}

static void free_job(Job *job) {
  avcodec_free_context(&job->vdec);
  avcodec_free_context(&job->venc);
  avcodec_free_context(&job->adec);
  avcodec_free_context(&job->aenc);
  sws_freeContext(job->sws);
  swr_free(&job->swr);
  if (job->fifo) av_audio_fifo_free(job->fifo);
  av_frame_free(&job->scaled);
  av_frame_free(&job->frame);
  av_packet_free(&job->pkt);
  if (job->out) {
    if (!(job->out->oformat->flags & AVFMT_NOFILE)) avio_closep(&job->out->pb);
    avformat_free_context(job->out);
  }
  avformat_close_input(&job->in);
}

static int open_output(AVFormatContext **out, const char *path, char *error, int error_len) {
  int ret = avformat_alloc_output_context2(out, NULL, NULL, path);
  if (ret < 0 || !*out) {
    set_av_error(error, error_len, "出力形式を判別できません", ret);
    return MT_ERROR;
  }
  return MT_OK;
}

static int write_header(AVFormatContext *out, const char *path, char *error, int error_len) {
  int ret = 0;
  if (!(out->oformat->flags & AVFMT_NOFILE)) {
    ret = avio_open(&out->pb, path, AVIO_FLAG_WRITE);
    if (ret < 0) {
      set_av_error(error, error_len, "出力ファイルを作れません", ret);
      return MT_ERROR;
    }
  }
  AVDictionary *opts = NULL;
  // 先頭にインデックスを置き、すぐ再生できるようにする
  if (strcmp(out->oformat->name, "mp4") == 0 || strcmp(out->oformat->name, "ipod") == 0 || strcmp(out->oformat->name, "mov") == 0) {
    av_dict_set(&opts, "movflags", "+faststart", 0);
  }
  out->avoid_negative_ts = AVFMT_AVOID_NEG_TS_MAKE_ZERO;
  ret = avformat_write_header(out, &opts);
  av_dict_free(&opts);
  if (ret < 0) {
    set_av_error(error, error_len, "出力を開始できません", ret);
    return MT_ERROR;
  }
  return MT_OK;
}

MT_EXPORT int mt_convert(const MTConvertOptions *opt, MTProgressCallback progress, void *context, volatile int *cancel,
                         char *error, int error_len) {
  Job job;
  memset(&job, 0, sizeof(job));
  job.opt = opt;
  job.vin = job.ain = job.vout = job.aout = -1;
  int status = MT_ERROR;
  int ret;

  ret = avformat_open_input(&job.in, opt->input, NULL, NULL);
  if (ret < 0) {
    set_av_error(error, error_len, "ファイルを開けません", ret);
    return MT_ERROR;
  }
  if ((ret = avformat_find_stream_info(job.in, NULL)) < 0) {
    set_av_error(error, error_len, "形式を判別できません", ret);
    goto end;
  }
  if (open_output(&job.out, opt->output, error, error_len) != MT_OK) goto end;

  if (opt->mode == MT_MODE_MP4) {
    for (unsigned i = 0; i < job.in->nb_streams; i++) {
      AVStream *st = job.in->streams[i];
      if (st->codecpar->codec_type == AVMEDIA_TYPE_VIDEO && !(st->disposition & AV_DISPOSITION_ATTACHED_PIC)) {
        int best = av_find_best_stream(job.in, AVMEDIA_TYPE_VIDEO, -1, -1, NULL, 0);
        job.vin = (best >= 0 && !(job.in->streams[best]->disposition & AV_DISPOSITION_ATTACHED_PIC)) ? best : (int)i;
        break;
      }
    }
  }
  job.ain = av_find_best_stream(job.in, AVMEDIA_TYPE_AUDIO, -1, job.vin, NULL, 0);
  if (job.ain < 0) job.ain = -1;
  if (opt->mode != MT_MODE_MP4 && job.ain < 0) {
    set_error(error, error_len, "音声が含まれていません");
    goto end;
  }
  if (job.vin < 0 && job.ain < 0) {
    set_error(error, error_len, "映像も音声も見つかりません");
    goto end;
  }

  double duration = job.in->duration > 0 ? job.in->duration / (double)AV_TIME_BASE : 0;
  double file_start = job.in->start_time != AV_NOPTS_VALUE ? job.in->start_time / (double)AV_TIME_BASE : 0;
  job.has_range = opt->start_sec >= 0 || opt->end_sec >= 0;
  job.start = opt->start_sec >= 0 ? file_start + opt->start_sec : file_start;
  job.end = opt->end_sec >= 0 ? file_start + opt->end_sec : -1;
  job.offset = job.start;
  job.total = (job.end >= 0 ? job.end : file_start + duration) - job.start;

  if (job.vin >= 0 && setup_video(&job, error, error_len) != MT_OK) goto end;
  if (job.ain >= 0 && setup_audio(&job, error, error_len) != MT_OK) goto end;
  if (job.vin < 0) job.vdone = 1;
  if (job.ain < 0) job.adone = 1;

  job.pkt = av_packet_alloc();
  job.frame = av_frame_alloc();
  if (!job.pkt || !job.frame) goto end;

  if (job.has_range && job.start > file_start) seek_before(&job, file_start);

  if (write_header(job.out, opt->output, error, error_len) != MT_OK) goto end;

  AVPacket *in_pkt = av_packet_alloc();
  if (!in_pkt) goto end;
  int64_t copy_offset_us = (int64_t)llround(job.offset * AV_TIME_BASE);
  int cancelled = 0;
  while (!(job.vdone && job.adone)) {
    if (cancel && *cancel) {
      cancelled = 1;
      break;
    }
    ret = av_read_frame(job.in, in_pkt);
    if (ret == AVERROR_EOF) break;
    if (ret < 0) {
      set_av_error(error, error_len, "読み込みに失敗しました", ret);
      av_packet_free(&in_pkt);
      goto end;
    }
    int idx = in_pkt->stream_index;
    report_progress(&job, in_pkt, progress, context);
    if (idx == job.vin && !job.vdone) {
      if (job.vcopy) {
        AVStream *ist = job.in->streams[idx], *ost = job.out->streams[job.vout];
        int64_t off = av_rescale_q(copy_offset_us, AV_TIME_BASE_Q, ist->time_base);
        if (in_pkt->pts != AV_NOPTS_VALUE) in_pkt->pts -= off;
        if (in_pkt->dts != AV_NOPTS_VALUE) in_pkt->dts -= off;
        av_packet_rescale_ts(in_pkt, ist->time_base, ost->time_base);
        in_pkt->stream_index = job.vout;
        in_pkt->pos = -1;
        ret = av_interleaved_write_frame(job.out, in_pkt);
      } else {
        ret = decode_packet(&job, job.vdec, in_pkt, 1);
      }
    } else if (idx == job.ain && !job.adone) {
      if (job.acopy) {
        AVStream *ist = job.in->streams[idx], *ost = job.out->streams[job.aout];
        int64_t off = av_rescale_q(copy_offset_us, AV_TIME_BASE_Q, ist->time_base);
        if (in_pkt->pts != AV_NOPTS_VALUE) in_pkt->pts -= off;
        if (in_pkt->dts != AV_NOPTS_VALUE) in_pkt->dts -= off;
        av_packet_rescale_ts(in_pkt, ist->time_base, ost->time_base);
        in_pkt->stream_index = job.aout;
        in_pkt->pos = -1;
        ret = av_interleaved_write_frame(job.out, in_pkt);
      } else {
        ret = decode_packet(&job, job.adec, in_pkt, 0);
      }
    } else {
      ret = 0;
    }
    av_packet_unref(in_pkt);
    if (ret < 0) {
      set_av_error(error, error_len, "変換に失敗しました", ret);
      av_packet_free(&in_pkt);
      goto end;
    }
  }
  av_packet_free(&in_pkt);
  if (cancelled) {
    status = MT_CANCELLED;
    goto end;
  }

  // デコーダ・エンコーダに残っている分を書き出す
  if (job.vdec && (ret = decode_packet(&job, job.vdec, NULL, 1)) < 0) goto flush_error;
  if (job.venc && (ret = encode_video_frame(&job, NULL)) < 0) goto flush_error;
  if (job.adec && (ret = decode_packet(&job, job.adec, NULL, 0)) < 0) goto flush_error;
  if (job.aenc && (ret = encode_audio_frame(&job, NULL)) < 0) goto flush_error;

  ret = av_write_trailer(job.out);
  if (ret < 0) goto flush_error;
  if (progress) progress(context, 1.0);
  status = MT_OK;
  goto end;

flush_error:
  set_av_error(error, error_len, "書き出しに失敗しました", ret);
end:
  free_job(&job);
  return status;
}

// ---------------------------------------------------------------- concat

MT_EXPORT int mt_concat(const char *const *inputs, int count, const char *output, volatile int *cancel, char *error,
                        int error_len) {
  if (count <= 0) {
    set_error(error, error_len, "つなげるファイルがありません");
    return MT_ERROR;
  }
  // concat デマルチプレクサ用のリストを書く
  char list_path[2048];
  snprintf(list_path, sizeof(list_path), "%s.list.txt", output);
  FILE *list = fopen(list_path, "w");
  if (!list) {
    set_error(error, error_len, "一時ファイルを作れません");
    return MT_ERROR;
  }
  fprintf(list, "ffconcat version 1.0\n");
  for (int i = 0; i < count; i++) {
    fprintf(list, "file '");
    for (const char *p = inputs[i]; *p; p++) {
      if (*p == '\'') fprintf(list, "'\\''");
      else fputc(*p, list);
    }
    fprintf(list, "'\n");
  }
  fclose(list);

  int status = MT_ERROR;
  AVFormatContext *in = NULL, *out = NULL;
  AVPacket *pkt = NULL;
  AVDictionary *in_opts = NULL;
  av_dict_set(&in_opts, "safe", "0", 0);
  const AVInputFormat *concat = av_find_input_format("concat");
  int ret = avformat_open_input(&in, list_path, concat, &in_opts);
  av_dict_free(&in_opts);
  if (ret < 0) {
    set_av_error(error, error_len, "区間ファイルを開けません", ret);
    goto end;
  }
  if ((ret = avformat_find_stream_info(in, NULL)) < 0) {
    set_av_error(error, error_len, "区間ファイルを読めません", ret);
    goto end;
  }
  if (open_output(&out, output, error, error_len) != MT_OK) goto end;
  for (unsigned i = 0; i < in->nb_streams; i++) {
    AVStream *ost = avformat_new_stream(out, NULL);
    if (!ost || avcodec_parameters_copy(ost->codecpar, in->streams[i]->codecpar) < 0) goto end;
    ost->codecpar->codec_tag = 0;
    ost->time_base = in->streams[i]->time_base;
  }
  if (write_header(out, output, error, error_len) != MT_OK) goto end;
  pkt = av_packet_alloc();
  if (!pkt) goto end;
  for (;;) {
    if (cancel && *cancel) {
      status = MT_CANCELLED;
      goto end;
    }
    ret = av_read_frame(in, pkt);
    if (ret == AVERROR_EOF) break;
    if (ret < 0) {
      set_av_error(error, error_len, "区間ファイルを読めません", ret);
      goto end;
    }
    AVStream *ist = in->streams[pkt->stream_index], *ost = out->streams[pkt->stream_index];
    av_packet_rescale_ts(pkt, ist->time_base, ost->time_base);
    pkt->pos = -1;
    ret = av_interleaved_write_frame(out, pkt);
    av_packet_unref(pkt);
    if (ret < 0) {
      set_av_error(error, error_len, "つなげる処理に失敗しました", ret);
      goto end;
    }
  }
  if ((ret = av_write_trailer(out)) < 0) {
    set_av_error(error, error_len, "つなげる処理に失敗しました", ret);
    goto end;
  }
  status = MT_OK;

end:
  av_packet_free(&pkt);
  if (out) {
    if (!(out->oformat->flags & AVFMT_NOFILE)) avio_closep(&out->pb);
    avformat_free_context(out);
  }
  avformat_close_input(&in);
  remove(list_path);
  return status;
}
