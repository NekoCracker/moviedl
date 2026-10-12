import { NativeTabs } from 'expo-router/unstable-native-tabs';

import { colors } from '@/theme';

export function AppTabs() {
  return (
    <NativeTabs
      backgroundColor={colors.tabBar}
      iconColor={{ default: colors.textMuted, selected: colors.accent }}
      labelStyle={{ default: { color: colors.textMuted }, selected: { color: colors.accent } }}>
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
