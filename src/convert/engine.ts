// 変換の実行（feature-spec.md §2-12・§2-13）
// conversions テーブルの行を1件ずつ処理する。映像の再エンコードは30秒ごとの区間に分けて変換し、
// 終わった区間は残しておくので、アプリが終了・中断されても次に開いたとき続きから再開できる。
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { Directory, File, Paths } from 'expo-file-system';
import type { SQLiteDatabase } from 'expo-sqlite';
import { AppState } from 'react-native';
import { MediaTools, type ConvertMode, type ConvertOptions, type ProbeResult } from 'media-tools';

import { getMediaByIds, nextManualOrder, type MediaItem } from '@/db/library';
import { mediaFile } from '@/download/storage';
import { notifyJobsChanged, setLiveProgress } from '@/download/store';
import { createThumbnail } from '@/library/media-actions';

export type ConversionKind = 'mp4' | 'm4a' | 'mp3' | 'trim';
export type ConversionStatus = 'pending' | 'running' | 'paused' | 'done' | 'error';

type ConversionRow = {
  id: number;
  video_id: number;
  kind: ConversionKind;
  params_json: string;
  total_chunks: number;
  done_chunks: number;
  status: ConversionStatus;
};

type Params = {
  // mp3 のビットレート（kbps）
  bitrate?: number;
  // trim の範囲（秒）と、元の動画を置き換えるか
  start?: number;
  end?: number;
  replace?: boolean;
  // ダウンロード時に「音声のみ」を選んだもの。変換後に元の動画を消す
  removeSource?: boolean;
};

const VIDEO_CHUNK_SEC = 30;
// MP3 は区間のつなぎ目にわずかな無音が入るので、長めに区切る（たいていの曲は1区間で終わる）
const AUDIO_CHUNK_SEC = 600;
const COPYABLE_VIDEO = ['h264', 'hevc'];

// 変換の進捗は、ダウンロードの進捗と同じストアに負のIDで載せる
export const liveIdForConversion = (id: number) => -id;

let running = false;
let currentJobId: string | null = null;
let stopRequest: 'pause' | 'cancel' | null = null;

class StoppedError extends Error {}

function workDirectory(id: number): Directory {
  const dir = new Directory(Paths.cache, `convert-${id}`);
  if (!dir.exists) dir.create({ intermediates: true });
  return dir;
}

function removeWorkDirectory(id: number) {
  const dir = new Directory(Paths.cache, `convert-${id}`);
  if (dir.exists) dir.delete();
}

async function setStatus(db: SQLiteDatabase, id: number, status: ConversionStatus, error: string | null = null) {
  await db.runAsync('UPDATE conversions SET status = ?, error = ? WHERE id = ?', status, error, id);
  notifyJobsChanged();
}

// 起動時・前面に戻ったとき・変換を追加したときに呼ぶ。同時に動くのは1つだけ
export async function runConversions(db: SQLiteDatabase) {
  if (running || !MediaTools) return;
  running = true;
  try {
    for (;;) {
      const job = await db.getFirstAsync<ConversionRow>(
        "SELECT * FROM conversions WHERE status IN ('running', 'pending') ORDER BY status = 'running' DESC, created_at ASC LIMIT 1",
      );
      if (!job) break;
      const outcome = await runOne(db, job);
      // バックグラウンドで時間切れになったら、前面に戻るまで待つ（AppState の監視から再開する）
      if (outcome === 'interrupted') break;
    }
  } finally {
    running = false;
  }
}

export async function pauseConversion(db: SQLiteDatabase, id: number) {
  if (currentJobId === String(id)) {
    stopRequest = 'pause';
    MediaTools?.cancel(String(id));
  } else {
    await setStatus(db, id, 'paused');
  }
}

export async function resumeConversion(db: SQLiteDatabase, id: number) {
  await setStatus(db, id, 'pending');
  runConversions(db);
}

export async function cancelConversion(db: SQLiteDatabase, id: number) {
  if (currentJobId === String(id)) {
    stopRequest = 'cancel';
    MediaTools?.cancel(String(id));
  } else {
    await db.runAsync('DELETE FROM conversions WHERE id = ?', id);
    removeWorkDirectory(id);
    notifyJobsChanged();
  }
}

// アプリがバックグラウンドから戻ったら、中断していた変換を再開する
AppState.addEventListener('change', (state) => {
  if (state === 'active' && pendingDb) runConversions(pendingDb);
});
let pendingDb: SQLiteDatabase | null = null;
export function watchConversions(db: SQLiteDatabase) {
  pendingDb = db;
  runConversions(db);
}

async function runOne(db: SQLiteDatabase, job: ConversionRow): Promise<'finished' | 'interrupted'> {
  const [item] = await getMediaByIds(db, [job.video_id]);
  if (!item) {
    await db.runAsync('DELETE FROM conversions WHERE id = ?', job.id);
    return 'finished';
  }
  const source = mediaFile(item.filePath);
  if (!source.exists) {
    await setStatus(db, job.id, 'error', '元のファイルが見つかりません。もう一度保存してください。');
    return 'finished';
  }
  const params = JSON.parse(job.params_json || '{}') as Params;
  await setStatus(db, job.id, 'running');
  const liveId = liveIdForConversion(job.id);
  setLiveProgress(liveId, { fraction: job.total_chunks ? job.done_chunks / job.total_chunks : 0, detail: '準備しています' });
  currentJobId = String(job.id);
  stopRequest = null;
  await activateKeepAwakeAsync('convert').catch(() => {});

  try {
    const probe = await MediaTools!.probe(source.uri);
    const output = await convertWithChunks(db, job, item, probe, params);
    await finish(db, job, item, params, output);
    await db.runAsync("UPDATE conversions SET status = 'done', progress = 1, error = NULL WHERE id = ?", job.id);
    removeWorkDirectory(job.id);
  } catch (e) {
    if (e instanceof StoppedError || stopRequest) {
      if (stopRequest === 'cancel') {
        await db.runAsync('DELETE FROM conversions WHERE id = ?', job.id);
        removeWorkDirectory(job.id);
      } else if (stopRequest === 'pause') {
        await setStatus(db, job.id, 'paused');
      } else {
        // バックグラウンドでの時間切れ。終わった区間は残っているので、前面に戻ったら続きから
        await setStatus(db, job.id, 'pending');
        return 'interrupted';
      }
    } else {
      await setStatus(db, job.id, 'error', e instanceof Error ? e.message : String(e));
    }
  } finally {
    currentJobId = null;
    stopRequest = null;
    setLiveProgress(liveId, null);
    deactivateKeepAwake('convert');
    notifyJobsChanged();
  }
  return 'finished';
}

// 変換して、できたファイル（作業ディレクトリ内）を返す
async function convertWithChunks(
  db: SQLiteDatabase,
  job: ConversionRow,
  item: MediaItem,
  probe: ProbeResult,
  params: Params,
): Promise<File> {
  const mode: ConvertMode = job.kind === 'm4a' ? 'm4a' : job.kind === 'mp3' ? 'mp3' : 'mp4';
  const ext = mode === 'mp4' ? 'mp4' : mode;
  const work = workDirectory(job.id);
  const source = mediaFile(item.filePath).uri;
  const liveId = liveIdForConversion(job.id);
  const title = mode === 'mp4' ? `「${item.title}」を変換しています` : `「${item.title}」の音声を書き出しています`;

  const rangeStart = job.kind === 'trim' ? Math.max(0, params.start ?? 0) : 0;
  const rangeEnd = job.kind === 'trim' ? Math.min(params.end ?? probe.durationSec, probe.durationSec || Infinity) : probe.durationSec;
  const length = Math.max(0, rangeEnd - rangeStart);

  // 再エンコードが要らないもの（入れ物の入れ替え・音声の取り出し）は1回で終わる
  const needsVideoEncode = mode === 'mp4' && probe.hasVideo && !COPYABLE_VIDEO.includes(probe.videoCodec);
  const needsAudioEncode = mode === 'mp3' ? probe.audioCodec !== 'mp3' : probe.hasAudio && probe.audioCodec !== 'aac';
  const isTrim = job.kind === 'trim';
  // 映像をコピーできるなら、音声だけ変換しても速いので1回で終える。区間に分けるのは映像の再エンコードと MP3 だけ
  const single = !isTrim && (length <= 0 || (mode === 'mp4' ? !needsVideoEncode : mode === 'm4a' || !needsAudioEncode));

  const run = async (options: ConvertOptions, onFraction: (f: number) => void) => {
    const sub = MediaTools!.addListener('onConvertProgress', (e) => {
      if (e.jobId === String(job.id)) onFraction(e.fraction);
    });
    try {
      const result = await MediaTools!.convert(String(job.id), { title, ...options });
      if (result === 'cancelled') throw new StoppedError();
    } finally {
      sub.remove();
    }
  };

  if (single) {
    const out = new File(work, `whole.${ext}`);
    if (out.exists) out.delete();
    await run({ input: source, output: out.uri, mode, audioBitrate: (params.bitrate ?? 192) * 1000 }, (f) => {
      setLiveProgress(liveId, { fraction: f, detail: `${Math.round(f * 100)}%` });
    });
    return out;
  }

  const chunkSec = mode === 'mp4' ? VIDEO_CHUNK_SEC : AUDIO_CHUNK_SEC;
  const total = Math.max(1, Math.ceil(length / chunkSec));
  if (job.total_chunks !== total) {
    // 区間の分け方が変わったら最初から（通常は初回だけ）
    await db.runAsync('UPDATE conversions SET total_chunks = ?, done_chunks = 0 WHERE id = ?', total, job.id);
    job.done_chunks = 0;
  }
  const chunkFile = (i: number) => new File(work, `chunk-${String(i).padStart(4, '0')}.${ext}`);

  for (let i = job.done_chunks; i < total; i++) {
    if (stopRequest) throw new StoppedError();
    const start = rangeStart + i * chunkSec;
    const end = Math.min(rangeEnd, start + chunkSec);
    const out = chunkFile(i);
    if (out.exists) out.delete();
    await run(
      {
        input: source,
        output: out.uri,
        mode,
        startSec: start,
        // 最後の区間は終わりまで（長さの誤差で末尾が欠けないように）
        endSec: i === total - 1 && !isTrim ? -1 : end,
        forceEncode: true,
        audioBitrate: (params.bitrate ?? 192) * 1000,
      },
      (f) => {
        const fraction = (i + f) / (total + 0.2);
        setLiveProgress(liveId, { fraction, detail: `${Math.round(fraction * 100)}%（${i + 1}/${total}区間）` });
      },
    );
    await db.runAsync('UPDATE conversions SET done_chunks = ?, progress = ? WHERE id = ?', i + 1, (i + 1) / (total + 0.2), job.id);
  }

  setLiveProgress(liveId, { fraction: total / (total + 0.2), detail: '仕上げています' });
  const joined = new File(work, `joined.${ext}`);
  if (joined.exists) joined.delete();
  if (total === 1) {
    chunkFile(0).move(joined);
  } else {
    const inputs = Array.from({ length: total }, (_, i) => chunkFile(i).uri);
    const result = await MediaTools!.concat(String(job.id), inputs, joined.uri);
    if (result === 'cancelled') throw new StoppedError();
  }
  return joined;
}

// できたファイルをライブラリに入れる
async function finish(db: SQLiteDatabase, job: ConversionRow, item: MediaItem, params: Params, output: File) {
  const ext = job.kind === 'm4a' ? 'm4a' : job.kind === 'mp3' ? 'mp3' : 'mp4';
  const size = output.size ?? null;

  const replace = job.kind === 'mp4' || (job.kind === 'trim' && params.replace);
  if (replace) {
    const fileName = `${item.id}-${Date.now()}.${ext}`;
    output.move(mediaFile(fileName));
    const old = mediaFile(item.filePath);
    if (old.exists) old.delete();
    await db.runAsync(
      'UPDATE videos SET file_path = ?, container = ?, size_bytes = ?, duration_sec = NULL, last_position_sec = 0 WHERE id = ?',
      fileName,
      ext,
      size,
      item.id,
    );
    await createThumbnail(db, { id: item.id, filePath: fileName, container: ext, thumbnailPath: item.thumbnailPath }).catch(() => null);
    return;
  }

  // 新しい項目として追加する（音声の書き出し・切り出しを別に保存）
  const isAudio = job.kind === 'm4a' || job.kind === 'mp3';
  const fileName = `${isAudio ? 'audio' : 'trim'}-${item.id}-${Date.now()}.${ext}`;
  output.move(mediaFile(fileName));
  const title = job.kind === 'trim' ? `${item.title}（切り出し）` : item.title;
  const inserted = await db.runAsync(
    `INSERT INTO videos (folder_id, media_type, title, file_path, container, size_bytes, source_page_url, manual_order, created_at)
     SELECT folder_id, ?, ?, ?, ?, ?, source_page_url, ?, ? FROM videos WHERE id = ?`,
    isAudio ? 'audio' : 'video',
    title.slice(0, 100),
    fileName,
    ext,
    size,
    await nextManualOrder(db, item.folderId),
    Date.now(),
    item.id,
  );
  if (!isAudio) {
    await createThumbnail(db, { id: inserted.lastInsertRowId, filePath: fileName, container: ext, thumbnailPath: null }).catch(() => null);
  }
  if (isAudio && params.removeSource) {
    // ダウンロード時に「音声のみ」を選んだ場合は、元の動画を残さない
    const old = mediaFile(item.filePath);
    if (old.exists) old.delete();
    if (item.thumbnailPath) {
      const thumb = mediaFile(item.thumbnailPath);
      if (thumb.exists) thumb.delete();
    }
    await db.runAsync('UPDATE downloads SET video_id = ? WHERE video_id = ?', inserted.lastInsertRowId, item.id);
    await db.runAsync('DELETE FROM conversions WHERE video_id = ? AND id != ?', item.id, job.id);
    await db.runAsync('DELETE FROM videos WHERE id = ?', item.id);
  }
}
