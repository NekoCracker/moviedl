// ブラウザのブックマーク・タブ・履歴（feature-spec.md §2-7）
import type { SQLiteDatabase } from 'expo-sqlite';

export const START_PAGE_URL = 'about:start';
export const MAX_TABS = 20;

export type Bookmark = { id: number; title: string; url: string; sortOrder: number };
export type BrowserTab = { id: number; url: string; title: string | null; isPrivate: boolean; isActive: boolean };
export type HistoryEntry = { id: number; title: string | null; url: string; visitedAt: number };

// ---- ブックマーク ----

export async function listBookmarks(db: SQLiteDatabase): Promise<Bookmark[]> {
  return db.getAllAsync<Bookmark>(
    'SELECT id, title, url, sort_order AS sortOrder FROM bookmarks ORDER BY sort_order, id',
  );
}

export async function findBookmarkByUrl(db: SQLiteDatabase, url: string): Promise<Bookmark | null> {
  return db.getFirstAsync<Bookmark>('SELECT id, title, url, sort_order AS sortOrder FROM bookmarks WHERE url = ?', url);
}

export async function addBookmark(db: SQLiteDatabase, title: string, url: string) {
  const row = await db.getFirstAsync<{ next: number }>('SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM bookmarks');
  await db.runAsync(
    'INSERT INTO bookmarks (title, url, sort_order, created_at) VALUES (?, ?, ?, ?)',
    title.trim() || url,
    url,
    row?.next ?? 1,
    Date.now(),
  );
}

export async function updateBookmark(db: SQLiteDatabase, id: number, title: string, url: string) {
  await db.runAsync('UPDATE bookmarks SET title = ?, url = ? WHERE id = ?', title.trim() || url, url, id);
}

export async function deleteBookmark(db: SQLiteDatabase, id: number) {
  await db.runAsync('DELETE FROM bookmarks WHERE id = ?', id);
}

// 隣のブックマークと並び順を入れ替える
export async function moveBookmark(db: SQLiteDatabase, id: number, direction: -1 | 1) {
  const list = await listBookmarks(db);
  const index = list.findIndex((b) => b.id === id);
  const other = list[index + direction];
  if (index < 0 || !other) return;
  await db.withTransactionAsync(async () => {
    // sort_order が重複していても確実に入れ替わるよう、位置を振り直す
    const reordered = [...list];
    [reordered[index], reordered[index + direction]] = [reordered[index + direction], reordered[index]];
    for (let i = 0; i < reordered.length; i++) {
      await db.runAsync('UPDATE bookmarks SET sort_order = ? WHERE id = ?', i + 1, reordered[i].id);
    }
  });
}

// ---- タブ ----

type TabRow = { id: number; url: string; title: string | null; is_private: number; is_active: number };
const toTab = (r: TabRow): BrowserTab => ({
  id: r.id,
  url: r.url,
  title: r.title,
  isPrivate: r.is_private === 1,
  isActive: r.is_active === 1,
});

// 起動時に呼ぶ。プライベートタブはアプリを終了したら残さない。
export async function loadTabs(db: SQLiteDatabase): Promise<BrowserTab[]> {
  await db.runAsync('DELETE FROM tabs WHERE is_private = 1');
  let rows = await db.getAllAsync<TabRow>('SELECT * FROM tabs ORDER BY sort_order, id');
  if (rows.length === 0) {
    await openTab(db, START_PAGE_URL, false);
    rows = await db.getAllAsync<TabRow>('SELECT * FROM tabs ORDER BY sort_order, id');
  }
  if (!rows.some((r) => r.is_active === 1)) {
    await activateTab(db, rows[rows.length - 1].id);
    rows = await db.getAllAsync<TabRow>('SELECT * FROM tabs ORDER BY sort_order, id');
  }
  return rows.map(toTab);
}

export async function listTabs(db: SQLiteDatabase): Promise<BrowserTab[]> {
  const rows = await db.getAllAsync<TabRow>('SELECT * FROM tabs ORDER BY sort_order, id');
  return rows.map(toTab);
}

// 新しいタブを開いてアクティブにする。上限に達していたら null。
export async function openTab(db: SQLiteDatabase, url: string, isPrivate: boolean): Promise<number | null> {
  const count = await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM tabs');
  if ((count?.n ?? 0) >= MAX_TABS) return null;
  const order = await db.getFirstAsync<{ next: number }>('SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM tabs');
  let id = 0;
  await db.withTransactionAsync(async () => {
    await db.runAsync('UPDATE tabs SET is_active = 0');
    const result = await db.runAsync(
      'INSERT INTO tabs (url, is_private, sort_order, is_active, updated_at) VALUES (?, ?, ?, 1, ?)',
      url,
      isPrivate ? 1 : 0,
      order?.next ?? 1,
      Date.now(),
    );
    id = result.lastInsertRowId;
  });
  return id;
}

export async function activateTab(db: SQLiteDatabase, id: number) {
  await db.withTransactionAsync(async () => {
    await db.runAsync('UPDATE tabs SET is_active = 0');
    await db.runAsync('UPDATE tabs SET is_active = 1 WHERE id = ?', id);
  });
}

export async function updateTabPage(db: SQLiteDatabase, id: number, url: string, title: string | null) {
  await db.runAsync('UPDATE tabs SET url = ?, title = ?, updated_at = ? WHERE id = ?', url, title, Date.now(), id);
}

// タブを閉じる。閉じたのがアクティブなら隣をアクティブにし、最後の1枚なら開始ページを開く。
export async function closeTab(db: SQLiteDatabase, id: number) {
  const tabs = await listTabs(db);
  const index = tabs.findIndex((t) => t.id === id);
  if (index < 0) return;
  await db.runAsync('DELETE FROM tabs WHERE id = ?', id);
  const rest = tabs.filter((t) => t.id !== id);
  if (rest.length === 0) {
    await openTab(db, START_PAGE_URL, false);
  } else if (tabs[index].isActive) {
    await activateTab(db, rest[Math.min(index, rest.length - 1)].id);
  }
}

export async function closeAllTabs(db: SQLiteDatabase, isPrivate: boolean) {
  await db.runAsync('DELETE FROM tabs WHERE is_private = ?', isPrivate ? 1 : 0);
  const rest = await listTabs(db);
  if (rest.length === 0) {
    await openTab(db, START_PAGE_URL, false);
  } else if (!rest.some((t) => t.isActive)) {
    await activateTab(db, rest[rest.length - 1].id);
  }
}

// ---- 履歴 ----

export async function addHistory(db: SQLiteDatabase, url: string, title: string | null) {
  // 同じページを続けて読み込んだ（リロード等）ときは1件にまとめる
  const last = await db.getFirstAsync<{ id: number; url: string }>('SELECT id, url FROM history ORDER BY visited_at DESC, id DESC LIMIT 1');
  if (last && last.url === url) {
    await db.runAsync('UPDATE history SET title = COALESCE(?, title), visited_at = ? WHERE id = ?', title, Date.now(), last.id);
    return;
  }
  await db.runAsync('INSERT INTO history (title, url, visited_at) VALUES (?, ?, ?)', title, url, Date.now());
}

export async function listHistory(db: SQLiteDatabase, search = '', limit = 500): Promise<HistoryEntry[]> {
  const like = `%${search.trim()}%`;
  return db.getAllAsync<HistoryEntry>(
    `SELECT id, title, url, visited_at AS visitedAt FROM history
     WHERE (? = '' OR title LIKE ? OR url LIKE ?)
     ORDER BY visited_at DESC, id DESC LIMIT ?`,
    search.trim(),
    like,
    like,
    limit,
  );
}

export async function deleteHistoryEntry(db: SQLiteDatabase, id: number) {
  await db.runAsync('DELETE FROM history WHERE id = ?', id);
}

// sinceMs より新しい履歴を削除する（null ならすべて）
export async function clearHistory(db: SQLiteDatabase, sinceMs: number | null) {
  if (sinceMs == null) {
    await db.runAsync('DELETE FROM history');
  } else {
    await db.runAsync('DELETE FROM history WHERE visited_at >= ?', sinceMs);
  }
}
