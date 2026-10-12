// パスコードを忘れたときの初期化（feature-spec.md §2-1）。
// サーバーがなく本人確認できないので、ロックされたフォルダの動画も含めて保存したものをすべて消す。
// ブックマーク・閲覧履歴・課金状態は残す
import { Directory, Paths } from 'expo-file-system';
import type { SQLiteDatabase } from 'expo-sqlite';

import { cancelConversion } from '@/convert/engine';
import { saveSetting } from '@/db/settings';
import { cancelJob } from '@/download/engine';
import { notifyJobsChanged } from '@/download/store';
import { appPasscode, folderPasscode } from '@/security/passcode';

export async function resetAllData(db: SQLiteDatabase) {
  // 進行中のダウンロード・変換を止める
  const downloads = await db.getAllAsync<{ id: number }>("SELECT id FROM downloads WHERE status IN ('downloading', 'queued', 'converting')");
  for (const d of downloads) await cancelJob(db, d.id);
  const conversions = await db.getAllAsync<{ id: number }>("SELECT id FROM conversions WHERE status IN ('running', 'pending')");
  for (const c of conversions) await cancelConversion(db, c.id);

  const folders = await db.getAllAsync<{ id: number }>('SELECT id FROM folders');
  for (const f of folders) await folderPasscode.clear(f.id).catch(() => {});
  await appPasscode.clear().catch(() => {});

  await db.withExclusiveTransactionAsync(async (tx) => {
    await tx.runAsync('DELETE FROM conversions');
    await tx.runAsync('DELETE FROM downloads');
    await tx.runAsync('DELETE FROM videos');
    await tx.runAsync('DELETE FROM folders WHERE is_system = 0');
    await tx.runAsync('UPDATE folders SET has_passcode = 0');
  });
  await saveSetting(db, 'appLockEnabled', false);

  // ファイルは最後に消す（DB だけ残ってファイルが無い状態にしない）
  const media = new Directory(Paths.document, 'media');
  if (media.exists) media.delete();
  notifyJobsChanged();
}
