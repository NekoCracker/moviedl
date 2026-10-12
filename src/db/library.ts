import type { SQLiteDatabase } from 'expo-sqlite';

import { UNSORTED_FOLDER_ID } from './schema';

export type MediaType = 'video' | 'audio';

export type FolderSummary = {
  id: number;
  name: string;
  hasPasscode: boolean;
  isSystem: boolean;
  itemCount: number;
  totalBytes: number;
  coverThumbnail: string | null;
};

export type MediaItem = {
  id: number;
  folderId: number;
  mediaType: MediaType;
  title: string;
  filePath: string;
  thumbnailPath: string | null;
  container: string | null;
  durationSec: number | null;
  sizeBytes: number | null;
  lastPositionSec: number;
  createdAt: number;
};

export type SortKey = 'created_at' | 'title' | 'duration_sec' | 'size_bytes' | 'last_played_at' | 'manual_order';
export type SortDir = 'asc' | 'desc';

// 「すべての動画」は保存されたフォルダではなく、全件を表示する仮想フォルダ
export const ALL_FOLDER_ID = 0;

type FolderRow = {
  id: number;
  name: string;
  has_passcode: number;
  is_system: number;
  item_count: number;
  total_bytes: number | null;
  cover_thumbnail: string | null;
};

export async function listFolders(db: SQLiteDatabase, mediaType: MediaType): Promise<FolderSummary[]> {
  const rows = await db.getAllAsync<FolderRow>(
    `SELECT f.id, f.name, f.has_passcode, f.is_system,
            COUNT(v.id) AS item_count,
            SUM(v.size_bytes) AS total_bytes,
            (SELECT thumbnail_path FROM videos
              WHERE folder_id = f.id AND media_type = ? AND thumbnail_path IS NOT NULL
              ORDER BY created_at DESC LIMIT 1) AS cover_thumbnail
       FROM folders f
       LEFT JOIN videos v ON v.folder_id = f.id AND v.media_type = ?
      GROUP BY f.id
      ORDER BY f.is_system DESC, f.sort_order ASC, f.id ASC`,
    mediaType,
    mediaType,
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    hasPasscode: r.has_passcode === 1,
    isSystem: r.is_system === 1,
    itemCount: r.item_count,
    totalBytes: r.total_bytes ?? 0,
    coverThumbnail: r.cover_thumbnail,
  }));
}

export async function getFolderName(db: SQLiteDatabase, folderId: number): Promise<string | null> {
  if (folderId === ALL_FOLDER_ID) {
    return 'すべて';
  }
  const row = await db.getFirstAsync<{ name: string }>('SELECT name FROM folders WHERE id = ?', folderId);
  return row?.name ?? null;
}

export async function createFolder(db: SQLiteDatabase, name: string): Promise<number> {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error('フォルダ名を入力してください');
  }
  const max = await db.getFirstAsync<{ m: number | null }>('SELECT MAX(sort_order) AS m FROM folders');
  const result = await db.runAsync(
    'INSERT INTO folders (name, sort_order, created_at) VALUES (?, ?, ?)',
    trimmed.slice(0, 50),
    (max?.m ?? 0) + 1,
    Date.now(),
  );
  return result.lastInsertRowId;
}

export async function renameFolder(db: SQLiteDatabase, folderId: number, name: string) {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error('フォルダ名を入力してください');
  }
  await db.runAsync('UPDATE folders SET name = ? WHERE id = ? AND is_system = 0', trimmed.slice(0, 50), folderId);
}

// 中の動画は「未分類」へ移す。ファイルごと消す場合は呼び出し側で先に動画を削除する。
export async function deleteFolder(db: SQLiteDatabase, folderId: number) {
  await db.withTransactionAsync(async () => {
    await db.runAsync('UPDATE videos SET folder_id = ? WHERE folder_id = ?', UNSORTED_FOLDER_ID, folderId);
    await db.runAsync('DELETE FROM folders WHERE id = ? AND is_system = 0', folderId);
  });
}

const sortColumns: Record<SortKey, string> = {
  created_at: 'created_at',
  title: 'title COLLATE NOCASE',
  duration_sec: 'duration_sec',
  size_bytes: 'size_bytes',
  last_played_at: 'last_played_at',
  manual_order: 'manual_order',
};

type MediaRow = {
  id: number;
  folder_id: number;
  media_type: MediaType;
  title: string;
  file_path: string;
  thumbnail_path: string | null;
  container: string | null;
  duration_sec: number | null;
  size_bytes: number | null;
  last_position_sec: number;
  created_at: number;
};

export async function listMedia(
  db: SQLiteDatabase,
  folderId: number,
  mediaType: MediaType,
  sort: { key: SortKey; dir: SortDir },
  search = '',
): Promise<MediaItem[]> {
  const where = ['media_type = ?'];
  const params: (string | number)[] = [mediaType];
  if (folderId !== ALL_FOLDER_ID) {
    where.push('folder_id = ?');
    params.push(folderId);
  } else {
    // ロック中のフォルダは「すべて」に含めない
    where.push('folder_id NOT IN (SELECT id FROM folders WHERE has_passcode = 1)');
  }
  if (search.trim()) {
    where.push('title LIKE ?');
    params.push(`%${search.trim()}%`);
  }
  const dir = sort.dir === 'asc' ? 'ASC' : 'DESC';
  const rows = await db.getAllAsync<MediaRow>(
    `SELECT * FROM videos WHERE ${where.join(' AND ')} ORDER BY ${sortColumns[sort.key]} ${dir}, id DESC`,
    ...params,
  );
  return rows.map((r) => ({
    id: r.id,
    folderId: r.folder_id,
    mediaType: r.media_type,
    title: r.title,
    filePath: r.file_path,
    thumbnailPath: r.thumbnail_path,
    container: r.container,
    durationSec: r.duration_sec,
    sizeBytes: r.size_bytes,
    lastPositionSec: r.last_position_sec,
    createdAt: r.created_at,
  }));
}

export async function renameMedia(db: SQLiteDatabase, id: number, title: string) {
  const trimmed = title.trim();
  if (!trimmed) {
    throw new Error('タイトルを入力してください');
  }
  await db.runAsync('UPDATE videos SET title = ? WHERE id = ?', trimmed.slice(0, 100), id);
}

export async function moveMedia(db: SQLiteDatabase, ids: number[], folderId: number) {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(',');
  await db.runAsync(`UPDATE videos SET folder_id = ? WHERE id IN (${placeholders})`, folderId, ...ids);
}

export async function getLibraryTotals(db: SQLiteDatabase, mediaType: MediaType) {
  const row = await db.getFirstAsync<{ c: number; b: number | null }>(
    'SELECT COUNT(*) AS c, SUM(size_bytes) AS b FROM videos WHERE media_type = ?',
    mediaType,
  );
  return { count: row?.c ?? 0, bytes: row?.b ?? 0 };
}
