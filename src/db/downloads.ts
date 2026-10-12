import type { SQLiteDatabase } from 'expo-sqlite';

import type { DetectedKind } from '@/browser/detector';

export type DownloadOutput = 'video' | 'm4a' | 'mp3';

export type DownloadStatus =
  | 'queued'
  | 'downloading'
  | 'paused'
  | 'converting'
  | 'done'
  | 'error'
  // DRM・暗号化を検出して中止したもの
  | 'blocked';

export async function enqueueDownload(
  db: SQLiteDatabase,
  input: { sourceUrl: string; pageUrl: string; title: string; kind: DetectedKind; output: DownloadOutput },
): Promise<number> {
  const result = await db.runAsync(
    `INSERT INTO downloads (source_url, page_url, title, kind, output, status, progress, created_at)
     VALUES (?, ?, ?, ?, ?, 'queued', 0, ?)`,
    input.sourceUrl,
    input.pageUrl,
    input.title.slice(0, 100),
    input.kind,
    input.output,
    Date.now(),
  );
  return result.lastInsertRowId;
}
