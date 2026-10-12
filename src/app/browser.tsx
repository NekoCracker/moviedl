import { useSQLiteContext } from 'expo-sqlite';
import { SymbolView, type SFSymbol } from 'expo-symbols';
import { useCallback, useRef, useState } from 'react';
import { Alert, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView, type WebViewMessageEvent, type WebViewNavigation } from 'react-native-webview';

import { AppText } from '@/components/app-text';
import { DetectedSheet } from '@/components/detected-sheet';
import { detectorScript, parseDetectorMessage, toNavigableUrl, type DetectedMedia } from '@/browser/detector';
import { enqueueDownload, type DownloadOutput } from '@/db/downloads';
import { colors, fonts, radius } from '@/theme';

const HOME_URL = 'https://www.google.com/';

export default function BrowserScreen() {
  const db = useSQLiteContext();
  const insets = useSafeAreaInsets();
  const webViewRef = useRef<WebView>(null);

  const [currentUrl, setCurrentUrl] = useState(HOME_URL);
  const [addressText, setAddressText] = useState(HOME_URL);
  const [editingAddress, setEditingAddress] = useState(false);
  const [nav, setNav] = useState({ canGoBack: false, canGoForward: false, loading: false });
  const [detected, setDetected] = useState<DetectedMedia[]>([]);
  const [drmPage, setDrmPage] = useState(false);
  const [sheetVisible, setSheetVisible] = useState(false);
  const pageUrlRef = useRef(HOME_URL);

  const onNavigationStateChange = useCallback((state: WebViewNavigation) => {
    // ページが変わったら検出リストをリセットする（同じページ内のハッシュ変更は除く）
    const withoutHash = state.url.split('#')[0];
    if (withoutHash !== pageUrlRef.current.split('#')[0]) {
      setDetected([]);
      setDrmPage(false);
    }
    pageUrlRef.current = state.url;
    setCurrentUrl(state.url);
    if (!editingAddress) {
      setAddressText(state.url);
    }
    setNav({ canGoBack: state.canGoBack, canGoForward: state.canGoForward, loading: state.loading });
  }, [editingAddress]);

  const onMessage = useCallback((event: WebViewMessageEvent) => {
    const msg = parseDetectorMessage(event.nativeEvent.data);
    if (!msg) return;
    if (msg.type === 'drm-detected') {
      setDrmPage(true);
      return;
    }
    setDetected((prev) => (prev.some((m) => m.url === msg.media.url) ? prev : [...prev, msg.media]));
  }, []);

  const submitAddress = () => {
    setEditingAddress(false);
    const url = toNavigableUrl(addressText);
    if (url) {
      setCurrentUrl(url);
      setAddressText(url);
    }
  };

  const onDownload = async (item: DetectedMedia, output: DownloadOutput) => {
    setSheetVisible(false);
    if (drmPage) {
      Alert.alert('保存できません', 'このページの動画は保護（DRM）されているため保存できません。');
      return;
    }
    // TODO: 無料版はここでインタースティシャル広告を表示する（feature-spec.md §3）
    await enqueueDownload(db, {
      sourceUrl: item.url,
      pageUrl: item.pageUrl,
      title: item.pageTitle,
      kind: item.kind,
      output,
    });
    Alert.alert('ダウンロードに追加しました', item.pageTitle);
  };

  return (
    <View style={[styles.screen, { paddingTop: insets.top + 4 }]}>
      <View style={styles.addressRow}>
        <View style={styles.addressField}>
          <SymbolView
            name={currentUrl.startsWith('https://') ? 'lock.fill' : 'globe'}
            tintColor={colors.textSecondary}
            size={13}
          />
          <TextInput
            accessibilityLabel="URLまたは検索語"
            value={addressText}
            onChangeText={setAddressText}
            onFocus={() => setEditingAddress(true)}
            onBlur={() => setEditingAddress(false)}
            onSubmitEditing={submitAddress}
            selectTextOnFocus
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="web-search"
            returnKeyType="go"
            style={styles.addressInput}
          />
        </View>
        <ToolbarButton
          icon={nav.loading ? 'xmark' : 'arrow.clockwise'}
          label={nav.loading ? '読み込みを中止' : '再読込'}
          onPress={() => (nav.loading ? webViewRef.current?.stopLoading() : webViewRef.current?.reload())}
        />
      </View>

      <View style={styles.webWrap}>
        <WebView
          ref={webViewRef}
          source={{ uri: currentUrl }}
          injectedJavaScriptBeforeContentLoaded={detectorScript}
          injectedJavaScriptForMainFrameOnly={false}
          injectedJavaScriptBeforeContentLoadedForMainFrameOnly={false}
          onMessage={onMessage}
          onNavigationStateChange={onNavigationStateChange}
          allowsInlineMediaPlayback
          allowsBackForwardNavigationGestures
          sharedCookiesEnabled
          setSupportMultipleWindows={false}
          style={styles.web}
        />

        {detected.length > 0 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`検出した動画 ${detected.length}件`}
            onPress={() => setSheetVisible(true)}
            style={styles.fab}>
            <SymbolView name="arrow.down.to.line" tintColor={colors.onAccent} size={18} weight="bold" />
            <AppText variant="bodyBold" tone="onAccent" style={styles.fabCount}>
              {detected.length}
            </AppText>
          </Pressable>
        ) : null}
      </View>

      <View style={styles.toolbar}>
        <ToolbarButton icon="chevron.left" label="戻る" disabled={!nav.canGoBack} onPress={() => webViewRef.current?.goBack()} />
        <ToolbarButton icon="chevron.right" label="進む" disabled={!nav.canGoForward} onPress={() => webViewRef.current?.goForward()} />
        <ToolbarButton icon="house" label="ホーム" onPress={() => setCurrentUrl(HOME_URL)} />
        <ToolbarButton icon="star" label="ブックマークに追加" onPress={() => Alert.alert('ブックマークは次のステップで実装します')} />
        <ToolbarButton icon="square.on.square" label="タブ一覧" onPress={() => Alert.alert('タブは次のステップで実装します')} />
      </View>

      <DetectedSheet
        visible={sheetVisible}
        media={detected}
        onClose={() => setSheetVisible(false)}
        onDownload={onDownload}
      />
    </View>
  );
}

function ToolbarButton({
  icon,
  label,
  onPress,
  disabled,
}: {
  icon: SFSymbol;
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={styles.toolbarButton}>
      <SymbolView name={icon} tintColor={disabled ? '#4A4D55' : colors.text} size={20} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.tabBar },
  addressRow: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 12, paddingBottom: 8 },
  addressField: {
    flex: 1,
    height: 40,
    borderRadius: radius.md,
    backgroundColor: '#1F2228',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
  },
  addressInput: { flex: 1, color: colors.text, fontFamily: fonts.regular, fontSize: 14, height: 40 },
  webWrap: { flex: 1 },
  web: { flex: 1, backgroundColor: colors.background },
  fab: {
    position: 'absolute',
    right: 16,
    bottom: 24,
    height: 52,
    paddingHorizontal: 18,
    borderRadius: 26,
    backgroundColor: colors.accent,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 6 },
  },
  fabCount: { fontSize: 16 },
  toolbar: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    paddingVertical: 2,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    paddingBottom: 90,
  },
  toolbarButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
});
