// 実行中ダウンロードの進捗を画面に流すための小さなストア。DBへの書き込みは間引き、表示はここから読む。
import { useSyncExternalStore } from 'react';

export type LiveProgress = {
  // 0〜1
  fraction: number;
  detail: string;
};

let snapshot: Record<number, LiveProgress> = {};
const listeners = new Set<() => void>();

export function setLiveProgress(id: number, progress: LiveProgress | null) {
  const next = { ...snapshot };
  if (progress) {
    next[id] = progress;
  } else {
    delete next[id];
  }
  snapshot = next;
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useLiveProgress(): Record<number, LiveProgress> {
  return useSyncExternalStore(subscribe, () => snapshot);
}

// ジョブの状態がDB上で変わったことを一覧画面に知らせる
const changeListeners = new Set<() => void>();

export function notifyJobsChanged() {
  changeListeners.forEach((l) => l());
}

export function onJobsChanged(listener: () => void) {
  changeListeners.add(listener);
  return () => {
    changeListeners.delete(listener);
  };
}
