import type { SQLiteDatabase } from 'expo-sqlite';

export type AppSettings = {
  appLockEnabled: boolean;
  biometricsEnabled: boolean;
  // バックグラウンドから戻ったときにロックするまでの秒数
  lockAfterSec: 0 | 60 | 300;
  backgroundVideoAudio: boolean;
  rememberPlaybackRate: boolean;
  lastPlaybackRate: number;
  folderSort: 'manual' | 'name' | 'created';
  // mp3 で保存・書き出しするときの音質（kbps）
  mp3Bitrate: 128 | 192 | 320;
  // MP4 に変換するときの画質（ビットレート）
  convertQuality: 'high' | 'standard' | 'small';
};

const defaults: AppSettings = {
  appLockEnabled: false,
  biometricsEnabled: true,
  lockAfterSec: 0,
  backgroundVideoAudio: true,
  rememberPlaybackRate: true,
  lastPlaybackRate: 1,
  folderSort: 'manual',
  mp3Bitrate: 192,
  convertQuality: 'standard',
};

export async function loadSettings(db: SQLiteDatabase): Promise<AppSettings> {
  const rows = await db.getAllAsync<{ key: string; value: string }>('SELECT key, value FROM settings');
  const stored = Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value)]));
  return { ...defaults, ...stored };
}

export async function saveSetting<K extends keyof AppSettings>(db: SQLiteDatabase, key: K, value: AppSettings[K]) {
  await db.runAsync(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    key,
    JSON.stringify(value),
  );
}
