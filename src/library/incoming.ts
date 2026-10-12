// ファイルアプリなどの「このアプリで開く」で渡されたファイル（feature-spec.md §2-15）。
// +native-intent で受け取り、DB が使える画面側（IncomingFiles）で取り込む
const pending: string[] = [];
const listeners = new Set<() => void>();

export function queueIncomingFile(uri: string) {
  pending.push(uri);
  listeners.forEach((l) => l());
}

export function takeIncomingFiles(): string[] {
  return pending.splice(0, pending.length);
}

export function onIncomingFiles(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
