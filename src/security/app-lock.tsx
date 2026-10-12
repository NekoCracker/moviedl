import { useSQLiteContext } from 'expo-sqlite';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppText } from '@/components/app-text';
import { PasscodePad } from '@/components/passcode-pad';
import { loadSettings, type AppSettings } from '@/db/settings';
import { appPasscode, authenticateWithBiometrics } from '@/security/passcode';
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

  if (locked) {
    return (
      <View style={[styles.overlay, { paddingTop: insets.top + 80 }]}>
        <PasscodePad
          title="パスコードを入力"
          onComplete={onComplete}
          onBiometrics={biometricsEnabled ? tryBiometrics : undefined}
          error={error}
        />
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
});
