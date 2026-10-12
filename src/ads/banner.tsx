// 無料版のライブラリ画面・ブラウザ画面の下に出すバナー広告（feature-spec.md §3）。プレミアムなら出さない
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';
import { SymbolView } from 'expo-symbols';
import { BannerAd, BannerAdSize, TestIds } from 'react-native-google-mobile-ads';

import { initAds } from '@/ads/download-ad';
import { openPaywall, usePremium } from '@/premium/store';
import { colors } from '@/theme';

// 本番の広告ユニットIDは EAS の環境変数で渡す。未設定の本番ビルドでは出さない
const UNIT_ID = process.env.EXPO_PUBLIC_ADMOB_BANNER_IOS || (__DEV__ ? TestIds.ADAPTIVE_BANNER : '');

// closable: 右端に「広告を消す」ボタンを付ける（押すとプレミアムの案内を開く）。広告の上には重ねない
export function AdBanner({ closable = false }: { closable?: boolean }) {
  const premium = usePremium();
  const { width } = useWindowDimensions();
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
  if (closable) {
    return (
      <View style={[styles.container, styles.row]}>
        <BannerAd
          unitId={UNIT_ID}
          size={BannerAdSize.ANCHORED_ADAPTIVE_BANNER}
          width={width - CLOSE_WIDTH}
          onAdFailedToLoad={() => setFailed(true)}
        />
        <Pressable accessibilityRole="button" accessibilityLabel="広告を消す" onPress={() => openPaywall('ads')} style={styles.close}>
          <SymbolView name="xmark.circle.fill" tintColor={colors.textMuted} size={22} />
        </Pressable>
      </View>
    );
  }
  return (
    <View style={styles.container}>
      <BannerAd unitId={UNIT_ID} size={BannerAdSize.ANCHORED_ADAPTIVE_BANNER} onAdFailedToLoad={() => setFailed(true)} />
    </View>
  );
}

const CLOSE_WIDTH = 40;

const styles = StyleSheet.create({
  container: { alignItems: 'center', backgroundColor: colors.background },
  row: { flexDirection: 'row', backgroundColor: '#000' },
  close: { width: CLOSE_WIDTH, alignSelf: 'stretch', alignItems: 'center', justifyContent: 'center' },
});
