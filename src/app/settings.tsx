import Constants from 'expo-constants';
import { useFocusEffect } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { SymbolView } from 'expo-symbols';
import { useCallback, useState, type ReactNode } from 'react';
import { ActionSheetIOS, Alert, Linking, Modal, Pressable, ScrollView, StyleSheet, Switch, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppText } from '@/components/app-text';
import { chooseHistoryRange } from '@/components/browser/bookmarks-sheet';
import { PasscodePad } from '@/components/passcode-pad';
import { clearHistory } from '@/db/browser';
import { loadSettings, saveSetting, type AppSettings } from '@/db/settings';
import { appPasscode } from '@/security/passcode';
import { colors, radius } from '@/theme';

// TODO: 公開前に本番の連絡先とURLに差し替える
const SUPPORT_EMAIL = '[サポート用メールアドレス]';
const TERMS_URL = '[利用規約のURL]';
const PRIVACY_URL = '[プライバシーポリシーのURL]';

const lockTimings: { value: AppSettings['lockAfterSec']; label: string }[] = [
  { value: 0, label: 'すぐに' },
  { value: 60, label: '1分後' },
  { value: 300, label: '5分後' },
];

export default function SettingsScreen() {
  const db = useSQLiteContext();
  const insets = useSafeAreaInsets();
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [passcodeFlow, setPasscodeFlow] = useState<null | { step: 'enter' | 'confirm'; first?: string; error?: string }>(null);

  const load = useCallback(async () => setSettings(await loadSettings(db)), [db]);
  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const update = async <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    await saveSetting(db, key, value);
    await load();
  };

  const toggleAppLock = async (enabled: boolean) => {
    if (enabled) {
      setPasscodeFlow({ step: 'enter' });
    } else {
      await appPasscode.clear();
      await update('appLockEnabled', false);
    }
  };

  const onPasscode = async (code: string) => {
    if (!passcodeFlow) return;
    if (passcodeFlow.step === 'enter') {
      setPasscodeFlow({ step: 'confirm', first: code });
      return;
    }
    if (code !== passcodeFlow.first) {
      setPasscodeFlow({ step: 'enter', error: '一致しませんでした。もう一度入力してください' });
      return;
    }
    await appPasscode.set(code);
    await update('appLockEnabled', true);
    setPasscodeFlow(null);
  };

  const chooseLockTiming = () => {
    ActionSheetIOS.showActionSheetWithOptions(
      { title: 'ロックするタイミング', options: [...lockTimings.map((t) => t.label), 'キャンセル'], cancelButtonIndex: lockTimings.length },
      (i) => {
        if (i < lockTimings.length) update('lockAfterSec', lockTimings[i].value);
      },
    );
  };

  const clearBrowsingData = () => {
    // TODO: キャッシュ・Cookie の削除は WKWebsiteDataStore を使うネイティブモジュールで同じ期間指定に対応させる（feature-spec.md §2-7）
    chooseHistoryRange('閲覧履歴を削除', (since) => {
      clearHistory(db, since).then(() => Alert.alert('削除しました'));
    });
  };

  if (!settings) return <View style={styles.screen} />;
  const timingLabel = lockTimings.find((t) => t.value === settings.lockAfterSec)?.label ?? '';

  return (
    <View style={[styles.screen, { paddingTop: insets.top + 12 }]}>
      <AppText variant="largeTitle" accessibilityRole="header" style={styles.title}>
        設定
      </AppText>
      <ScrollView contentContainerStyle={styles.content}>
        <Section title="プライバシー">
          <Row label="パスコードロック">
            <Switch value={settings.appLockEnabled} onValueChange={toggleAppLock} trackColor={{ true: colors.accent }} />
          </Row>
          <Row label="Face IDで解除">
            <Switch
              value={settings.biometricsEnabled}
              onValueChange={(v) => update('biometricsEnabled', v)}
              disabled={!settings.appLockEnabled}
              trackColor={{ true: colors.accent }}
            />
          </Row>
          <Row label="ロックするタイミング" value={timingLabel} onPress={settings.appLockEnabled ? chooseLockTiming : undefined} />
        </Section>

        <Section title="再生">
          <Row label="バックグラウンドで音声を再生">
            <Switch value={settings.backgroundVideoAudio} onValueChange={(v) => update('backgroundVideoAudio', v)} trackColor={{ true: colors.accent }} />
          </Row>
          <Row label="再生速度を記憶する">
            <Switch value={settings.rememberPlaybackRate} onValueChange={(v) => update('rememberPlaybackRate', v)} trackColor={{ true: colors.accent }} />
          </Row>
        </Section>

        <Section title="ブラウザ">
          <Row label="閲覧データを削除" onPress={clearBrowsingData} destructive />
        </Section>

        <Section title="保存について">
          <AppText variant="small" tone="secondary" style={styles.note}>
            動画は端末にのみ保存され、iCloudバックアップには含まれません。保護（DRM・暗号化）された動画は保存できません。権利者の許諾があるコンテンツのみ保存してください。
          </AppText>
        </Section>

        <Section title="サポート">
          <Row label="お問い合わせ・削除依頼" onPress={() => Linking.openURL(`mailto:${SUPPORT_EMAIL}`)} />
          <Row label="利用規約" onPress={() => Linking.openURL(TERMS_URL)} />
          <Row label="プライバシーポリシー" onPress={() => Linking.openURL(PRIVACY_URL)} />
          <Row label="ライセンス" onPress={() => Alert.alert('ライセンス', 'VLCKit・FFmpeg（LGPL）などのライセンス表記は、組み込み時にここへ追加します。')} />
          <Row label="バージョン" value={Constants.expoConfig?.version ?? ''} />
        </Section>
      </ScrollView>

      <Modal visible={passcodeFlow != null} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setPasscodeFlow(null)}>
        <View style={styles.modal}>
          <Pressable accessibilityRole="button" onPress={() => setPasscodeFlow(null)} style={styles.modalClose}>
            <AppText variant="body" tone="accent">
              キャンセル
            </AppText>
          </Pressable>
          <PasscodePad
            title={passcodeFlow?.step === 'confirm' ? 'もう一度入力' : '新しいパスコード'}
            message="4桁の数字を入力してください。忘れた場合はロックされた動画を含めて全データの削除が必要になります。"
            onComplete={onPasscode}
            error={passcodeFlow?.error}
          />
        </View>
      </Modal>
    </View>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={styles.section}>
      <AppText variant="caption" tone="secondary" style={styles.sectionTitle}>
        {title}
      </AppText>
      <View style={styles.card}>{children}</View>
    </View>
  );
}

function Row({
  label,
  value,
  onPress,
  destructive,
  children,
}: {
  label: string;
  value?: string;
  onPress?: () => void;
  destructive?: boolean;
  children?: ReactNode;
}) {
  const content = (
    <>
      <AppText variant="body" style={destructive ? { color: colors.dangerText } : undefined}>
        {label}
      </AppText>
      <View style={styles.rowRight}>
        {value ? (
          <AppText variant="body" tone="secondary">
            {value}
          </AppText>
        ) : null}
        {children}
        {onPress && !children ? <SymbolView name="chevron.right" tintColor={colors.textMuted} size={14} /> : null}
      </View>
    </>
  );
  return onPress ? (
    <Pressable accessibilityRole="button" onPress={onPress} style={styles.row}>
      {content}
    </Pressable>
  ) : (
    <View style={styles.row}>{content}</View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  title: { paddingHorizontal: 20, paddingBottom: 8 },
  content: { paddingHorizontal: 16, paddingBottom: 120, gap: 20 },
  section: { gap: 6 },
  sectionTitle: { paddingHorizontal: 4 },
  card: { backgroundColor: colors.surface, borderRadius: radius.lg, overflow: 'hidden' },
  row: {
    minHeight: 50,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  rowRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  note: { padding: 16, lineHeight: 19 },
  modal: { flex: 1, backgroundColor: colors.background, paddingTop: 16 },
  modalClose: { alignSelf: 'flex-end', minHeight: 44, justifyContent: 'center', paddingHorizontal: 20, marginBottom: 32 },
});
