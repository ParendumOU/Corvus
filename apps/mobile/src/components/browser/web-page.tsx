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
import { certErrorOf, type CertErrorKind } from '@/lib/cert-errors';
import { offerExternalLink } from '@/lib/external-links';
import { t } from '@/lib/i18n';
import { tabHost } from '@/lib/replica';
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
/** How long after a load finished without an error it counts as a visit. */
const VISIT_AFTER_MS = 300;

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

/** What is wrong with the certificate, in a sentence or two. */
function explanation(kind: CertErrorKind, host: string): string {
  switch (kind) {
    case 'authority':
      return t('The certificate of {host} was not issued by an authority your phone trusts. Routers and other home devices often use certificates like this, but so can someone intercepting your connection.', { host });
    case 'untrusted':
      return t('The certificate of {host} cannot be trusted: it was not issued by an authority your phone trusts, or it was issued for another site. Routers and other home devices often use certificates like this, but so can someone intercepting your connection.', { host });
    case 'expired':
      return t("The certificate of {host} has expired. The site may be misconfigured, or your phone's date and time may be wrong.", { host });
    case 'not-yet-valid':
      return t("The certificate of {host} is not valid yet. Check that your phone's date and time are right.", { host });
    case 'date':
      return t("The certificate of {host} is outside its valid dates. Check that your phone's date and time are right.", { host });
    case 'name':
      return t('The certificate was issued for another site, not for {host}. The site may be misconfigured, or someone may be intercepting your connection.', { host });
    case 'invalid':
      return t('The certificate of {host} is damaged or not valid.', { host });
  }
}

/**
 * "Your connection is not private": the page of a site whose certificate is not valid. The phone
 * offers no way past it (an app's WebView that lets people skip certificate errors is refused by
 * Google Play); a device the person trusts, like a router, opens in Corvus on their computer.
 */
function CertErrorPage({ host, kind, onLeave, onSend }: { host: string; kind: CertErrorKind; onLeave: () => void; onSend?: () => void }) {
  const theme = useTheme();
  return (
    <View style={[StyleSheet.absoluteFill, styles.error, { backgroundColor: theme.background }]} testID="browser-cert-error">
      <Icon name="warning" size={40} color={theme.danger} />
      <ThemedText type="heading" style={styles.center}>
        {t('Your connection is not private')}
      </ThemedText>
      <ThemedText type="small" style={styles.center}>
        {t('Someone could be trying to steal your information from {host} (for example passwords, messages or card numbers).', { host })}
      </ThemedText>
      <ThemedText type="small" themeColor="textSecondary" style={styles.center}>
        {explanation(kind, host)}
      </ThemedText>
      <ThemedText type="small" themeColor="textSecondary" style={styles.center}>
        {t('Corvus on your phone does not open sites whose certificate is not valid. If you trust this one (your router, for example), open it in Corvus on your computer.')}
      </ThemedText>
      <View style={styles.actions}>
        <Button label={t('Back to safety')} onPress={onLeave} testID="browser-cert-back" />
        {onSend ? <Button label={t('Send to a computer')} icon="send" kind="tonal" onPress={onSend} testID="browser-cert-send" /> : null}
      </View>
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
export function WebPage({
  tab,
  request,
  visible,
  userAgent,
  gpc,
  onLeave,
  onSend,
}: {
  tab: BrowserTab;
  request: LoadRequest | undefined;
  visible: boolean;
  userAgent: string | undefined;
  gpc: boolean;
  /** Leaves a page that did not open (back, else what the back button does then). */
  onLeave: () => void;
  /** Sends the tab's address to a computer; unset when there is none to send to. */
  onSend?: () => void;
}) {
  const ref = useRef<WebViewHandle>(null);
  // The page a remount starts from: the tab's address (a restarted or woken tab), else what was asked.
  const [source, setSource] = useState(() => sourceOf(tab.url || request?.url || 'about:blank', gpc));
  const [epoch, setEpoch] = useState(0);
  const viewTag = useRef<number | null>(null);
  const lastRequest = useRef(request?.n ?? 0);
  const hidden = useRef<string | null>(null);
  // A navigation stopped at a certificate error (`refused`) never replaces the page that last loaded,
  // which the WebView keeps under the error page: back shows that page again (going back in history
  // would skip it), and reload tries the refused address again.
  const loaded = useRef<string | null>(null);
  const refused = useRef<string | null>(null);
  const [refusal, setRefusal] = useState<{ url: string; kind: CertErrorKind } | null>(null);
  // The last address the page itself asked to open in the tab (a link, a form, a script).
  const asked = useRef<string | null>(null);
  // The address whose load failed last: Android then shows its error page as a page of that address.
  const failed = useRef<string | null>(null);
  const visit = useRef<ReturnType<typeof setTimeout> | null>(null);
  const id = tab.id;

  useEffect(() => {
    const stillUnder = (): boolean => refused.current !== null && loaded.current !== null;
    registerPage(id, {
      goBack: () => (stillUnder() ? ref.current?.injectJavaScript('location.reload();true;') : ref.current?.goBack()),
      goForward: () => ref.current?.goForward(),
      reload: () => (stillUnder() ? ref.current?.injectJavaScript(`location.assign(${JSON.stringify(refused.current)});true;`) : ref.current?.reload()),
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
    // Another page is on screen now (Android reports a reload as not loading).
    if (refused.current) {
      refused.current = null;
      setRefusal(null);
    }
    // A new page: its cookie banner is not known yet.
    setRuntime(id, { loading, canGoBack, canGoForward, certError: null, ...(loading ? { progress: 0.05, cookieBanner: null } : {}) });
    pageNavigated(id, url, title && title !== url ? title : undefined);
    // A page that changes its own address without loading (a web app's views) is a visit too.
    if (!loading && WEB.test(url) && url !== failed.current) pageLoaded(id, url, title && title !== url && !/^https?:\/\//.test(title) ? title : '');
  };

  const onLoadProgress = (e: WebViewProgressEvent): void => {
    seen(e);
    // Android goes on reporting the refused load's first progress: it never finishes.
    if (refused.current) return;
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
    setRuntime(id, { loading: false, progress: 1, canGoBack: canGoBack || (refused.current !== null && loaded.current !== null), canGoForward });
    // A page that failed to load is not a visit. Android reports a failed load as finished just
    // before its error, so a load is a visit once no error followed it.
    if (!WEB.test(url) || 'code' in e.nativeEvent) return;
    const name = title && title !== url && !/^https?:\/\//.test(title) ? title : '';
    if (visit.current) clearTimeout(visit.current);
    visit.current = setTimeout(() => {
      visit.current = null;
      loaded.current = url;
      failed.current = null;
      pageLoaded(id, url, name);
      void hideElements(viewTag.current, url, (s) => ref.current?.injectJavaScript(s));
    }, VISIT_AFTER_MS);
  };

  /** The tab stops at `url`, whose certificate is not valid: the error page, the address, "Not secure". */
  const refuse = (url: string, kind: CertErrorKind): void => {
    if (visit.current) clearTimeout(visit.current);
    visit.current = null;
    refused.current = url;
    setRefusal({ url, kind });
    pageNavigated(id, url, undefined);
    setRuntime(id, { certError: kind, loading: false, progress: 1, ...(loaded.current ? { canGoBack: true } : {}) });
  };

  const onShouldStart = (req: ShouldStartLoadRequest): boolean => {
    if (req.isTopFrame !== false) asked.current = req.url;
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
        onError={(e: WebViewErrorEvent) => {
          if (visit.current) clearTimeout(visit.current);
          visit.current = null;
          // Android reports no start for a load that never commits, and its error carries the failed
          // address; on iOS the load started (the tab has its address) and the error carries the page shown.
          failed.current = Platform.OS === 'android' ? e.nativeEvent.url : tab.url;
          const kind = certErrorOf(e.nativeEvent.domain, e.nativeEvent.code, Platform.OS);
          if (kind) refuse(failed.current, kind);
        }}
        // Android takes the certificate error of a link the page opened for a subresource's (the tab's
        // address is not the link's yet), and the page stays as it was.
        onLoadSubResourceError={(e: WebViewErrorEvent) => {
          const kind = certErrorOf(e.nativeEvent.domain, e.nativeEvent.code, Platform.OS);
          if (kind && e.nativeEvent.url === asked.current) refuse(e.nativeEvent.url, kind);
        }}
        // A certificate error shows the tab's own page over the WebView (below).
        renderError={(domain: string | undefined, code: number, description: string) =>
          certErrorOf(domain, code, Platform.OS) ? <View /> : <ErrorPage description={`${description} (${code})`} onRetry={() => ref.current?.reload()} />
        }
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
      {refusal ? <CertErrorPage host={tabHost(refusal.url) || refusal.url} kind={refusal.kind} onLeave={onLeave} onSend={onSend} /> : null}
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
  actions: {
    alignItems: 'center',
    gap: Space.sm,
    marginTop: Space.sm,
  },
});
