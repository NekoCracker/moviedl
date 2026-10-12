// VLC の再生位置。1秒に何度も変わるので Context には載せず、使う画面だけが購読する
let currentTime = 0;
const listeners = new Set<() => void>();

export function setVlcTime(seconds: number) {
  if (seconds === currentTime) return;
  currentTime = seconds;
  listeners.forEach((l) => l());
}

export function getVlcTime() {
  return currentTime;
}

export function subscribeVlcTime(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// VLC のプレイヤーは1つだけなので、編集画面のプレビューが一時的に借りる。
// 借りている間、再生キュー側は VLC のイベントを無視し、返されたあとの再生時に読み込み直す
let borrowed = false;
let generation = 0;

export function borrowVlc(): () => void {
  borrowed = true;
  generation++;
  return () => {
    borrowed = false;
  };
}

export function vlcBorrowed() {
  return borrowed;
}

export function vlcGeneration() {
  return generation;
}
