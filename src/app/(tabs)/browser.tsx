import { useSQLiteContext } from 'expo-sqlite';
import { SymbolView, type SFSymbol } from 'expo-symbols';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActionSheetIOS, Alert, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView, type WebViewMessageEvent, type WebViewNavigation } from 'react-native-webview';

import { AppText } from '@/components/app-text';
import { BookmarksSheet } from '@/components/browser/bookmarks-sheet';
import { StartPage } from '@/components/browser/start-page';
import { TabSwitcher } from '@/components/browser/tab-switcher';
import { DetectedSheet } from '@/components/detected-sheet';
import { detectorScript, linkMenuScript, parseDetectorMessage, toNavigableUrl, type DetectedMedia } from '@/browser/detector';
import {
  addBookmark,
  addHistory,
  activateTab,
  closeAllTabs,
  closeTab,
  deleteBookmark,
  findBookmarkByUrl,
  listBookmarks,
  listTabs,
  loadTabs,
  MAX_TABS,
  openTab,
  START_PAGE_URL,
  updateTabPage,
  type Bookmark,
  type BrowserTab,
} from '@/db/browser';
import { enqueueDownload, type DownloadOutput } from '@/db/downloads';
import { runQueue } from '@/download/engine';
import { colors, fonts, radius } from '@/theme';

const injectedScript = `${detectorScript}\n${linkMenuScript}`;

export default function BrowserScreen() {
  const db = useSQLiteContext();
  const insets = useSafeAreaInsets();
  const webViewRef = useRef<WebView>(null);

  const [tabs, setTabs] = useState<BrowserTab[]>([]);
  const activeTab = tabs.find((t) => t.isActive) ?? null;
  // WebView に読み込ませるURL。ページ内の移動では変えない（変えると再読み込みになる）
  const [loadUrl, setLoadUrl] = useState<string | null>(null);
  const [currentUrl, setCurrentUrl] = useState(START_PAGE_URL);
  const [pageTitle, setPageTitle] = useState<string | null>(null);
  const [addressText, setAddressText] = useState('');
  const [editingAddress, setEditingAddress] = useState(false);
  const [nav, setNav] = useState({ canGoBack: false, canGoForward: false, loading: false });
  const [detected, setDetected] = useState<DetectedMedia[]>([]);
  const [drmPage, setDrmPage] = useState(false);
  const [sheetVisible, setSheetVisible] = useState(false);
  const [tabsVisible, setTabsVisible] = useState(false);
  const [bookmarksVisible, setBookmarksVisible] = useState(false);
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [currentBookmark, setCurrentBookmark] = useState<Bookmark | null>(null);
  const pageUrlRef = useRef(START_PAGE_URL);
  const recordedUrlRef = useRef<string | null>(null);

  const isStartPage = currentUrl === START_PAGE_URL;
  const isPrivate = activeTab?.isPrivate ?? false;

  const refreshBookmarks = useCallback(async () => setBookmarks(await listBookmarks(db)), [db]);

  // タブを表示する（切り替え・新規作成のあと）
  const showTab = useCallback((tab: BrowserTab | null) => {
    const url = tab?.url ?? START_PAGE_URL;
    pageUrlRef.current = url;
    recordedUrlRef.current = url;
    setLoadUrl(url === START_PAGE_URL ? null : url);
    setCurrentUrl(url);
    setPageTitle(tab?.title ?? null);
    setAddressText(url === START_PAGE_URL ? '' : url);
    setNav({ canGoBack: false, canGoForward: false, loading: false });
    setDetected([]);
    setDrmPage(false);
  }, []);

  const reloadTabs = useCallback(async () => {
    const list = await listTabs(db);
    setTabs(list);
    return list;
  }, [db]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [list, marks] = await Promise.all([loadTabs(db), listBookmarks(db)]);
      if (cancelled) return;
      setTabs(list);
      setBookmarks(marks);
      showTab(list.find((t) => t.isActive) ?? null);
    })();
    return () => {
      cancelled = true;
    };
  }, [db, showTab]);

  useEffect(() => {
    let cancelled = false;
    (isStartPage ? Promise.resolve(null) : findBookmarkByUrl(db, currentUrl)).then((b) => {
      if (!cancelled) setCurrentBookmark(b);
    });
    return () => {
      cancelled = true;
    };
  }, [db, currentUrl, isStartPage, bookmarks]);

  const navigate = (input: string) => {
    if (input === START_PAGE_URL) {
      setLoadUrl(null);
      setCurrentUrl(START_PAGE_URL);
      setAddressText('');
      setDetected([]);
      setDrmPage(false);
      pageUrlRef.current = START_PAGE_URL;
      if (activeTab) updateTabPage(db, activeTab.id, START_PAGE_URL, null);
      return;
    }
    const url = toNavigableUrl(input);
    setAddressText(url);
    if (loadUrl === url && !isStartPage) {
      // source が同じだと WebView は読み込み直さないので、ページ側で移動させる
      webViewRef.current?.injectJavaScript(`window.location.href = ${JSON.stringify(url)}; true;`);
    } else {
      setLoadUrl(url);
      setCurrentUrl(url);
    }
  };

  const onNavigationStateChange = useCallback(
    (state: WebViewNavigation) => {
      // ページが変わったら検出リストをリセットする（同じページ内のハッシュ変更は除く）
      const withoutHash = state.url.split('#')[0];
      if (withoutHash !== pageUrlRef.current.split('#')[0]) {
        setDetected([]);
        setDrmPage(false);
      }
      pageUrlRef.current = state.url;
      setCurrentUrl(state.url);
      setPageTitle(state.title || null);
      if (!editingAddress) {
        setAddressText(state.url);
      }
      setNav({ canGoBack: state.canGoBack, canGoForward: state.canGoForward, loading: state.loading });

      if (!state.loading && activeTab && /^https?:/i.test(state.url)) {
        const title = state.title && state.title !== state.url ? state.title : null;
        updateTabPage(db, activeTab.id, state.url, title).then(reloadTabs);
        // プライベートタブは履歴に残さない
        if (!activeTab.isPrivate && recordedUrlRef.current !== state.url) {
          recordedUrlRef.current = state.url;
          addHistory(db, state.url, title);
        }
      }
    },
    [editingAddress, activeTab, db, reloadTabs],
  );

  const newTab = async (url: string, priv: boolean) => {
    const id = await openTab(db, url, priv);
    if (id == null) {
      Alert.alert(`タブは${MAX_TABS}個までです`, '使っていないタブを閉じてから開いてください。');
      return;
    }
    const list = await reloadTabs();
    showTab(list.find((t) => t.id === id) ?? null);
  };

  const onMessage = (event: WebViewMessageEvent) => {
    const msg = parseDetectorMessage(event.nativeEvent.data);
    if (!msg) return;
    if (msg.type === 'drm-detected') {
      setDrmPage(true);
      return;
    }
    if (msg.type === 'link-menu') {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          title: msg.url,
          options: ['開く', '新しいタブで開く', isPrivate ? '新しいプライベートタブで開く' : 'プライベートタブで開く', 'キャンセル'],
          cancelButtonIndex: 3,
        },
        (i) => {
          if (i === 0) navigate(msg.url);
          if (i === 1) newTab(msg.url, isPrivate);
          if (i === 2) newTab(msg.url, true);
        },
      );
      return;
    }
    const media = msg.media;
    setDetected((prev) => (prev.some((m) => m.url === media.url) ? prev : [...prev, media]));
  };

  const toggleBookmark = () => {
    if (isStartPage) return;
    if (currentBookmark) {
      ActionSheetIOS.showActionSheetWithOptions(
        { title: currentBookmark.title, options: ['ブックマークから削除', 'キャンセル'], cancelButtonIndex: 1, destructiveButtonIndex: 0 },
        (i) => {
          if (i === 0) deleteBookmark(db, currentBookmark.id).then(refreshBookmarks);
        },
      );
      return;
    }
    const url = currentUrl;
    Alert.prompt(
      'ブックマークに追加',
      url,
      (title) => {
        addBookmark(db, title, url).then(refreshBookmarks);
      },
      'plain-text',
      pageTitle ?? '',
    );
  };

  const selectTab = async (id: number) => {
    setTabsVisible(false);
    if (id === activeTab?.id) return;
    await activateTab(db, id);
    const list = await reloadTabs();
    showTab(list.find((t) => t.id === id) ?? null);
  };

  const closeTabAndShow = async (id: number) => {
    const wasActive = id === activeTab?.id;
    await closeTab(db, id);
    const list = await reloadTabs();
    if (wasActive) showTab(list.find((t) => t.isActive) ?? null);
  };

  const closeAll = async (priv: boolean) => {
    const wasActive = activeTab?.isPrivate === priv;
    await closeAllTabs(db, priv);
    const list = await reloadTabs();
    if (wasActive) showTab(list.find((t) => t.isActive) ?? null);
  };

  const onDownload = async (item: DetectedMedia, output: DownloadOutput, folderId: number) => {
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
      folderId,
    });
    runQueue(db);
    Alert.alert('ダウンロードに追加しました', item.pageTitle);
  };

  return (
    <View style={[styles.screen, { paddingTop: insets.top + 4 }]}>
      <View style={styles.addressRow}>
        <View style={[styles.addressField, isPrivate && styles.addressFieldPrivate]}>
          <SymbolView
            name={isPrivate ? 'eye.slash' : currentUrl.startsWith('https://') ? 'lock.fill' : isStartPage ? 'magnifyingglass' : 'globe'}
            tintColor={colors.textSecondary}
            size={13}
          />
          <TextInput
            accessibilityLabel="URLまたは検索語"
            placeholder={isPrivate ? 'プライベート：検索またはURL' : '検索またはURLを入力'}
            placeholderTextColor={colors.textMuted}
            value={addressText}
            onChangeText={setAddressText}
            onFocus={() => setEditingAddress(true)}
            onBlur={() => setEditingAddress(false)}
            onSubmitEditing={() => {
              setEditingAddress(false);
              if (addressText.trim()) navigate(addressText);
            }}
            selectTextOnFocus
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="web-search"
            returnKeyType="go"
            clearButtonMode="while-editing"
            style={styles.addressInput}
          />
          {!isStartPage ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={currentBookmark ? 'ブックマーク済み' : 'ブックマークに追加'}
              hitSlop={8}
              onPress={toggleBookmark}
              style={styles.starButton}>
              <SymbolView
                name={currentBookmark ? 'star.fill' : 'star'}
                tintColor={currentBookmark ? colors.accent : colors.textSecondary}
                size={16}
              />
            </Pressable>
          ) : null}
        </View>
        <ToolbarButton
          icon={nav.loading ? 'xmark' : 'arrow.clockwise'}
          label={nav.loading ? '読み込みを中止' : '再読込'}
          disabled={isStartPage}
          onPress={() => (nav.loading ? webViewRef.current?.stopLoading() : webViewRef.current?.reload())}
        />
      </View>

      <View style={styles.webWrap}>
        {isStartPage || !loadUrl || !activeTab ? (
          <StartPage bookmarks={bookmarks} isPrivate={isPrivate} onOpen={navigate} />
        ) : (
          <WebView
            // タブごとに WebView を作り直す（表示中のタブだけを読み込む）
            key={activeTab.id}
            ref={webViewRef}
            source={{ uri: loadUrl }}
            injectedJavaScriptBeforeContentLoaded={injectedScript}
            injectedJavaScriptForMainFrameOnly={false}
            injectedJavaScriptBeforeContentLoadedForMainFrameOnly={false}
            onMessage={onMessage}
            onNavigationStateChange={onNavigationStateChange}
            onOpenWindow={(e) => newTab(e.nativeEvent.targetUrl, isPrivate)}
            allowsInlineMediaPlayback
            allowsBackForwardNavigationGestures
            allowsLinkPreview={false}
            incognito={isPrivate}
            sharedCookiesEnabled={!isPrivate}
            setSupportMultipleWindows
            style={styles.web}
          />
        )}

        {detected.length > 0 && !isStartPage ? (
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
        <ToolbarButton icon="chevron.left" label="戻る" disabled={!nav.canGoBack || isStartPage} onPress={() => webViewRef.current?.goBack()} />
        <ToolbarButton icon="chevron.right" label="進む" disabled={!nav.canGoForward || isStartPage} onPress={() => webViewRef.current?.goForward()} />
        <ToolbarButton icon="house" label="開始ページ" onPress={() => navigate(START_PAGE_URL)} />
        <ToolbarButton icon="book" label="ブックマークと履歴" onPress={() => setBookmarksVisible(true)} />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`タブ一覧（${tabs.length}個）`}
          onPress={() => setTabsVisible(true)}
          style={styles.toolbarButton}>
          <View style={[styles.tabCount, isPrivate && styles.tabCountPrivate]}>
            <AppText variant="small" style={styles.tabCountText}>
              {tabs.length}
            </AppText>
          </View>
        </Pressable>
      </View>

      <DetectedSheet
        visible={sheetVisible}
        media={detected}
        onClose={() => setSheetVisible(false)}
        onDownload={onDownload}
      />
      <TabSwitcher
        key={tabsVisible ? `open-${isPrivate}` : 'closed'}
        visible={tabsVisible}
        tabs={tabs}
        activePrivate={isPrivate}
        onClose={() => setTabsVisible(false)}
        onSelect={selectTab}
        onCloseTab={closeTabAndShow}
        onCloseAll={closeAll}
        onNewTab={(priv) => {
          setTabsVisible(false);
          newTab(START_PAGE_URL, priv);
        }}
      />
      <BookmarksSheet
        visible={bookmarksVisible}
        onClose={() => {
          setBookmarksVisible(false);
          refreshBookmarks();
        }}
        onOpen={(url) => {
          setBookmarksVisible(false);
          refreshBookmarks();
          navigate(url);
        }}
        onOpenInNewTab={(url) => {
          setBookmarksVisible(false);
          refreshBookmarks();
          newTab(url, isPrivate);
        }}
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
    paddingLeft: 12,
    paddingRight: 4,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  addressFieldPrivate: { backgroundColor: '#17151F', borderColor: '#3B3550' },
  addressInput: { flex: 1, color: colors.text, fontFamily: fonts.regular, fontSize: 14, height: 40 },
  starButton: { width: 32, height: 40, alignItems: 'center', justifyContent: 'center' },
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
  tabCount: {
    minWidth: 22,
    height: 22,
    borderRadius: 5,
    borderWidth: 1.6,
    borderColor: colors.text,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 3,
  },
  tabCountPrivate: { borderColor: '#9B8CFF' },
  tabCountText: { fontSize: 11, lineHeight: 14 },
});
