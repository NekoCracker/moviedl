import type { SQLiteDatabase } from 'expo-sqlite';

// フォルダ「未分類」の固定ID。削除不可。
export const UNSORTED_FOLDER_ID = 1;

const DATABASE_VERSION = 3;

// SQLiteProvider の onInit から呼ばれる。PRAGMA user_version でスキーマの版を管理する。
export async function migrateDbIfNeeded(db: SQLiteDatabase) {
  const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  let currentVersion = row?.user_version ?? 0;
  if (currentVersion >= DATABASE_VERSION) {
    return;
  }

  if (currentVersion === 0) {
    await db.execAsync(`
      PRAGMA journal_mode = 'wal';
      PRAGMA foreign_keys = ON;

      CREATE TABLE folders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        sort_key TEXT NOT NULL DEFAULT 'created_at',
        sort_dir TEXT NOT NULL DEFAULT 'desc',
        has_passcode INTEGER NOT NULL DEFAULT 0,
        is_system INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE videos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        folder_id INTEGER NOT NULL REFERENCES folders(id),
        media_type TEXT NOT NULL CHECK (media_type IN ('video', 'audio')),
        title TEXT NOT NULL,
        file_path TEXT NOT NULL,
        thumbnail_path TEXT,
        container TEXT,
        duration_sec REAL,
        size_bytes INTEGER,
        source_page_url TEXT,
        last_position_sec REAL NOT NULL DEFAULT 0,
        last_played_at INTEGER,
        manual_order INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX idx_videos_folder ON videos(folder_id, media_type);

      CREATE TABLE downloads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        video_id INTEGER REFERENCES videos(id) ON DELETE SET NULL,
        source_url TEXT NOT NULL,
        page_url TEXT,
        title TEXT,
        kind TEXT NOT NULL,
        quality TEXT,
        output TEXT NOT NULL DEFAULT 'video',
        -- 保存先フォルダ（NULL なら「未分類」）
        folder_id INTEGER,
        status TEXT NOT NULL,
        progress REAL NOT NULL DEFAULT 0,
        error TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE conversions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        video_id INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('mp4', 'm4a', 'mp3', 'trim')),
        params_json TEXT NOT NULL DEFAULT '{}',
        total_chunks INTEGER NOT NULL DEFAULT 0,
        done_chunks INTEGER NOT NULL DEFAULT 0,
        -- pending / running / paused / done / error
        status TEXT NOT NULL,
        progress REAL NOT NULL DEFAULT 0,
        error TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE bookmarks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        url TEXT NOT NULL,
        favicon_path TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE tabs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        url TEXT NOT NULL,
        title TEXT,
        snapshot_path TEXT,
        is_private INTEGER NOT NULL DEFAULT 0,
        sort_order INTEGER NOT NULL DEFAULT 0,
        is_active INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT,
        url TEXT NOT NULL,
        visited_at INTEGER NOT NULL
      );
      CREATE INDEX idx_history_visited ON history(visited_at);

      CREATE TABLE settings (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
      );
    `);
    await db.runAsync(
      'INSERT INTO folders (id, name, sort_order, is_system, created_at) VALUES (?, ?, 0, 1, ?)',
      UNSORTED_FOLDER_ID,
      '未分類',
      Date.now(),
    );
    currentVersion = 1;
  }

  if (currentVersion === 1) {
    // ダウンロード中の一覧に、ページの動画のポスター画像を出す
    await db.execAsync('ALTER TABLE downloads ADD COLUMN poster_url TEXT');
    currentVersion = 2;
  }

  if (currentVersion === 2) {
    // カメラロールから写真も追加できるようにする。SQLite は CHECK 制約を変えられないので表を作り直す。
    // 作り直しの間に関連する行（変換など）が消えないよう、外部キーを止めてから行う
    await db.execAsync('PRAGMA foreign_keys = OFF');
    await db.withTransactionAsync(async () => {
      await db.execAsync(`
        CREATE TABLE videos_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          folder_id INTEGER NOT NULL REFERENCES folders(id),
          media_type TEXT NOT NULL CHECK (media_type IN ('video', 'audio', 'photo')),
          title TEXT NOT NULL,
          file_path TEXT NOT NULL,
          thumbnail_path TEXT,
          container TEXT,
          duration_sec REAL,
          size_bytes INTEGER,
          source_page_url TEXT,
          last_position_sec REAL NOT NULL DEFAULT 0,
          last_played_at INTEGER,
          manual_order INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL
        );
        INSERT INTO videos_new (id, folder_id, media_type, title, file_path, thumbnail_path, container, duration_sec, size_bytes,
                                source_page_url, last_position_sec, last_played_at, manual_order, created_at)
          SELECT id, folder_id, media_type, title, file_path, thumbnail_path, container, duration_sec, size_bytes,
                 source_page_url, last_position_sec, last_played_at, manual_order, created_at FROM videos;
        DROP TABLE videos;
        ALTER TABLE videos_new RENAME TO videos;
        CREATE INDEX idx_videos_folder ON videos(folder_id, media_type);
      `);
    });
    currentVersion = 3;
  }

  await db.execAsync(`PRAGMA user_version = ${DATABASE_VERSION}`);
}
