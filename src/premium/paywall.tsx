import { SymbolView, type SFSymbol } from 'expo-symbols';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Linking, Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppText } from '@/components/app-text';
import { PRIVACY_URL, TERMS_URL } from '@/config/links';
import { type PurchasesPackage } from 'react-native-purchases';

import { loadLifetime, purchase, purchasesAvailable, restore } from '@/premium/purchases';
import { closePaywall, usePremiumState } from '@/premium/store';
import { colors, radius } from '@/theme';

const perks: { title: string; desc: string; icon: SFSymbol }[] = [
  { title: '広告をすべて削除', desc: 'ダウンロード時の動画広告も表示されません', icon: 'nosign' },
  { title: 'フォルダにパスワード', desc: 'フォルダごとにロックを設定', icon: 'lock' },
  { title: '動画のトリミング', desc: '必要な部分だけを切り出して保存', icon: 'scissors' },
  { title: 'サムネイルを選べる', desc: '動画の好きな場面をサムネイルに', icon: 'photo' },
];

// 購入画面。ルートに1つだけ置き、openPaywall() で開く。
export function PaywallHost() {
  const { paywall, isPremium } = usePremiumState();
  const visible = paywall != null && !isPremium;
  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={closePaywall}>
      {visible ? <Paywall /> : null}
    </Modal>
  );
}

function Paywall() {
  const insets = useSafeAreaInsets();
  const [lifetime, setLifetime] = useState<PurchasesPackage | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    loadLifetime()
      .then((p) => !cancelled && setLifetime(p))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const price = lifetime?.product.priceString ?? '¥980';

  const onPurchase = async () => {
    const pkg = lifetime;
    if (!purchasesAvailable() || !pkg) {
      Alert.alert('購入できません', 'App Storeに接続できませんでした。通信環境を確認して、もう一度お試しください。');
      return;
    }
    setBusy(true);
    try {
      const outcome = await purchase(pkg);
      if (outcome === 'purchased') {
        Alert.alert('ありがとうございます', 'プレミアムが有効になりました。');
        closePaywall();
      } else if (outcome === 'pending') {
        Alert.alert('承認待ち', '購入の承認が済むと、自動でプレミアムが有効になります。');
      }
    } catch (e) {
      Alert.alert('購入できませんでした', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onRestore = async () => {
    if (!purchasesAvailable()) {
      Alert.alert('復元できません', 'App Storeに接続できませんでした。');
      return;
    }
    setBusy(true);
    try {
      if (await restore()) {
        Alert.alert('復元しました', 'プレミアムが有効になりました。');
        closePaywall();
      } else {
        Alert.alert('復元できる購入がありません', '購入時と同じApple IDでサインインしているか確認してください。');
      }
    } catch (e) {
      Alert.alert('復元できませんでした', e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 16 }]}>
        <View style={styles.closeRow}>
          <Pressable accessibilityRole="button" accessibilityLabel="閉じる" onPress={closePaywall} style={styles.close}>
            <SymbolView name="xmark" tintColor={colors.text} size={16} weight="semibold" />
          </Pressable>
        </View>
        <AppText variant="caption" tone="accent" style={styles.eyebrow}>
          PREMIUM
        </AppText>
        <AppText variant="largeTitle" accessibilityRole="header" style={styles.headline}>
          広告なしで、{'\n'}もっと自由に。
        </AppText>

        <View style={styles.perks}>
          {perks.map((p) => (
            <View key={p.title} style={styles.perk}>
              <View style={styles.perkIcon}>
                <SymbolView name={p.icon} tintColor={colors.accent} size={18} />
              </View>
              <View style={styles.perkText}>
                <AppText variant="bodyBold">{p.title}</AppText>
                <AppText variant="small" tone="secondary">
                  {p.desc}
                </AppText>
              </View>
            </View>
          ))}
        </View>

        <View style={styles.plan}>
          <View style={styles.planText}>
            <AppText variant="bodyBold" style={styles.planTitle}>
              買い切り
            </AppText>
            <AppText variant="small" tone="secondary">
              一度の購入でずっと使えます。追加の料金はかかりません
            </AppText>
          </View>
          <AppText variant="title" style={styles.price}>
            {price}
          </AppText>
        </View>

        <Pressable
          accessibilityRole="button"
          accessibilityState={{ busy, disabled: busy }}
          disabled={busy}
          onPress={onPurchase}
          style={[styles.buy, busy && styles.busy]}>
          {busy ? <ActivityIndicator color={colors.onAccent} /> : null}
          <AppText variant="bodyBold" tone="onAccent" style={styles.buyText}>
            {price}で購入する
          </AppText>
        </Pressable>

        <View style={styles.links}>
          <Pressable accessibilityRole="button" disabled={busy} onPress={onRestore} style={styles.link}>
            <AppText variant="small" tone="secondary">
              購入を復元
            </AppText>
          </Pressable>
          <Pressable accessibilityRole="link" onPress={() => Linking.openURL(TERMS_URL)} style={styles.link}>
            <AppText variant="small" tone="secondary">
              利用規約
            </AppText>
          </Pressable>
          <Pressable accessibilityRole="link" onPress={() => Linking.openURL(PRIVACY_URL)} style={styles.link}>
            <AppText variant="small" tone="secondary">
              プライバシー
            </AppText>
          </Pressable>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { paddingHorizontal: 20 },
  closeRow: { paddingTop: 16, flexDirection: 'row', justifyContent: 'flex-end' },
  close: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center' },
  eyebrow: { fontWeight: '700', letterSpacing: 1.3, marginTop: 4 },
  headline: { marginTop: 6, fontSize: 28, lineHeight: 38 },
  perks: { gap: 14, marginTop: 24 },
  perk: { flexDirection: 'row', gap: 14, alignItems: 'center' },
  perkIcon: { width: 40, height: 40, borderRadius: radius.md, backgroundColor: colors.accentSoft, alignItems: 'center', justifyContent: 'center' },
  perkText: { flex: 1, gap: 2 },
  plan: {
    marginTop: 28,
    borderRadius: 16,
    borderWidth: 2,
    borderColor: colors.accent,
    backgroundColor: '#1F1A15',
    paddingVertical: 14,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  planText: { gap: 2, flex: 1 },
  planTitle: { fontSize: 16 },
  price: { fontSize: 20 },
  buy: {
    marginTop: 16,
    height: 54,
    borderRadius: 16,
    backgroundColor: colors.accent,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  busy: { opacity: 0.7 },
  buyText: { fontSize: 17 },
  legal: { marginTop: 14, fontSize: 11, lineHeight: 18 },
  links: { marginTop: 8, flexDirection: 'row', justifyContent: 'center', gap: 16 },
  link: { minHeight: 44, justifyContent: 'center' },
});
