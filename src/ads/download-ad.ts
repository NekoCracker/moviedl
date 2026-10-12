// 無料版でダウンロードを始めるときに出す動画広告（AdMob インタースティシャル。feature-spec.md §3）
// 広告が5秒以内に用意できなければ、広告なしでダウンロードを始める。
import { getTrackingPermissionsAsync, requestTrackingPermissionsAsync } from 'expo-tracking-transparency';
import mobileAds, { AdEventType, InterstitialAd, TestIds } from 'react-native-google-mobile-ads';

import { isPremiumNow } from '@/premium/store';

// 本番の広告ユニットIDは EAS の環境変数で渡す。未設定の本番ビルドでは広告を出さない（誤ってテスト広告を出さないため）
const UNIT_ID = process.env.EXPO_PUBLIC_ADMOB_INTERSTITIAL_IOS || (__DEV__ ? TestIds.INTERSTITIAL : '');
const LOAD_TIMEOUT_MS = 5000;

let ad: InterstitialAd | null = null;
let initialized: Promise<void> | null = null;

function ensureAd(): InterstitialAd | null {
  if (!UNIT_ID) return null;
  if (!ad) {
    ad = InterstitialAd.createForAdRequest(UNIT_ID);
    ad.addAdEventListener(AdEventType.ERROR, () => {
      // 読み込み失敗。次のダウンロード時にもう一度読み込む
    });
  }
  return ad;
}

// 起動時に呼ぶ。トラッキング許可（ATT）を確認してからSDKを初期化し、最初の広告を読み込んでおく
export function initAds(): Promise<void> {
  if (initialized) return initialized;
  initialized = (async () => {
    if (isPremiumNow() || !UNIT_ID) return;
    try {
      const current = await getTrackingPermissionsAsync();
      if (current.canAskAgain && current.status === 'undetermined') {
        await requestTrackingPermissionsAsync();
      }
    } catch {
      // ATT が使えない環境でも広告は（パーソナライズなしで）出せる
    }
    await mobileAds().initialize();
    ensureAd()?.load();
  })().catch(() => {});
  return initialized;
}

function waitForLoad(target: InterstitialAd, timeoutMs: number): Promise<boolean> {
  if (target.loaded) return Promise.resolve(true);
  return new Promise((resolve) => {
    const cleanups: (() => void)[] = [];
    const done = (value: boolean) => {
      cleanups.forEach((c) => c());
      resolve(value);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    cleanups.push(() => clearTimeout(timer));
    cleanups.push(target.addAdEventListener(AdEventType.LOADED, () => done(true)));
    cleanups.push(target.addAdEventListener(AdEventType.ERROR, () => done(false)));
    target.load();
  });
}

// ダウンロード開始前に呼ぶ。広告を閉じる（または出せない）まで待つ。プレミアムなら何もしない
export async function showDownloadAd(): Promise<void> {
  if (isPremiumNow()) return;
  await initAds();
  const target = ensureAd();
  if (!target) return;
  if (!(await waitForLoad(target, LOAD_TIMEOUT_MS))) return;

  await new Promise<void>((resolve) => {
    const cleanups: (() => void)[] = [];
    const done = () => {
      cleanups.forEach((c) => c());
      resolve();
    };
    cleanups.push(target.addAdEventListener(AdEventType.CLOSED, done));
    cleanups.push(target.addAdEventListener(AdEventType.ERROR, done));
    target.show().catch(done);
  });
  // 次の広告を先に読み込んでおく
  target.load();
}
