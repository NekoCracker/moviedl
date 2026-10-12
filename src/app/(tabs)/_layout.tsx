import { usePathname } from 'expo-router';
import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { Platform, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { MiniPlayer } from '@/components/mini-player';
import { usePlayback } from '@/player/playback';
import { colors, radius } from '@/theme';

// iOS 26 以降はタブバーの「ボトムアクセサリ」にミニプレイヤーを置く。それより前はタブバーの上に重ねる。
const supportsBottomAccessory = Platform.OS === 'ios' && Number.parseInt(String(Platform.Version), 10) >= 26;

export default function TabsLayout() {
  const { current } = usePlayback();
  const insets = useSafeAreaInsets();
  // ブラウザは下に操作ボタンがあるので、重ねる表示は出さない
  const pathname = usePathname();
  return (
    <>
      <AppTabs showAccessory={supportsBottomAccessory && current != null} />
      {!supportsBottomAccessory && current != null && pathname !== '/browser' ? (
        <View style={[styles.floating, { bottom: insets.bottom + 54 }]}>
          <MiniPlayer />
        </View>
      ) : null}
    </>
  );
}

function AccessoryContent() {
  const placement = NativeTabs.BottomAccessory.usePlacement();
  return <MiniPlayer compact={placement === 'inline'} />;
}

function AppTabs({ showAccessory }: { showAccessory: boolean }) {
  return (
    <NativeTabs
      backgroundColor={colors.tabBar}
      iconColor={{ default: colors.textMuted, selected: colors.accent }}
      labelStyle={{ default: { color: colors.textMuted }, selected: { color: colors.accent } }}>
      {showAccessory ? (
        <NativeTabs.BottomAccessory>
          <AccessoryContent />
        </NativeTabs.BottomAccessory>
      ) : null}
      <NativeTabs.Trigger name="(library)">
        <NativeTabs.Trigger.Label>ライブラリ</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={{ default: 'square.grid.2x2', selected: 'square.grid.2x2.fill' }} />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="browser">
        <NativeTabs.Trigger.Label>ブラウザ</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf="globe" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="downloads">
        <NativeTabs.Trigger.Label>ダウンロード</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={{ default: 'arrow.down.circle', selected: 'arrow.down.circle.fill' }} />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="settings">
        <NativeTabs.Trigger.Label>設定</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={{ default: 'gearshape', selected: 'gearshape.fill' }} />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}

const styles = StyleSheet.create({
  floating: {
    position: 'absolute',
    left: 10,
    right: 10,
    height: 56,
    borderRadius: radius.lg,
    backgroundColor: colors.surfaceRaised,
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
  },
});
