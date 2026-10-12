import { queueIncomingFile } from '@/library/incoming';

// file:// で開かれたとき（ファイルアプリの「このアプリで開く」）は画面遷移せず、取り込みに回す
export function redirectSystemPath({ path, initial }: { path: string; initial: boolean }) {
  try {
    if (path.startsWith('file://')) {
      queueIncomingFile(path);
      return initial ? '/' : null;
    }
  } catch {
    // ここで例外を出すとアプリが落ちるので、そのまま通す
  }
  return path;
}
