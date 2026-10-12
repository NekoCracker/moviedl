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

// ほかの画面からブラウザでURLを開く（ダウンロード画面の「元のサイト」など）。
// ブラウザ画面がまだ作られていないこともあるので、開くURLを預けておき、ブラウザ側で受け取る
let pendingUrl: string | null = null;
const openListeners = new Set<() => void>();

export function requestOpenInBrowser(url: string) {
  pendingUrl = url;
  openListeners.forEach((l) => l());
}

export function takePendingBrowserUrl(): string | null {
  const url = pendingUrl;
  pendingUrl = null;
  return url;
}

export function onOpenInBrowserRequested(listener: () => void) {
  openListeners.add(listener);
  return () => {
    openListeners.delete(listener);
  };
}
