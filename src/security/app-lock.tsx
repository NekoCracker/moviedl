import { useSQLiteContext } from 'expo-sqlite';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, AppState, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppText } from '@/components/app-text';
import { PasscodePad } from '@/components/passcode-pad';
import { loadSettings, type AppSettings } from '@/db/settings';
import { usePlayback } from '@/player/playback';
import { appPasscode, authenticateWithBiometrics } from '@/security/passcode';
import { resetAllData } from '@/security/reset';
import { colors } from '@/theme';

// アプリ全体のロック画面と、アプリ切り替え画面での目隠し（feature-spec.md §2-1）
export function AppLockGate() {
  const db = useSQLiteContext();
  const insets = useSafeAreaInsets();
  const [locked, setLocked] = useState(false);
  const [covered, setCovered] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [biometricsEnabled, setBiometricsEnabled] = useState(false);
  const settingsRef = useRef<AppSettings | null>(null);
  const backgroundedAt = useRef<number | null>(null);
  const playback = usePlayback();

  const shouldLock = useCallback(async () => {
    const settings = await loadSettings(db);
    settingsRef.current = settings;
    return settings.appLockEnabled && (await appPasscode.isSet());
  }, [db]);

  const tryBiometrics = useCallback(async () => {
    if (!settingsRef.current?.biometricsEnabled) return;
    if (await authenticateWithBiometrics('ロックを解除')) {
      setLocked(false);
      setError(null);
    }
  }, []);

  // 起動時
  useEffect(() => {
    shouldLock().then((lock) => {
      setBiometricsEnabled(settingsRef.current?.biometricsEnabled ?? false);
      if (lock) {
        setLocked(true);
        tryBiometrics();
      }
    });
  }, [shouldLock, tryBiometrics]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', async (state) => {
      if (state === 'inactive' || state === 'background') {
        setCovered(true);
        if (state === 'background' && backgroundedAt.current == null) {
          backgroundedAt.current = Date.now();
        }
        return;
      }
      setCovered(false);
      const since = backgroundedAt.current;
      backgroundedAt.current = null;
      if (since == null || !(await shouldLock())) return;
      setBiometricsEnabled(settingsRef.current?.biometricsEnabled ?? false);
      const lockAfterMs = (settingsRef.current?.lockAfterSec ?? 0) * 1000;
      if (Date.now() - since >= lockAfterMs) {
        setLocked(true);
        tryBiometrics();
      }
    });
    return () => sub.remove();
  }, [shouldLock, tryBiometrics]);

  const onComplete = async (code: string) => {
    const result = await appPasscode.verify(code);
    if (result.ok) {
      setLocked(false);
      setError(null);
    } else if (result.lockedForMs > 0) {
      setError(`${Math.ceil(result.lockedForMs / 1000)}秒後にもう一度お試しください`);
    } else {
      setError(`パスコードが違います（あと${result.remaining}回）`);
    }
  };

  const forgot = () => {
    Alert.alert(
      'パスコードを忘れた場合',
      'このアプリにはパスコードを確認する仕組みがないため、初期化が必要です。保存した動画・音声とフォルダ（ロックしたものを含む）がすべて削除されます。ブックマークと購入済みのプレミアムは残ります。',
      [
        { text: 'キャンセル', style: 'cancel' },
        {
          text: 'すべて削除して初期化',
          style: 'destructive',
          onPress: () =>
            Alert.alert('本当に削除しますか？', '削除した動画は元に戻せません。', [
              { text: 'キャンセル', style: 'cancel' },
              {
                text: '削除する',
                style: 'destructive',
                onPress: async () => {
                  playback.stop();
                  await resetAllData(db);
                  setLocked(false);
                  setError(null);
                  Alert.alert('初期化しました');
                },
              },
            ]),
        },
      ],
    );
  };

  if (locked) {
    return (
      <View style={[styles.overlay, { paddingTop: insets.top + 80 }]}>
        <PasscodePad
          title="パスコードを入力"
          onComplete={onComplete}
          onBiometrics={biometricsEnabled ? tryBiometrics : undefined}
          error={error}
        />
        <Pressable accessibilityRole="button" onPress={forgot} style={styles.forgot}>
          <AppText variant="caption" tone="secondary">
            パスコードを忘れた場合
          </AppText>
        </Pressable>
      </View>
    );
  }
  if (covered) {
    return (
      <View style={[styles.overlay, styles.cover]}>
        <AppText variant="title" tone="secondary">
          動画保存
        </AppText>
      </View>
    );
  }
  return null;
}

const styles = StyleSheet.create({
  overlay: { ...StyleSheet.absoluteFill, backgroundColor: colors.background, zIndex: 1000 },
  cover: { alignItems: 'center', justifyContent: 'center' },
  forgot: { alignSelf: 'center', minHeight: 44, justifyContent: 'center', paddingHorizontal: 16, marginTop: 24 },
});
