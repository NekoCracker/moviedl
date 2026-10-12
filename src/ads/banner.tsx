// 無料版のライブラリ画面・ブラウザ画面の下に出すバナー広告（feature-spec.md §3）。プレミアムなら出さない
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { BannerAd, BannerAdSize, TestIds } from 'react-native-google-mobile-ads';

import { initAds } from '@/ads/download-ad';
import { usePremium } from '@/premium/store';
import { colors } from '@/theme';

// 本番の広告ユニットIDは EAS の環境変数で渡す。未設定の本番ビルドでは出さない
const UNIT_ID = process.env.EXPO_PUBLIC_ADMOB_BANNER_IOS || (__DEV__ ? TestIds.ADAPTIVE_BANNER : '');

export function AdBanner() {
  const premium = usePremium();
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (premium || !UNIT_ID) return;
    let cancelled = false;
    initAds().then(() => {
      if (!cancelled) setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [premium]);

  if (premium || !UNIT_ID || !ready || failed) return null;
  return (
    <View style={styles.container}>
      <BannerAd unitId={UNIT_ID} size={BannerAdSize.ANCHORED_ADAPTIVE_BANNER} onAdFailedToLoad={() => setFailed(true)} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { alignItems: 'center', backgroundColor: colors.background },
});
