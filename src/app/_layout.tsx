import {
  ZenKakuGothicNew_400Regular,
  ZenKakuGothicNew_500Medium,
  ZenKakuGothicNew_700Bold,
  useFonts,
} from '@expo-google-fonts/zen-kaku-gothic-new';
import { DarkTheme, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { SQLiteProvider, useSQLiteContext } from 'expo-sqlite';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';

import { AppTabs } from '@/components/app-tabs';
import { migrateDbIfNeeded } from '@/db/schema';
import { PaywallHost } from '@/premium/paywall';
import { initPurchases } from '@/premium/purchases';
import { AppLockGate } from '@/security/app-lock';
import { runQueue } from '@/download/engine';
import { colors } from '@/theme';

SplashScreen.preventAutoHideAsync();

const navigationTheme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    primary: colors.accent,
    background: colors.background,
    card: colors.background,
    text: colors.text,
    border: colors.border,
  },
};

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    ZenKakuGothicNew_400Regular,
    ZenKakuGothicNew_500Medium,
    ZenKakuGothicNew_700Bold,
  });
  const ready = fontsLoaded || fontError != null;

  useEffect(() => {
    if (ready) {
      SplashScreen.hideAsync();
    }
  }, [ready]);

  useEffect(() => {
    initPurchases();
  }, []);

  if (!ready) {
    return null;
  }

  return (
    <SQLiteProvider databaseName="library.db" onInit={migrateDbIfNeeded}>
      <ThemeProvider value={navigationTheme}>
        <StatusBar style="light" />
        <ResumeDownloads />
        <AppTabs />
        <PaywallHost />
        <AppLockGate />
      </ThemeProvider>
    </SQLiteProvider>
  );
}

// 起動時に、前回終わらなかったダウンロードを再開する
function ResumeDownloads() {
  const db = useSQLiteContext();
  useEffect(() => {
    runQueue(db);
  }, [db]);
  return null;
}
