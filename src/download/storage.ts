import { Directory, File, Paths } from 'expo-file-system';
import { MediaTools } from 'media-tools';

// iOS ではアプリ更新でサンドボックスの絶対パスが変わるため、DBには media/ からの相対パスだけを保存する。
const MEDIA_DIR = 'media';
let backupExcluded = false;

export function mediaDirectory(): Directory {
  const dir = new Directory(Paths.document, MEDIA_DIR);
  if (!dir.exists) {
    dir.create({ intermediates: true });
  }
  if (!backupExcluded) {
    // 動画は大きいので iCloud バックアップに含めない（フォルダに付ければ中身すべてに効く）
    try {
      MediaTools?.excludeFromBackup(dir.uri);
      backupExcluded = MediaTools != null;
    } catch {
      // 次の呼び出しでもう一度試す
    }
  }
  return dir;
}

export function mediaFile(relativeName: string): File {
  return new File(mediaDirectory(), relativeName);
}

export function tempDirectory(jobId: number): Directory {
  const dir = new Directory(Paths.cache, `download-${jobId}`);
  if (!dir.exists) {
    dir.create({ intermediates: true });
  }
  return dir;
}

export function removeTempDirectory(jobId: number) {
  const dir = new Directory(Paths.cache, `download-${jobId}`);
  if (dir.exists) {
    dir.delete();
  }
}
