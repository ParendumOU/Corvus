import { useEffect, useRef, useState, type ComponentType, type Ref } from 'react';
import { GPC_HEADER, GPC_HEADER_VALUE, GPC_PAGE_SCRIPT } from '@corvus/shared';
import { Platform, StyleSheet, View } from 'react-native';
import WebViewBase, { type WebViewProps } from 'react-native-webview';
import type { ShouldStartLoadRequest, WebViewErrorEvent, WebViewNavigation, WebViewNavigationEvent, WebViewOpenWindowEvent, WebViewProgressEvent } from 'react-native-webview/lib/WebViewTypes';

import { Button } from '@/components/button';
import { Icon } from '@/components/icon';
import { ThemedText } from '@/components/themed-text';
import { Space } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { cosmeticScript } from '@/lib/blocklist';
import { openTab, pageLoaded, pageNavigated, pageTitled, setRuntime, type LoadRequest } from '@/lib/browser-store';
import { registerPage } from '@/lib/browser-views';
import { offerExternalLink } from '@/lib/external-links';
import { t } from '@/lib/i18n';
import type { BrowserTab } from '@/lib/tabs';
import { BrowserKit } from '../../../modules/browser-kit';

/** What the app calls on a page (the component's ref). */
interface WebViewHandle {
  goBack(): void;
  goForward(): void;
  reload(): void;
  stopLoading(): void;
  injectJavaScript(script: string): void;
}

// The package types the component without its ref (and against another copy of React's types).
const WebView = WebViewBase as unknown as ComponentType<WebViewProps & { ref?: Ref<WebViewHandle> }>;

const WEB = /^https?:/i;
/** What a page itself may load in the tab; anything else is another app's link (asked first). */
const IN_TAB = /^(https?|about|data|blob):/i;

/**
 * What the tab loads: with Global Privacy Control on, a load the app starts carries the Sec-GPC
 * header (the WebView lets an app set headers only on the loads it starts; pages get
 * navigator.globalPrivacyControl in every frame either way).
 */
function sourceOf(uri: string, gpc: boolean): { uri: string; headers?: Record<string, string> } {
  return gpc && WEB.test(uri) ? { uri, headers: { [GPC_HEADER]: GPC_HEADER_VALUE } } : { uri };
}

/** Hides the elements the site's cosmetic filters name (Android, with blocking on there). */
async function hideElements(viewTag: number | null, url: string, inject: (script: string) => void): Promise<void> {
  if (!BrowserKit || viewTag === null || !WEB.test(url)) return;
  const script = cosmeticScript(await BrowserKit.cosmeticSelectors(url).catch(() => []));
  if (script) inject(script);
}

function ErrorPage({ description, onRetry }: { description: string; onRetry: () => void }) {
  const theme = useTheme();
  return (
    <View style={[StyleSheet.absoluteFill, styles.error, { backgroundColor: theme.background }]} testID="browser-error">
      <Icon name="warning" size={40} color={theme.textTertiary} />
      <ThemedText type="heading" style={styles.center}>
        {t('This page could not be opened')}
      </ThemedText>
      <ThemedText type="small" themeColor="textSecondary" style={styles.center}>
        {description}
      </ThemedText>
      <Button label={t('Try again')} icon="refresh" kind="tonal" onPress={onRetry} />
    </View>
  );
}

/**
 * One tab's page: the system WebView (Android) or WKWebView (iOS). Its settings are the safe ones
 * (no file access, no access from file pages, mixed content blocked, no JavaScript bridge: the app
 * never passes onMessage, so pages get no interface to call), plus Safe Browsing and request
 * blocking, cookie banner rejection and Global Privacy Control set up natively on Android
 * (modules/browser-kit). On iOS, cookie banners are answered natively too (in a content world of
 * their own), and GPC is a script WKWebView adds at document start in every frame.
 */
export function WebPage({ tab, request, visible, userAgent, gpc }: { tab: BrowserTab; request: LoadRequest | undefined; visible: boolean; userAgent: string | undefined; gpc: boolean }) {
  const ref = useRef<WebViewHandle>(null);
  // The page a remount starts from: the tab's address (a restarted or woken tab), else what was asked.
  const [source, setSource] = useState(() => sourceOf(tab.url || request?.url || 'about:blank', gpc));
  const [epoch, setEpoch] = useState(0);
  const viewTag = useRef<number | null>(null);
  const lastRequest = useRef(request?.n ?? 0);
  const hidden = useRef<string | null>(null);
  const id = tab.id;

  useEffect(() => {
    registerPage(id, {
      goBack: () => ref.current?.goBack(),
      goForward: () => ref.current?.goForward(),
      reload: () => ref.current?.reload(),
      stopLoading: () => ref.current?.stopLoading(),
      injectJavaScript: (script) => ref.current?.injectJavaScript(script),
    });
    return () => registerPage(id, null);
  }, [id]);

  // An address asked of this tab (the address bar, a link from elsewhere).
  useEffect(() => {
    if (!request || request.n === lastRequest.current) return;
    lastRequest.current = request.n;
    if (request.url === source.uri) ref.current?.injectJavaScript(`window.location.assign(${JSON.stringify(request.url)});true;`);
    else setSource(sourceOf(request.url, gpc));
  }, [request, source.uri, gpc]);

  const seen = (e: { nativeEvent: object }): void => {
    const target = (e.nativeEvent as { target?: number }).target;
    if (typeof target === 'number' && target !== viewTag.current) {
      viewTag.current = target;
      setRuntime(id, { viewTag: target });
    }
  };

  const onLoadStart = (e: WebViewNavigationEvent): void => {
    seen(e);
    const { url, title, canGoBack, canGoForward, loading } = e.nativeEvent as WebViewNavigation;
    if (url === 'about:blank' && !tab.url) return;
    hidden.current = null;
    // A new page: its cookie banner is not known yet.
    setRuntime(id, { loading, canGoBack, canGoForward, ...(loading ? { progress: 0.05, cookieBanner: null } : {}) });
    pageNavigated(id, url, title && title !== url ? title : undefined);
    // A page that changes its own address without loading (a web app's views) is a visit too.
    if (!loading && WEB.test(url)) pageLoaded(id, url, title && title !== url && !/^https?:\/\//.test(title) ? title : '');
  };

  const onLoadProgress = (e: WebViewProgressEvent): void => {
    seen(e);
    const { progress, canGoBack, canGoForward, title, url } = e.nativeEvent;
    setRuntime(id, { progress: Math.max(progress, 0.05), loading: progress < 1, canGoBack, canGoForward });
    if (title && title !== url && !/^https?:\/\//.test(title)) pageTitled(id, title);
    // Hide what the site's filters name as soon as there is a document.
    if (progress > 0.3 && hidden.current !== url) {
      hidden.current = url;
      void hideElements(viewTag.current, url, (s) => ref.current?.injectJavaScript(s));
    }
  };

  const onLoadEnd = (e: WebViewNavigationEvent | WebViewErrorEvent): void => {
    seen(e);
    const { url, title, canGoBack, canGoForward } = e.nativeEvent;
    setRuntime(id, { loading: false, progress: 1, canGoBack, canGoForward });
    // A page that failed to load is not a visit.
    if (!WEB.test(url) || 'code' in e.nativeEvent) return;
    const name = title && title !== url && !/^https?:\/\//.test(title) ? title : '';
    pageLoaded(id, url, name);
    void hideElements(viewTag.current, url, (s) => ref.current?.injectJavaScript(s));
  };

  const onShouldStart = (req: ShouldStartLoadRequest): boolean => {
    if (IN_TAB.test(req.url)) return true;
    // Android catches these natively (modules/browser-kit); this is iOS, where a tap is a "click".
    if (Platform.OS !== 'android' && req.isTopFrame !== false && req.navigationType === 'click') void offerExternalLink(req.url, id);
    return false;
  };

  return (
    <View style={[StyleSheet.absoluteFill, !visible && styles.hidden]} pointerEvents={visible ? 'auto' : 'none'} testID={visible ? 'browser-page' : undefined}>
      <WebView
        key={epoch}
        ref={ref}
        source={source}
        style={styles.page}
        containerStyle={styles.page}
        originWhitelist={['*']}
        onShouldStartLoadWithRequest={onShouldStart}
        onLoadStart={onLoadStart}
        onLoadProgress={onLoadProgress}
        onLoadEnd={onLoadEnd}
        onOpenWindow={(e: WebViewOpenWindowEvent) => {
          const url = e.nativeEvent.targetUrl;
          if (WEB.test(url)) openTab(url, { openerId: id });
          else if (url) void offerExternalLink(url, id);
        }}
        // The page's process was stopped (memory) or crashed: the tab loads again where it was.
        onRenderProcessGone={() => {
          setSource(sourceOf(tab.url || source.uri, gpc));
          setEpoch((n) => n + 1);
        }}
        onContentProcessDidTerminate={() => ref.current?.reload()}
        renderError={(_domain: string | undefined, code: number, description: string) => <ErrorPage description={`${description} (${code})`} onRetry={() => ref.current?.reload()} />}
        userAgent={userAgent}
        injectedJavaScriptBeforeContentLoaded={Platform.OS === 'ios' && gpc ? GPC_PAGE_SCRIPT : undefined}
        injectedJavaScriptBeforeContentLoadedForMainFrameOnly={false}
        allowsFullscreenVideo
        allowsInlineMediaPlayback
        allowsBackForwardNavigationGestures
        allowsLinkPreview={false}
        setSupportMultipleWindows
        javaScriptCanOpenWindowsAutomatically={false}
        mediaPlaybackRequiresUserAction
        thirdPartyCookiesEnabled={false}
        sharedCookiesEnabled={false}
        geolocationEnabled={false}
        allowFileAccess={false}
        allowFileAccessFromFileURLs={false}
        allowUniversalAccessFromFileURLs={false}
        mixedContentMode="never"
        setBuiltInZoomControls
        setDisplayZoomControls={false}
        pullToRefreshEnabled
        downloadingMessage={t('Downloading')}
        lackPermissionToDownloadMessage={t('Corvus cannot save downloads on this phone.')}
        webviewDebuggingEnabled={__DEV__}
        autoManageStatusBarEnabled={false}
        testID={`webview-${id}`}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  page: {
    flex: 1,
  },
  hidden: {
    opacity: 0,
    zIndex: -1,
  },
  error: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: Space.md,
    padding: Space.xxl,
  },
  center: {
    textAlign: 'center',
  },
});
