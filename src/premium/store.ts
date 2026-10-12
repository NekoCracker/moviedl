// プレミアム（サブスク・買い切り）の状態と、購入画面の表示（feature-spec.md §3）
import { useSyncExternalStore } from 'react';

export type PremiumFeature = 'ads' | 'folderPasscode' | 'trim' | 'thumbnail';

type State = { isPremium: boolean; paywall: PremiumFeature | 'settings' | null; devOverride: boolean | null };

let state: State = { isPremium: false, paywall: null, devOverride: null };
// 実際の購入状態。開発ビルドの切り替え（devOverride）が入っていればそちらを優先する
let purchased = false;
const listeners = new Set<() => void>();

function set(next: Partial<State>) {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePremiumState(): State {
  return useSyncExternalStore(subscribe, () => state);
}

export function usePremium(): boolean {
  return usePremiumState().isPremium;
}

export function isPremiumNow(): boolean {
  return state.isPremium;
}

export function setPremium(isPremium: boolean) {
  purchased = isPremium;
  const effective = state.devOverride ?? purchased;
  if (state.isPremium !== effective) set({ isPremium: effective });
}

// 開発ビルドでの動作確認用。null で実際の購入状態に戻す
export function setDevPremiumOverride(value: boolean | null) {
  if (!__DEV__) return;
  set({ devOverride: value, isPremium: value ?? purchased });
}

export function openPaywall(reason: PremiumFeature | 'settings') {
  set({ paywall: reason });
}

export function closePaywall() {
  set({ paywall: null });
}

// プレミアムなら true。そうでなければ購入画面を開いて false。
export function requirePremium(feature: PremiumFeature): boolean {
  if (state.isPremium) return true;
  openPaywall(feature);
  return false;
}
