// ダウンロードの実行エンジン。DBの downloads テーブルを待ち行列として、1件ずつ順番に処理する。
// DRM・暗号化されたHLSは中止し 'blocked' にする（feature-spec.md §0）。
import { File, type DownloadTask } from 'expo-file-system';
import type { SQLiteDatabase } from 'expo-sqlite';

import type { DetectedKind } from '@/browser/detector';
import { UNSORTED_FOLDER_ID } from '@/db/schema';
import type { DownloadOutput } from '@/db/downloads';
import { parsePlaylist, pickVariant, type HlsMediaPlaylist } from './hls';
import { mediaFile, removeTempDirectory, tempDirectory } from './storage';
import { notifyJobsChanged, setLiveProgress } from './store';

type JobRow = {
  id: number;
  source_url: string;
  page_url: string | null;
  title: string | null;
  kind: DetectedKind;
  quality: string | null;
  output: DownloadOutput;
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
  let done = parts.filter((p) => new File(temp, p.name).exists).length;
  let next = 0;
  const report = () =>
    setLiveProgress(job.id, { fraction: done / parts.length, detail: `${done} / ${parts.length} 区間` });
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
  const inserted = await db.runAsync(
    `INSERT INTO videos (folder_id, media_type, title, file_path, container, duration_sec, size_bytes, source_page_url, created_at)
     VALUES (?, 'video', ?, ?, ?, ?, ?, ?, ?)`,
    UNSORTED_FOLDER_ID,
    job.title || '無題の動画',
    result.fileName,
    result.container,
    result.durationSec,
    result.sizeBytes,
    job.page_url,
    Date.now(),
  );
  const videoId = inserted.lastInsertRowId;

  // 音声のみの保存や、iOSで直接再生できない形式は変換待ちに積む（変換はネイティブモジュールで実装予定）
  const conversion = job.output === 'm4a' || job.output === 'mp3' ? job.output : result.container === 'ts' ? 'mp4' : null;
  if (conversion) {
    await db.runAsync(
      "INSERT INTO conversions (video_id, kind, status, created_at) VALUES (?, ?, 'pending', ?)",
      videoId,
      conversion,
      Date.now(),
    );
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
