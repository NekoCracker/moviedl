// 設定画面で閲覧データを消したことをブラウザ画面に伝える
type Cleared = { detected: boolean };
const listeners = new Set<(cleared: Cleared) => void>();

export function notifyBrowsingDataCleared(cleared: Cleared) {
  listeners.forEach((l) => l(cleared));
}

export function onBrowsingDataCleared(listener: (cleared: Cleared) => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
