// 保存済み動画への操作: 削除・カメラロールへコピー・ファイルからの取り込み・サムネイル作成・変換の予約
import * as DocumentPicker from 'expo-document-picker';
import { Directory, File } from 'expo-file-system';
import * as MediaLibrary from 'expo-media-library';
import type { SQLiteDatabase } from 'expo-sqlite';
import * as VideoThumbnails from 'expo-video-thumbnails';
import { MediaTools } from 'media-tools';

import { nextManualOrder, type MediaItem, type MediaType } from '@/db/library';
import { mediaDirectory, mediaFile } from '@/download/storage';
import { notifyJobsChanged } from '@/download/store';

// iOS 標準（AVFoundation / expo-video）で扱える形式。それ以外は VLCKit で再生し、写真アプリへは MP4 変換が必要
export const NATIVE_VIDEO_CONTAINERS = ['mp4', 'm4v', 'mov'];
export const NATIVE_CONTAINERS = [...NATIVE_VIDEO_CONTAINERS, 'm4a', 'mp3'];
const AUDIO_EXTENSIONS = ['mp3', 'm4a', 'aac', 'wav', 'aif', 'aiff', 'flac', 'ogg', 'opus', 'caf'];
const VIDEO_EXTENSIONS = ['mp4', 'm4v', 'mov', 'webm', 'mkv', 'flv', 'avi', 'ts', 'wmv', '3gp', 'mpg', 'mpeg'];

const THUMBS_DIR = 'thumbs';

function thumbsDirectory(): Directory {
  const dir = new Directory(mediaDirectory(), THUMBS_DIR);
  if (!dir.exists) dir.create({ intermediates: true });
  return dir;
}

export function thumbnailUri(relativePath: string | null): string | null {
  return relativePath ? mediaFile(relativePath).uri : null;
}

// ---- 削除 ----

export async function deleteMediaItems(db: SQLiteDatabase, items: MediaItem[]) {
  for (const item of items) {
    for (const rel of [item.filePath, item.thumbnailPath]) {
      if (!rel) continue;
      try {
        const file = mediaFile(rel);
        if (file.exists) file.delete();
      } catch {
        // ファイルが既にない場合もDBからは消す
      }
    }
  }
  const ids = items.map((i) => i.id);
  if (ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(',');
  await db.withTransactionAsync(async () => {
    // foreign_keys は接続ごとの設定なので、関連行は明示的に片付ける
    await db.runAsync(`DELETE FROM conversions WHERE video_id IN (${placeholders})`, ...ids);
    await db.runAsync(`UPDATE downloads SET video_id = NULL WHERE video_id IN (${placeholders})`, ...ids);
    await db.runAsync(`DELETE FROM videos WHERE id IN (${placeholders})`, ...ids);
  });
}

// ---- カメラロール ----

export type CameraRollResult = { saved: number; needsConversion: MediaItem[] };

export async function saveToCameraRoll(items: MediaItem[]): Promise<CameraRollResult> {
  const savable = items.filter((i) => i.mediaType === 'video' && NATIVE_VIDEO_CONTAINERS.includes(i.container ?? ''));
  const needsConversion = items.filter((i) => i.mediaType === 'video' && !savable.includes(i));
  if (savable.length === 0) return { saved: 0, needsConversion };

  // 追加のみの許可（写真の読み取りは求めない）
  const permission = await MediaLibrary.requestPermissionsAsync(true);
  if (!permission.granted) {
    throw new Error('写真への追加が許可されていません。設定アプリ →「動画保存」→「写真」で「追加のみ」を許可してください。');
  }
  let saved = 0;
  for (const item of savable) {
    await MediaLibrary.Asset.create(mediaFile(item.filePath).uri);
    saved++;
  }
  return { saved, needsConversion };
}

// ---- 変換の予約（処理はネイティブモジュール側で行う。feature-spec.md §2-12・§2-13） ----

export async function queueConversion(db: SQLiteDatabase, videoId: number, kind: 'mp4' | 'm4a' | 'mp3' | 'trim', params: Record<string, unknown> = {}) {
  const existing = await db.getFirstAsync<{ id: number }>(
    "SELECT id FROM conversions WHERE video_id = ? AND kind = ? AND status IN ('pending', 'running', 'paused')",
    videoId,
    kind,
  );
  if (existing) return false;
  await db.runAsync(
    "INSERT INTO conversions (video_id, kind, params_json, status, created_at) VALUES (?, ?, ?, 'pending', ?)",
    videoId,
    kind,
    JSON.stringify(params),
    Date.now(),
  );
  return true;
}

// ---- サムネイル ----

// 動画の timeSec 秒の場面をサムネイルにする。iOS 標準で読めない形式は VLCKit 側で作る（未対応の間は null）
export async function createThumbnail(
  db: SQLiteDatabase,
  item: Pick<MediaItem, 'id' | 'filePath' | 'container' | 'thumbnailPath'> & { mediaType?: MediaType },
  timeSec = 1,
): Promise<string | null> {
  if (item.mediaType === 'audio') return null;
  // 同じ名前だと expo-image のキャッシュで古い画像が出るので、作るたびに名前を変える
  const rel = `${THUMBS_DIR}/${item.id}-${Date.now()}.jpg`;
  thumbsDirectory();
  const source = mediaFile(item.filePath).uri;
  const time = Math.max(0, timeSec);
  let made = false;
  if (NATIVE_VIDEO_CONTAINERS.includes(item.container ?? '')) {
    try {
      // 指定した時刻が長さを超える短い動画では失敗するので、そのときは先頭で作り直す
      const result = await VideoThumbnails.getThumbnailAsync(source, { time: time * 1000, quality: 0.7 }).catch(() =>
        VideoThumbnails.getThumbnailAsync(source, { time: 0, quality: 0.7 }),
      );
      new File(result.uri).move(mediaFile(rel));
      made = true;
    } catch {
      // iOS 標準で読めないもの（MP4 でも中身が特殊なもの）は FFmpeg で作る
    }
  }
  if (!made && MediaTools) {
    // WebM・MKV など iOS 標準で読めない形式は FFmpeg で1フレーム取り出す
    await MediaTools.thumbnail(source, time, 640, mediaFile(rel).uri);
    made = true;
  }
  if (!made) return null;
  if (item.thumbnailPath) {
    try {
      const old = mediaFile(item.thumbnailPath);
      if (old.exists) old.delete();
    } catch {
      // 古いサムネイルが消せなくても続ける
    }
  }
  await db.runAsync('UPDATE videos SET thumbnail_path = ? WHERE id = ?', rel, item.id);
  notifyJobsChanged();
  return rel;
}

// ---- ファイルアプリからの取り込み ----

function extensionOf(name: string): string {
  const m = /\.([a-z0-9]{1,5})$/i.exec(name);
  return m ? m[1].toLowerCase() : '';
}

export type ImportResult = { imported: number; skipped: string[] };

export async function importFromFiles(db: SQLiteDatabase, folderId: number, preferredType: MediaType): Promise<ImportResult | null> {
  const picked = await DocumentPicker.getDocumentAsync({
    type: preferredType === 'audio' ? ['public.audio'] : ['public.movie', 'public.audio', 'public.mpeg-2-transport-stream', 'org.webmproject.webm', 'org.matroska.mkv', 'public.data'],
    multiple: true,
    copyToCacheDirectory: true,
  });
  if (picked.canceled) return null;

  return importFiles(db, folderId, picked.assets);
}

// 一時ファイル（キャッシュ内）をライブラリに移して登録する。ファイルピッカーと「このアプリで開く」で共通
export async function importFiles(
  db: SQLiteDatabase,
  folderId: number,
  assets: { uri: string; name: string; size?: number | null }[],
): Promise<ImportResult> {
  let imported = 0;
  const skipped: string[] = [];
  for (const [index, asset] of assets.entries()) {
    const ext = extensionOf(asset.name);
    const mediaType: MediaType | null = AUDIO_EXTENSIONS.includes(ext) ? 'audio' : VIDEO_EXTENSIONS.includes(ext) ? 'video' : null;
    if (!mediaType) {
      skipped.push(asset.name);
      continue;
    }
    const fileName = `import-${Date.now()}-${index}.${ext}`;
    const source = new File(asset.uri);
    source.move(mediaFile(fileName));
    const title = asset.name.replace(/\.[^.]+$/, '') || '無題';
    const result = await db.runAsync(
      `INSERT INTO videos (folder_id, media_type, title, file_path, container, size_bytes, manual_order, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      folderId,
      mediaType,
      title.slice(0, 100),
      fileName,
      ext,
      asset.size ?? mediaFile(fileName).size ?? null,
      await nextManualOrder(db, folderId),
      Date.now(),
    );
    if (mediaType === 'video') {
      createThumbnail(db, { id: result.lastInsertRowId, filePath: fileName, container: ext, thumbnailPath: null }).catch(() => {});
    }
    imported++;
  }
  return { imported, skipped };
}
