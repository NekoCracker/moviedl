// ダウンロードの実行エンジン。DBの downloads テーブルを待ち行列として、1件ずつ順番に処理する。
// DRM・暗号化されたHLSは中止し 'blocked' にする（feature-spec.md §0）。
import { File, type DownloadTask } from 'expo-file-system';
import type { SQLiteDatabase } from 'expo-sqlite';

import type { DetectedKind } from '@/browser/detector';
import { nextManualOrder } from '@/db/library';
import { UNSORTED_FOLDER_ID } from '@/db/schema';
import type { DownloadOutput } from '@/db/downloads';
import { loadSettings } from '@/db/settings';
import { runConversions } from '@/convert/engine';
import { createThumbnail } from '@/library/media-actions';
import { parsePlaylist, pickVariant, type HlsMediaPlaylist } from './hls';
import { mediaFile, removeTempDirectory, tempDirectory } from './storage';
import { notifyJobsChanged, setLiveProgress } from './store';
import { notifyFinished } from '@/notifications';

type JobRow = {
  id: number;
  source_url: string;
  page_url: string | null;
  title: string | null;
  kind: DetectedKind;
  quality: string | null;
  output: DownloadOutput;
  folder_id: number | null;
};

class BlockedError extends Error {}
class PausedError extends Error {}

const SEGMENT_CONCURRENCY = 4;

let running = false;
let currentJobId: number | null = null;
let currentTask: DownloadTask | null = null;
let stopRequest: 'pause' | 'cancel' | null = null;

function headersFor(job: JobRow): Record<string, string> {
  return job.page_url ? { Referer: job.page_url } : {};
}

async function setStatus(db: SQLiteDatabase, id: number, status: string, extra: { progress?: number; error?: string | null } = {}) {
  await db.runAsync(
    'UPDATE downloads SET status = ?, progress = COALESCE(?, progress), error = ? WHERE id = ?',
    status,
    extra.progress ?? null,
    extra.error ?? null,
    id,
  );
  notifyJobsChanged();
}

function checkStop() {
  if (stopRequest === 'pause') throw new PausedError();
  if (stopRequest === 'cancel') throw new PausedError('cancel');
}

// 待ち行列を処理する。すでに動いていれば何もしない。
export async function runQueue(db: SQLiteDatabase) {
  if (running) return;
  running = true;
  try {
    for (;;) {
      const job = await db.getFirstAsync<JobRow>(
        "SELECT * FROM downloads WHERE status IN ('queued', 'downloading') ORDER BY created_at ASC LIMIT 1",
      );
      if (!job) break;
      await processJob(db, job);
    }
  } finally {
    running = false;
  }
}

export function pauseJob(db: SQLiteDatabase, id: number) {
  if (currentJobId === id) {
    stopRequest = 'pause';
    currentTask?.pause();
  } else {
    setStatus(db, id, 'paused');
  }
}

export async function resumeJob(db: SQLiteDatabase, id: number) {
  await setStatus(db, id, 'queued');
  runQueue(db);
}

export async function cancelJob(db: SQLiteDatabase, id: number) {
  if (currentJobId === id) {
    stopRequest = 'cancel';
    currentTask?.cancel();
  } else {
    await db.runAsync('DELETE FROM downloads WHERE id = ?', id);
    removeTempDirectory(id);
    notifyJobsChanged();
  }
}

async function processJob(db: SQLiteDatabase, job: JobRow) {
  currentJobId = job.id;
  stopRequest = null;
  await setStatus(db, job.id, 'downloading');
  try {
    const result = job.kind === 'hls' ? await downloadHls(job) : await downloadFile(job);
    const videoId = await registerMedia(db, job, result);
    await db.runAsync("UPDATE downloads SET status = 'done', progress = 1, video_id = ? WHERE id = ?", videoId, job.id);
    removeTempDirectory(job.id);
    // 音声のみ・MPEG-TS は続けて変換するので、通知は変換が終わったときに出す
    if (job.output === 'video' && result.container !== 'ts') {
      notifyFinished('ダウンロードが完了しました', job.title ?? '動画を保存しました');
    }
  } catch (e) {
    // task.cancel()/pause() は downloadAsync を通常のエラーで終わらせることがあるので、停止要求を優先して見る
    if (stopRequest !== null || e instanceof PausedError) {
      if (stopRequest === 'cancel' || (e instanceof PausedError && e.message === 'cancel')) {
        await db.runAsync('DELETE FROM downloads WHERE id = ?', job.id);
        removeTempDirectory(job.id);
      } else {
        await setStatus(db, job.id, 'paused');
      }
    } else if (e instanceof BlockedError) {
      await setStatus(db, job.id, 'blocked', { error: e.message });
      removeTempDirectory(job.id);
    } else {
      await setStatus(db, job.id, 'error', { error: e instanceof Error ? e.message : String(e) });
    }
  } finally {
    currentJobId = null;
    currentTask = null;
    stopRequest = null;
    setLiveProgress(job.id, null);
    notifyJobsChanged();
  }
}

type DownloadResult = { fileName: string; container: string; sizeBytes: number; durationSec: number | null };

async function downloadFile(job: JobRow): Promise<DownloadResult> {
  const container = guessContainer(job.source_url) ?? 'mp4';
  const fileName = `${job.id}.${container}`;
  const dest = mediaFile(fileName);
  // 一時停止後の再開は最初から落とし直す（区間単位で再開できるのはHLSのみ）
  if (dest.exists) dest.delete();
  const task = File.createDownloadTask(job.source_url, dest, {
    headers: headersFor(job),
    onProgress: ({ bytesWritten, totalBytes }) => {
      const fraction = totalBytes > 0 ? bytesWritten / totalBytes : 0;
      setLiveProgress(job.id, {
        fraction,
        detail: totalBytes > 0 ? `${mb(bytesWritten)} / ${mb(totalBytes)}` : mb(bytesWritten),
      });
    },
  });
  currentTask = task;
  const file = await task.downloadAsync();
  checkStop();
  if (!file) throw new PausedError();
  return { fileName, container, sizeBytes: file.size, durationSec: null };
}

async function fetchText(url: string, job: JobRow): Promise<string> {
  const res = await fetch(url, { headers: headersFor(job) });
  if (!res.ok) throw new Error(`プレイリストを取得できませんでした（${res.status}）`);
  return res.text();
}

async function resolveMediaPlaylist(job: JobRow): Promise<HlsMediaPlaylist> {
  const first = parsePlaylist(await fetchText(job.source_url, job), job.source_url);
  if (first.type === 'media') return first.playlist;
  const maxHeight = job.quality ? parseInt(job.quality, 10) : null;
  const variant = pickVariant(first.variants, Number.isFinite(maxHeight) ? maxHeight : null);
  if (!variant) throw new Error('再生可能な画質が見つかりませんでした');
  const second = parsePlaylist(await fetchText(variant.url, job), variant.url);
  if (second.type !== 'media') throw new Error('プレイリストの形式に対応していません');
  return second.playlist;
}

async function downloadHls(job: JobRow): Promise<DownloadResult> {
  const playlist = await resolveMediaPlaylist(job);
  if (playlist.encrypted) {
    throw new BlockedError('この動画は保護（DRM・暗号化）されているため保存できません');
  }
  if (playlist.live) {
    throw new BlockedError('ライブ配信は保存できません');
  }
  if (playlist.segments.length === 0) {
    throw new Error('動画のデータが見つかりませんでした');
  }

  const temp = tempDirectory(job.id);
  const parts = [
    ...(playlist.initUrl ? [{ url: playlist.initUrl, name: 'init' }] : []),
    ...playlist.segments.map((s, i) => ({ url: s.url, name: `seg-${String(i).padStart(6, '0')}` })),
  ];

  // 途中まで落とした区間はスキップして再開する
  let done = 0;
  let bytes = 0;
  for (const p of parts) {
    const f = new File(temp, p.name);
    if (f.exists) {
      done++;
      bytes += f.size;
    }
  }
  let next = 0;
  // 全体の大きさは最初に分からないので、落とし終えた区間の平均から見積もる
  const report = () =>
    setLiveProgress(job.id, {
      fraction: done / parts.length,
      detail: done > 0 ? `${mb(bytes)} / 約 ${mb((bytes / done) * parts.length)}` : mb(0),
    });
  report();

  const worker = async () => {
    for (;;) {
      checkStop();
      const index = next++;
      if (index >= parts.length) return;
      const part = parts[index];
      const target = new File(temp, part.name);
      if (target.exists) continue;
      const partial = new File(temp, `${part.name}.part`);
      await File.downloadFileAsync(part.url, partial, { headers: headersFor(job), idempotent: true });
      partial.move(target);
      done++;
      bytes += target.size;
      report();
    }
  };
  await Promise.all(Array.from({ length: SEGMENT_CONCURRENCY }, worker));
  checkStop();

  // 区間を1本のファイルに連結する。fMP4 は .mp4、MPEG-TS は .ts（MP4化は変換処理で行う）
  const container = playlist.initUrl ? 'mp4' : 'ts';
  const fileName = `${job.id}.${container}`;
  const output = mediaFile(fileName);
  if (output.exists) output.delete();
  output.create();
  const handle = output.open();
  try {
    for (const part of parts) {
      handle.writeBytes(await new File(temp, part.name).bytes());
    }
  } finally {
    handle.close();
  }
  return { fileName, container, sizeBytes: output.size, durationSec: playlist.totalDurationSec };
}

async function registerMedia(db: SQLiteDatabase, job: JobRow, result: DownloadResult): Promise<number> {
  // 保存先のフォルダがダウンロード中に削除されていたら「未分類」へ
  const folder = job.folder_id
    ? await db.getFirstAsync<{ id: number }>('SELECT id FROM folders WHERE id = ?', job.folder_id)
    : null;
  const folderId = folder?.id ?? UNSORTED_FOLDER_ID;
  const inserted = await db.runAsync(
    `INSERT INTO videos (folder_id, media_type, title, file_path, container, duration_sec, size_bytes, source_page_url, manual_order, created_at)
     VALUES (?, 'video', ?, ?, ?, ?, ?, ?, ?, ?)`,
    folderId,
    job.title || '無題の動画',
    result.fileName,
    result.container,
    result.durationSec,
    result.sizeBytes,
    job.page_url,
    await nextManualOrder(db, folderId),
    Date.now(),
  );
  const videoId = inserted.lastInsertRowId;
  createThumbnail(db, { id: videoId, filePath: result.fileName, container: result.container, thumbnailPath: null }).catch(() => {
    // サムネイルが作れなくても保存は成功扱い
  });

  // 音声のみの保存と、MPEG-TS（HLSの一部）はMP4への変換に回す。WebM などはそのまま VLC で再生する
  const conversion = job.output === 'm4a' || job.output === 'mp3' ? job.output : result.container === 'ts' ? 'mp4' : null;
  if (conversion) {
    // 「音声のみ」で保存したものは、音声を書き出したあと元の動画を消す
    const params = conversion === 'mp4' ? {} : { removeSource: true, bitrate: (await loadSettings(db)).mp3Bitrate };
    await db.runAsync(
      "INSERT INTO conversions (video_id, kind, params_json, status, created_at) VALUES (?, ?, ?, 'pending', ?)",
      videoId,
      conversion,
      JSON.stringify(params),
      Date.now(),
    );
    runConversions(db);
  }
  return videoId;
}

function guessContainer(url: string): string | null {
  const match = url.split(/[?#]/)[0].match(/\.([a-z0-9]{2,4})$/i);
  return match ? match[1].toLowerCase() : null;
}

function mb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
