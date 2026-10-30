import { cmpDisplayName, parseConsentEvent, siteListMatches } from '@corvus/shared';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BackHandler, Keyboard, Platform, Share, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AddressBar } from '@/components/browser/address-bar';
import { FindBar } from '@/components/browser/find-bar';
import { ComputerPicker, PageMenu, SitePanel, type PageMenuAction } from '@/components/browser/page-menu';
import { StartPage } from '@/components/browser/start-page';
import { TabSwitcher } from '@/components/browser/tab-switcher';
import { Toolbar } from '@/components/browser/toolbar';
import { WebPage } from '@/components/browser/web-page';
import { showToast } from '@/components/feedback';
import { bookmarkPage, saveToReadingList, sendToComputer, unbookmarkPage, useSession, watch } from '@/hooks/use-session';
import { useTheme } from '@/hooks/use-theme';
import { addressTarget, engineById, isWebPage } from '@/lib/address';
import { siteAllowed } from '@/lib/blocklist';
import {
  activateTab,
  allowCookieBanner,
  allowSite,
  closeAllTabs,
  saveTabsNow,
  closeTab,
  loadInTab,
  newTab,
  openTab,
  recordConsent,
  runtimeOf,
  searchEngineId,
  setDesktopSite,
  setDeviceLabel,
  tabOfView,
  setRuntime,
  useBrowser,
} from '@/lib/browser-store';
import { pageOf } from '@/lib/browser-views';
import { configureBlocking, startBlocking } from '@/lib/content-blocking';
import { leaveApp } from '@/lib/default-browser';
import { offerExternalLink } from '@/lib/external-links';
import { t } from '@/lib/i18n';
import { PAGE_TEXT_SCRIPT, parsePageText } from '@/lib/page-ask';
import { handOffPage } from '@/lib/page-handoff';
import { tabHost } from '@/lib/replica';
import { sendTargets } from '@/lib/send';
import { activeTab, liveTabIds } from '@/lib/tabs';
import { nav } from '@/lib/nav';
import { BrowserKit, ConsentKit } from '../../modules/browser-kit';

/** The user agents to browse with (Android: the WebView's own, unmarked, and a desktop one). */
const AGENTS = (() => {
  try {
    return BrowserKit?.userAgents() ?? null;
  } catch {
    return null;
  }
})();

/** Leaves the browser for Corvus's Home. */
function goHome(): void {
  if (router.canGoBack()) router.back();
  else nav.replace('/');
}

/**
 * Corvus's browser: the tab on screen under an address bar, a toolbar at the bottom, the tabs in a
 * switcher and the page's actions in a menu. Opened from Home's address bar, from links in the app
 * and, as the phone's default browser, from links in other apps (`open`, with `incoming`).
 */
export default function BrowserScreen() {
  const params = useLocalSearchParams<{ open?: string; incoming?: string; edit?: string }>();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const browser = useBrowser();
  const session = useSession();
  const tab = activeTab(browser.tabs);
  const rt = tab ? runtimeOf(tab.id) : null;
  const engine = engineById(searchEngineId(session.homePage));
  const [editing, setEditing] = useState(false);
  const editingNow = useRef(false);
  editingNow.current = editing;
  const [draft, setDraft] = useState('');
  const [switcher, setSwitcher] = useState(false);
  const [menu, setMenu] = useState(false);
  const [panel, setPanel] = useState(false);
  const [finding, setFinding] = useState(false);
  const [sendPicker, setSendPicker] = useState(false);
  const live = useMemo(() => liveTabIds(browser.tabs), [browser.tabs]);
  const url = tab?.url ?? '';
  const paired = session.status === 'paired';
  const blocks = BrowserKit !== null;
  const answersBanners = ConsentKit !== null;
  const blockingHere = browser.prefs.blocking && !siteAllowed(tabHost(url), browser.prefs.allowedSites);
  const consentHere = !siteListMatches(tabHost(url), browser.prefs.consentAllowedSites);
  const bookmarked = useMemo(() => !!url && session.bookmarks.some((b) => b.kind === 'bookmark' && b.url === url), [session.bookmarks, url]);
  const targets = useMemo(() => sendTargets(session.devices, session.self, session.tabs), [session.devices, session.self, session.tabs]);
  const history = paired ? session.history : browser.localHistory;

  useEffect(() => {
    if (session.pairing) setDeviceLabel(session.pairing.deviceName);
  }, [session.pairing]);

  // Blocking starts with the browser, and follows its settings.
  useEffect(() => {
    if (!browser.loaded) return;
    void startBlocking(browser.prefs.blocking, browser.prefs.allowedSites);
    configureBlocking(browser.prefs.blocking, browser.prefs.allowedSites);
  }, [browser.loaded, browser.prefs.blocking, browser.prefs.allowedSites]);

  // Blocked counts and other apps' links, from the native side (Android).
  useEffect(() => {
    if (!BrowserKit) return;
    const subs = [
      BrowserKit.addListener('onBlocked', (e) => {
        const id = tabOfView(e.viewTag);
        if (id) setRuntime(id, { blocked: e.count });
      }),
      BrowserKit.addListener('onExternalLink', (e) => void offerExternalLink(e.url, tabOfView(e.viewTag))),
      BrowserKit.addListener('onPermissionRequest', (e) =>
        showToast(t('{site} asked for the camera or microphone: Corvus does not give sites access to them.', { site: tabHost(e.origin) || e.origin }), 'info'),
      ),
    ];
    return () => subs.forEach((s) => s.remove());
  }, []);

  // A page's cookie banner script reported (Android and iOS): checked again here, and only shown.
  useEffect(() => {
    const sub = ConsentKit?.addListener('onConsent', (e) => {
      const id = tabOfView(e.viewTag);
      const event = parseConsentEvent({ type: e.type, cmp: e.cmp, result: e.result, isCosmetic: e.isCosmetic });
      if (id && event) recordConsent(id, event);
    });
    return () => sub?.remove();
  }, []);

  // A link to open: from another app (Corvus as the default browser) or from Corvus itself.
  useEffect(() => {
    if (!browser.loaded) return;
    if (params.open) {
      openTab(params.open, { external: params.incoming === '1' });
      setEditing(false);
      router.setParams({ open: undefined, incoming: undefined });
    } else if (params.edit) {
      newTab();
      setDraft('');
      setEditing(true);
      router.setParams({ edit: undefined });
    }
  }, [browser.loaded, params.open, params.incoming, params.edit]);

  // No tab at all (the last one closed, or a first start): a new one, ready to type in.
  useEffect(() => {
    if (browser.loaded && browser.tabs.tabs.length === 0 && !params.open) {
      newTab();
      setDraft('');
      setEditing(true);
    }
  }, [browser.loaded, browser.tabs.tabs.length, params.open]);

  // A new tab shows the address bar ready to type in (what is being typed already stays).
  useEffect(() => {
    if (tab && tab.url === '' && !switcher) {
      if (!editingNow.current) setDraft('');
      setEditing(true);
    }
  }, [tab?.id, tab?.url, switcher]);

  const stopEditing = (): void => {
    Keyboard.dismiss();
    setEditing(false);
  };

  const go = (target: string | null): void => {
    if (!target) return;
    if (tab) loadInTab(tab.id, target);
    else openTab(target);
    stopEditing();
  };

  const back = useCallback((): boolean => {
    if (switcher) {
      setSwitcher(false);
      return true;
    }
    if (menu || panel || sendPicker) {
      setMenu(false);
      setPanel(false);
      setSendPicker(false);
      return true;
    }
    if (finding) {
      setFinding(false);
      return true;
    }
    if (editing && tab?.url) {
      stopEditing();
      return true;
    }
    if (tab && rt?.canGoBack) {
      pageOf(tab.id)?.goBack();
      return true;
    }
    if (tab?.external) {
      // A link another app opened: back closes it and returns to that app, as browsers do.
      closeTab(tab.id);
      saveTabsNow();
      goHome();
      void leaveApp();
      return true;
    }
    if (tab?.openerId) {
      closeTab(tab.id);
      return true;
    }
    goHome();
    return true;
  }, [menu, panel, sendPicker, finding, editing, tab, rt?.canGoBack, switcher]);

  useFocusEffect(
    useCallback(() => {
      if (Platform.OS === 'web') return undefined;
      const sub = BackHandler.addEventListener('hardwareBackPress', back);
      return () => sub.remove();
    }, [back]),
  );

  const ask = async (): Promise<void> => {
    if (!tab) return;
    const viewTag = runtimeOf(tab.id).viewTag;
    const raw = BrowserKit && viewTag !== null ? await BrowserKit.evaluate(viewTag, PAGE_TEXT_SCRIPT).catch(() => null) : null;
    handOffPage({ url: tab.url, title: tab.title, text: parsePageText(raw) });
    nav.push({ pathname: '/chat/[id]', params: { id: 'new', page: tab.url } });
  };

  const send = async (to: string): Promise<void> => {
    if (!tab) return;
    const computer = targets.find((d) => d.id === to);
    try {
      await sendToComputer({ url: tab.url, title: tab.title, to });
      showToast(t('Sent to {computer}', { computer: computer?.name ?? '' }));
    } catch (err) {
      showToast(t('That did not work: {error}', { error: err instanceof Error ? err.message : String(err) }), 'error');
    }
  };

  const keep = async (work: () => Promise<void>, done: string): Promise<void> => {
    try {
      await work();
      showToast(done);
    } catch (err) {
      showToast(t('That did not work: {error}', { error: err instanceof Error ? err.message : String(err) }), 'error');
    }
  };

  const onAction = (action: PageMenuAction): void => {
    if (action !== 'desktop' && action !== 'blocking') setMenu(false);
    if (!tab) return;
    const title = tab.title || tabHost(tab.url);
    switch (action) {
      case 'new-tab':
        newTab();
        setDraft('');
        setEditing(true);
        break;
      case 'ask':
        void ask();
        break;
      case 'send':
        if (targets.length === 0) showToast(t('No computer on this sync chain yet.'), 'warning');
        else if (targets.length === 1) void send(targets[0]!.id);
        else setSendPicker(true);
        break;
      case 'read-later':
        void keep(() => saveToReadingList(tab.url, tab.title), t('Saved to your reading list'));
        break;
      case 'bookmark':
        void (bookmarked ? keep(() => unbookmarkPage(tab.url), t('Bookmark removed')) : keep(() => bookmarkPage(tab.url, title), t('Bookmarked')));
        break;
      case 'watch':
        void keep(() => watch(tab.url, tab.title, 60, ''), t('Watching it for changes'));
        break;
      case 'share':
        void Share.share(Platform.OS === 'ios' ? { url: tab.url, message: tab.title } : { message: tab.url, title: tab.title });
        break;
      case 'find':
        setFinding(true);
        break;
      case 'open-in':
        nav.push({ pathname: '/open', params: { url: tab.url, from: 'browser' } });
        break;
      case 'desktop':
        setDesktopSite(tab.id, !tab.desktop);
        // The page loads again as the other kind of browser asks for it.
        setTimeout(() => pageOf(tab.id)?.reload(), 50);
        break;
      case 'blocking':
        void allowSite(tabHost(tab.url), blockingHere).then(() => pageOf(tab.id)?.reload());
        break;
      case 'settings':
        nav.push('/browser-settings');
        break;
    }
  };

  return (
    <View style={[styles.fill, { backgroundColor: theme.surface }]} testID="browser">
      <View style={{ paddingTop: insets.top, backgroundColor: theme.surface }}>
        <AddressBar
          url={url}
          field={tab?.id ?? ''}
          editing={editing}
          draft={draft}
          loading={!!rt?.loading && isWebPage(url)}
          blocked={blocks && isWebPage(url) ? (rt?.blocked ?? 0) : null}
          blockingOn={blockingHere}
          certError={!!rt?.certError}
          onDraft={setDraft}
          onEdit={() => {
            setDraft(url);
            setEditing(true);
          }}
          onSubmit={() => go(addressTarget(draft, engine))}
          onCancel={() => {
            if (tab?.url) stopEditing();
            else goHome();
          }}
          onReload={() => tab && pageOf(tab.id)?.reload()}
          onStop={() => tab && pageOf(tab.id)?.stopLoading()}
          onShield={() => setPanel(true)}
        />
        <View style={[styles.progressTrack, { opacity: rt?.loading && isWebPage(url) && !editing ? 1 : 0 }]}>
          <View style={[styles.progress, { width: `${Math.round((rt?.progress ?? 0) * 100)}%`, backgroundColor: theme.accent }]} testID="browser-progress" />
        </View>
        {finding && tab && rt?.viewTag != null ? <FindBar viewTag={rt.viewTag} onClose={() => setFinding(false)} /> : null}
      </View>

      <View style={[styles.fill, { backgroundColor: theme.background }]}>
        {browser.tabs.tabs
          .filter((x) => x.url !== '' && live.includes(x.id))
          .map((x) => (
            <WebPage
              key={x.id}
              tab={x}
              request={browser.requests[x.id]}
              visible={x.id === tab?.id && !editing}
              userAgent={AGENTS ? (x.desktop ? AGENTS.desktop : AGENTS.mobile) : undefined}
              gpc={browser.prefs.gpc}
              onLeave={back}
              onSend={paired && targets.length > 0 ? () => onAction('send') : undefined}
            />
          ))}
        {editing || !url ? (
          <View style={StyleSheet.absoluteFill}>
            <StartPage
              draft={editing ? draft : ''}
              engine={engine}
              tabs={browser.tabs.tabs.filter((x) => x.id !== tab?.id && x.url)}
              bookmarks={session.bookmarks}
              history={history}
              onOpen={(target) => go(target)}
              onSwitch={(id) => {
                if (tab && !tab.url) closeTab(tab.id);
                activateTab(id);
                stopEditing();
              }}
              onSearch={() => go(addressTarget(draft, engine))}
            />
          </View>
        ) : null}
      </View>

      {editing ? null : (
        <Toolbar
          canGoBack={!!rt?.canGoBack}
          canGoForward={!!rt?.canGoForward}
          tabCount={browser.tabs.tabs.length}
          bottomInset={insets.bottom}
          onBack={() => tab && pageOf(tab.id)?.goBack()}
          onForward={() => tab && pageOf(tab.id)?.goForward()}
          onHome={goHome}
          onTabs={() => setSwitcher(true)}
          onMenu={() => setMenu(true)}
        />
      )}

      <TabSwitcher
        open={switcher}
        tabs={browser.tabs.tabs}
        activeId={browser.tabs.activeId}
        onPick={(id) => {
          activateTab(id);
          setSwitcher(false);
          setEditing(false);
        }}
        onCloseTab={closeTab}
        onCloseAll={() => {
          closeAllTabs();
          setSwitcher(false);
        }}
        onNewTab={() => {
          newTab();
          setSwitcher(false);
          setDraft('');
          setEditing(true);
        }}
        onDismiss={() => setSwitcher(false)}
      />

      {tab ? (
        <PageMenu
          open={menu}
          url={tab.url}
          title={tab.title}
          paired={paired}
          bookmarked={bookmarked}
          desktop={!!tab.desktop}
          canDesktop={AGENTS !== null}
          canFind={blocks && rt?.viewTag != null}
          canBlock={blocks && browser.prefs.blocking}
          blockingHere={blockingHere}
          onAction={onAction}
          onClose={() => setMenu(false)}
        />
      ) : null}

      <SitePanel
        open={panel}
        url={url}
        certError={!!rt?.certError}
        blocked={rt?.blocked ?? 0}
        canBlock={blocks}
        blockingOn={browser.prefs.blocking}
        blockingHere={blockingHere}
        onToggle={() => {
          if (!tab) return;
          void allowSite(tabHost(tab.url), blockingHere).then(() => pageOf(tab.id)?.reload());
        }}
        consent={
          answersBanners && browser.prefs.cookieConsent
            ? { here: consentHere, banner: rt?.cookieBanner ? { ...rt.cookieBanner, cmp: cmpDisplayName(rt.cookieBanner.cmp) } : null, handled: browser.bannersHandled }
            : null
        }
        onToggleConsent={() => {
          if (!tab) return;
          void allowCookieBanner(tabHost(tab.url), consentHere).then(() => pageOf(tab.id)?.reload());
        }}
        onSettings={() => {
          setPanel(false);
          nav.push('/browser-settings');
        }}
        onClose={() => setPanel(false)}
      />

      <ComputerPicker
        open={sendPicker}
        computers={targets}
        onPick={(id) => {
          setSendPicker(false);
          void send(id);
        }}
        onClose={() => setSendPicker(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
  },
  progressTrack: {
    height: 2,
  },
  progress: {
    height: 2,
  },
});
