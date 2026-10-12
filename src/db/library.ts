import type { SQLiteDatabase } from 'expo-sqlite';

import { UNSORTED_FOLDER_ID } from './schema';

// photo はカメラロールから追加した写真。「動画」の一覧に一緒に並ぶ（再生の対象にはならない）
export type MediaType = 'video' | 'audio' | 'photo';

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
              WHERE folder_id = f.id AND media_type IN (?, ?) AND thumbnail_path IS NOT NULL
              ORDER BY created_at DESC LIMIT 1) AS cover_thumbnail
       FROM folders f
       LEFT JOIN videos v ON v.folder_id = f.id AND v.media_type IN (?, ?)
      GROUP BY f.id
      ORDER BY f.is_system DESC, f.sort_order ASC, f.id ASC`,
    ...typesFor(mediaType),
    ...typesFor(mediaType),
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

// 「動画」の一覧（フォルダの数・表紙）には写真も含める
function typesFor(mediaType: MediaType): [MediaType, MediaType] {
  return mediaType === 'video' ? ['video', 'photo'] : [mediaType, mediaType];
}

// includePhotos: 「動画」の一覧に写真も並べる（再生キューを作るときは false）
export async function listMedia(
  db: SQLiteDatabase,
  folderId: number,
  mediaType: MediaType,
  sort: { key: SortKey; dir: SortDir },
  search = '',
  includePhotos = false,
): Promise<MediaItem[]> {
  const types = includePhotos ? typesFor(mediaType) : [mediaType, mediaType];
  const where = ['media_type IN (?, ?)'];
  const params: (string | number)[] = [...types];
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
  return rows.map(toMediaItem);
}

function toMediaItem(r: MediaRow): MediaItem {
  return {
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
  };
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

export async function savePlaybackPosition(db: SQLiteDatabase, id: number, positionSec: number) {
  await db.runAsync(
    'UPDATE videos SET last_position_sec = ?, last_played_at = ? WHERE id = ?',
    positionSec,
    Date.now(),
    id,
  );
}

// ---- フォルダの並び替え ----

export type FolderSort = 'manual' | 'name' | 'created';

export async function listFoldersSorted(db: SQLiteDatabase, mediaType: MediaType, sort: FolderSort): Promise<FolderSummary[]> {
  const list = await listFolders(db, mediaType);
  if (sort === 'manual') return list;
  const system = list.filter((f) => f.isSystem);
  const rest = list.filter((f) => !f.isSystem);
  if (sort === 'name') {
    rest.sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  } else {
    rest.sort((a, b) => b.id - a.id);
  }
  return [...system, ...rest];
}

// 手動並び替え: 隣のフォルダと入れ替える（システムフォルダは動かさない）
export async function moveFolder(db: SQLiteDatabase, folderId: number, direction: -1 | 1) {
  const rows = await db.getAllAsync<{ id: number }>(
    'SELECT id FROM folders WHERE is_system = 0 ORDER BY sort_order ASC, id ASC',
  );
  const index = rows.findIndex((r) => r.id === folderId);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= rows.length) return;
  [rows[index], rows[target]] = [rows[target], rows[index]];
  await db.withTransactionAsync(async () => {
    for (let i = 0; i < rows.length; i++) {
      await db.runAsync('UPDATE folders SET sort_order = ? WHERE id = ?', i + 1, rows[i].id);
    }
  });
}

export async function setFolderHasPasscode(db: SQLiteDatabase, folderId: number, hasPasscode: boolean) {
  await db.runAsync('UPDATE folders SET has_passcode = ? WHERE id = ? AND is_system = 0', hasPasscode ? 1 : 0, folderId);
}

export async function folderHasPasscode(db: SQLiteDatabase, folderId: number): Promise<boolean> {
  const row = await db.getFirstAsync<{ has_passcode: number }>('SELECT has_passcode FROM folders WHERE id = ?', folderId);
  return row?.has_passcode === 1;
}

// フォルダごとに動画の並び順を記憶する（「すべて」は settings に保存）
export async function getFolderSort(db: SQLiteDatabase, folderId: number): Promise<{ key: SortKey; dir: SortDir }> {
  if (folderId === ALL_FOLDER_ID) {
    const row = await db.getFirstAsync<{ value: string }>("SELECT value FROM settings WHERE key = 'allFolderSort'");
    return row ? (JSON.parse(row.value) as { key: SortKey; dir: SortDir }) : { key: 'created_at', dir: 'desc' };
  }
  const row = await db.getFirstAsync<{ sort_key: SortKey; sort_dir: SortDir }>('SELECT sort_key, sort_dir FROM folders WHERE id = ?', folderId);
  return row ? { key: row.sort_key, dir: row.sort_dir } : { key: 'created_at', dir: 'desc' };
}

export async function setFolderSort(db: SQLiteDatabase, folderId: number, sort: { key: SortKey; dir: SortDir }) {
  if (folderId === ALL_FOLDER_ID) {
    await db.runAsync(
      "INSERT INTO settings (key, value) VALUES ('allFolderSort', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      JSON.stringify(sort),
    );
    return;
  }
  await db.runAsync('UPDATE folders SET sort_key = ?, sort_dir = ? WHERE id = ?', sort.key, sort.dir, folderId);
}

// ---- 動画の手動並び替え ----

export async function moveMediaManual(db: SQLiteDatabase, folderId: number, mediaType: MediaType, id: number, direction: -1 | 1) {
  // 一覧に見えている順（動画の一覧なら写真も含む）で入れ替える
  const items = await listMedia(db, folderId, mediaType, { key: 'manual_order', dir: 'asc' }, '', true);
  const index = items.findIndex((m) => m.id === id);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= items.length) return;
  [items[index], items[target]] = [items[target], items[index]];
  await db.withTransactionAsync(async () => {
    for (let i = 0; i < items.length; i++) {
      await db.runAsync('UPDATE videos SET manual_order = ? WHERE id = ?', i + 1, items[i].id);
    }
  });
}

export async function getMediaByIds(db: SQLiteDatabase, ids: number[]): Promise<MediaItem[]> {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  const rows = await db.getAllAsync<MediaRow>(`SELECT * FROM videos WHERE id IN (${placeholders})`, ...ids);
  return rows.map(toMediaItem);
}

export async function saveMediaDuration(db: SQLiteDatabase, id: number, durationSec: number) {
  await db.runAsync('UPDATE videos SET duration_sec = ? WHERE id = ? AND duration_sec IS NULL', durationSec, id);
}

// 新しく保存・取り込みした動画は、手動並びの末尾に置く
export async function nextManualOrder(db: SQLiteDatabase, folderId: number): Promise<number> {
  const row = await db.getFirstAsync<{ m: number | null }>('SELECT MAX(manual_order) AS m FROM videos WHERE folder_id = ?', folderId);
  return (row?.m ?? 0) + 1;
}
