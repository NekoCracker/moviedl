// アプリ内課金（RevenueCat）。買い切り（980円）だけで「premium」の権利を付ける（feature-spec.md §3）
import Purchases, { PACKAGE_TYPE, type CustomerInfo, type PurchasesPackage } from 'react-native-purchases';

import { setPremium } from '@/premium/store';

const ENTITLEMENT_ID = 'premium';
// RevenueCat の iOS 用公開APIキー（appl_ で始まる）。.env または EAS の環境変数で渡す
const API_KEY = process.env.EXPO_PUBLIC_REVENUECAT_IOS_KEY ?? '';

let configured = false;

function applyCustomerInfo(info: CustomerInfo) {
  setPremium(info.entitlements.active[ENTITLEMENT_ID] != null);
}

export function purchasesAvailable(): boolean {
  return configured;
}

export async function initPurchases() {
  if (configured || !API_KEY) return;
  try {
    Purchases.configure({ apiKey: API_KEY });
    configured = true;
    Purchases.addCustomerInfoUpdateListener(applyCustomerInfo);
    applyCustomerInfo(await Purchases.getCustomerInfo());
  } catch {
    // オフライン等。RevenueCat は前回の購入状態を端末に保持しているので、次の更新で反映される
  }
}

// 買い切りの商品。RevenueCat の current offering に Lifetime パッケージとして登録しておく
export async function loadLifetime(): Promise<PurchasesPackage | null> {
  if (!configured) return null;
  const offerings = await Purchases.getOfferings();
  const packages = offerings.current?.availablePackages ?? [];
  return packages.find((p) => p.packageType === PACKAGE_TYPE.LIFETIME) ?? null;
}

export type PurchaseOutcome = 'purchased' | 'cancelled' | 'pending';

export async function purchase(pkg: PurchasesPackage): Promise<PurchaseOutcome> {
  try {
    const { customerInfo } = await Purchases.purchasePackage(pkg);
    applyCustomerInfo(customerInfo);
    return customerInfo.entitlements.active[ENTITLEMENT_ID] ? 'purchased' : 'pending';
  } catch (e) {
    if ((e as { userCancelled?: boolean }).userCancelled) return 'cancelled';
    throw e;
  }
}

// 復元できたら true
export async function restore(): Promise<boolean> {
  const info = await Purchases.restorePurchases();
  applyCustomerInfo(info);
  return info.entitlements.active[ENTITLEMENT_ID] != null;
}
