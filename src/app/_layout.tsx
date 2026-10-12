import {
  ZenKakuGothicNew_400Regular,
  ZenKakuGothicNew_500Medium,
  ZenKakuGothicNew_700Bold,
  useFonts,
} from '@expo-google-fonts/zen-kaku-gothic-new';
import { DarkTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { SQLiteProvider, useSQLiteContext } from 'expo-sqlite';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { migrateDbIfNeeded } from '@/db/schema';
import { initAds } from '@/ads/download-ad';
import { PlaybackProvider } from '@/player/playback';
import { PaywallHost } from '@/premium/paywall';
import { initPurchases } from '@/premium/purchases';
import { AppLockGate } from '@/security/app-lock';
import { watchConversions } from '@/convert/engine';
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
    // 購入状態が分かってから広告を準備する（プレミアムなら読み込まない）
    initPurchases().then(initAds);
  }, []);

  if (!ready) {
    return null;
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SQLiteProvider databaseName="library.db" onInit={migrateDbIfNeeded}>
        <ThemeProvider value={navigationTheme}>
          <StatusBar style="light" />
          <ResumeDownloads />
          <PlaybackProvider>
            <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }}>
              <Stack.Screen name="(tabs)" />
              <Stack.Screen
                name="player"
                options={{ presentation: 'modal', contentStyle: { backgroundColor: '#000' } }}
              />
              <Stack.Screen name="edit/[id]" options={{ presentation: 'modal' }} />
              <Stack.Screen name="licenses" options={{ presentation: 'modal' }} />
            </Stack>
          </PlaybackProvider>
          <PaywallHost />
          <AppLockGate />
        </ThemeProvider>
      </SQLiteProvider>
    </GestureHandlerRootView>
  );
}

// 起動時に、前回終わらなかったダウンロードを再開する
function ResumeDownloads() {
  const db = useSQLiteContext();
  useEffect(() => {
    runQueue(db);
    watchConversions(db);
  }, [db]);
  return null;
}
