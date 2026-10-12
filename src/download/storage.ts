import { Directory, File, Paths } from 'expo-file-system';

// iOS ではアプリ更新でサンドボックスの絶対パスが変わるため、DBには media/ からの相対パスだけを保存する。
const MEDIA_DIR = 'media';

export function mediaDirectory(): Directory {
  const dir = new Directory(Paths.document, MEDIA_DIR);
  if (!dir.exists) {
    dir.create({ intermediates: true });
  }
  // TODO: ネイティブモジュールで isExcludedFromBackup を付け、iCloudバックアップから外す（feature-spec.md 追加の注意点）
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
