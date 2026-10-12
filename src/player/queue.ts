// 再生キューの順番を決める純粋な関数（feature-spec.md §2-4、§2-14）

export type LoopMode = 'off' | 'one' | 'all';

// Fisher-Yates。start を先頭に固定し、残りをシャッフルする。
export function shuffledOrder<T>(items: T[], startIndex: number, random: () => number = Math.random): T[] {
  if (items.length === 0) return [];
  const rest = items.filter((_, i) => i !== startIndex);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  return [items[startIndex], ...rest];
}

// 再生が終わったときの次の位置。null なら停止。
export function indexAfterEnd(current: number, length: number, loop: LoopMode): number | null {
  if (length === 0) return null;
  if (loop === 'one') return current;
  if (current + 1 < length) return current + 1;
  return loop === 'all' ? 0 : null;
}

// 「次へ」ボタン。最後なら先頭に戻る（ループがオフでも手動操作は止めない）
export function indexForNext(current: number, length: number): number {
  return length === 0 ? 0 : (current + 1) % length;
}

// 「前へ」ボタン。3秒以上再生していたら同じ曲の頭に戻る（一般的な音楽プレイヤーと同じ挙動）
export function indexForPrevious(current: number, length: number, positionSec: number): number {
  if (positionSec > 3 || length === 0) return current;
  return (current - 1 + length) % length;
}

export function nextLoopMode(mode: LoopMode): LoopMode {
  return mode === 'off' ? 'all' : mode === 'all' ? 'one' : 'off';
}

export const loopLabels: Record<LoopMode, string> = { off: 'オフ', all: '全体', one: '1本' };

export const playbackRates = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;
