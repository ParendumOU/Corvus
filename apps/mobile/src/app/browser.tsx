import { cmpDisplayName, parseConsentEvent, siteListMatches } from '@corvus/shared';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BackHandler, Keyboard, Platform, Share, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AddressBar } from '@/components/browser/address-bar';
import { CvvDialog } from '@/components/browser/cvv-dialog';
import { FindBar } from '@/components/browser/find-bar';
import { AddressPicker, CardPicker, ComputerPicker, LoginPicker, PageMenu, SitePanel, type PageMenuAction } from '@/components/browser/page-menu';
import { SignInDialog } from '@/components/browser/sign-in-dialog';
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
  browserState,
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
import { SignInMemory, signInPrompt, type SignInPrompt } from '@/lib/http-auth';
import { offerExternalLink } from '@/lib/external-links';
import { t, tn } from '@/lib/i18n';
import { cardFillAllowed, fillAddressScript, fillCardScript, pageOrigin } from '@/lib/form-fill';
import type { SavedAddress } from '@/lib/autofill-addresses';
import type { SavedCard } from '@/lib/autofill-cards';
import { fillLoginScript, loginsFor, type Login } from '@/lib/passwords';
import { savedAddresses, savedCards, savedLogins } from '@/lib/session';
import { unlockPasswords } from '@/lib/unlock';
import { PAGE_TEXT_SCRIPT, parsePageText } from '@/lib/page-ask';
import { handOffPage } from '@/lib/page-handoff';
import { tabHost } from '@/lib/replica';
import { sendTargets } from '@/lib/send';
import { activeTab, liveTabIds } from '@/lib/tabs';
import { nav } from '@/lib/nav';
import { BrowserKit, ConsentKit, type HttpAuthRequestEvent } from '../../modules/browser-kit';

/** The user agents to browse with (Android: the WebView's own, unmarked, and a desktop one). */
const AGENTS = (() => {
  try {
    return BrowserKit?.userAgents() ?? null;
  } catch {
    return null;
  }
})();

/** The usernames sent to sites that asked for one, filled in again when a site refuses them. */
const signInMemory = new SignInMemory();

/** A site's sign-in request on screen: the native request, its tab and what the dialog shows. */
interface SignInAsk {
  request: HttpAuthRequestEvent;
  tabId: string;
  prompt: SignInPrompt;
  username: string;
  refused: boolean;
  /** Saved logins for the host asking. */
  logins: Login[];
}

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
  const [signIn, setSignIn] = useState<SignInAsk | null>(null);
  const loginsNow = useRef<Login[]>([]);
  const signIns = useRef<HttpAuthRequestEvent[]>([]);
  const signInShown = useRef<SignInAsk | null>(null);
  const live = useMemo(() => liveTabIds(browser.tabs), [browser.tabs]);
  const url = tab?.url ?? '';
  const paired = session.status === 'paired';
  // The saved passwords, read again after each sync; only the current site's are offered.
  const [logins, setLogins] = useState<Login[]>([]);
  const [loginPicker, setLoginPicker] = useState(false);
  // The saved addresses (any site): the picker remembers the page it was opened over, and the fill refuses another.
  const [addresses, setAddresses] = useState<SavedAddress[]>([]);
  const [addressPicker, setAddressPicker] = useState<{ tabId: string; origin: string } | null>(null);
  // The saved cards, the same way; the CVV asked after the pick lives in its dialog only.
  const [cards, setCards] = useState<SavedCard[]>([]);
  const [cardPicker, setCardPicker] = useState<{ tabId: string; origin: string } | null>(null);
  const [cvvFor, setCvvFor] = useState<{ card: SavedCard; tabId: string; origin: string } | null>(null);
  loginsNow.current = logins;
  useEffect(() => {
    // Unpaired: the chain's logins, addresses and cards (a card waiting for its CVV too) go at once.
    if (!session.pairing) {
      setLogins([]);
      setAddresses([]);
      setCards([]);
      setCvvFor(null);
      return;
    }
    if (session.refreshing) return;
    let live = true;
    void savedLogins(session.pairing)
      .then((all) => live && setLogins(all))
      .catch(() => undefined);
    void savedAddresses(session.pairing)
      .then((all) => live && setAddresses(all))
      .catch(() => undefined);
    void savedCards(session.pairing)
      .then((all) => live && setCards(all))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [session.pairing, session.refreshing]);
  const pageLogins = useMemo(() => (tab && isWebPage(tab.url) ? loginsFor(logins, tab.url) : []), [logins, tab?.url]);
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
      BrowserKit.addListener('onHttpAuthRequest', (e) => {
        signIns.current.push(e);
        if (!signInShown.current) showSignIn(nextSignIn());
      }),
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
      nav.setParams({ open: undefined, incoming: undefined });
    } else if (params.edit) {
      newTab();
      setDraft('');
      setEditing(true);
      nav.setParams({ edit: undefined });
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

  // The usernames sent from tabs that closed are forgotten.
  useEffect(() => {
    signInMemory.keepTabs(new Set(browser.tabs.tabs.map((x) => x.id)));
  }, [browser.tabs.tabs]);

  // The next site's sign-in request to ask about (one at a time); a closed tab's is cancelled.
  const nextSignIn = (): SignInAsk | null => {
    for (let e = signIns.current.shift(); e; e = signIns.current.shift()) {
      const tabId = tabOfView(e.viewTag);
      const page = tabId ? browserState().tabs.tabs.find((x) => x.id === tabId) : undefined;
      if (!tabId || !page) {
        void BrowserKit?.answerHttpAuth(e.id, null, null);
        continue;
      }
      if (activeTab(browserState().tabs)?.id !== tabId) activateTab(tabId);
      const { username, refused } = signInMemory.recall(tabId, e.host, e.realm, Date.now());
      const prompt = signInPrompt(e.host, e.realm, page.url);
      return { request: e, tabId, prompt, username, refused, logins: loginsFor(loginsNow.current, prompt.private ? e.host : `http://${e.host}`) };
    }
    return null;
  };

  const showSignIn = (ask: SignInAsk | null): void => {
    signInShown.current = ask;
    setSignIn(ask);
  };

  const answerSignIn = (credentials: { username: string; password: string } | null): void => {
    const ask = signInShown.current;
    if (!ask) return;
    if (credentials) signInMemory.remember(ask.tabId, ask.request.host, ask.request.realm, credentials.username, Date.now());
    void BrowserKit?.answerHttpAuth(ask.request.id, credentials?.username ?? null, credentials?.password ?? null);
    showSignIn(nextSignIn());
  };

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

  // Fills a saved login into the page, after the phone's lock; only into the site it belongs to.
  const fillLogin = async (login: Login): Promise<void> => {
    setLoginPicker(false);
    if (!tab || !loginsFor([login], tab.url).length) return;
    if (!(await unlockPasswords())) return;
    pageOf(tab.id)?.injectJavaScript(`${fillLoginScript(login)}\ntrue;`);
  };

  // Runs a fill script in the tab it was picked for; nothing once that tab went to another site.
  const runFill = async (opened: { tabId: string; origin: string }, script: string, none: string): Promise<void> => {
    if (!tab || opened.tabId !== tab.id || pageOrigin(tab.url) !== opened.origin) return;
    const viewTag = runtimeOf(tab.id).viewTag;
    if (!BrowserKit || viewTag === null) {
      pageOf(tab.id)?.injectJavaScript(`${script};\ntrue;`);
      return;
    }
    const raw = await BrowserKit.evaluate(viewTag, script).catch(() => null);
    if (raw === null) return;
    const filled = Number(raw);
    if (filled > 0) showToast(tn(filled, '1 field filled', '{n} fields filled'));
    else if (filled === 0) showToast(none, 'warning');
  };

  const fillAddress = async (address: SavedAddress): Promise<void> => {
    const opened = addressPicker;
    setAddressPicker(null);
    if (opened) await runFill(opened, fillAddressScript(address, opened.origin), t('No empty address field on this page.'));
  };

  // Cards ask for the phone's lock first, as passwords do: nothing checks the CVV, so on an unlocked
  // phone it alone would prove nothing.
  const openCardPicker = async (opened: { tabId: string; origin: string }): Promise<void> => {
    if (await unlockPasswords()) setCardPicker(opened);
  };

  // The CVV goes from its dialog into the script once and is not kept anywhere. The lock is asked
  // again when it closed meanwhile (the app went to the background, or minutes passed).
  const fillCard = async (cvv: string | null): Promise<void> => {
    const asked = cvvFor;
    setCvvFor(null);
    if (!asked || cvv === null || !(await unlockPasswords())) return;
    await runFill(asked, fillCardScript(asked.card, cvv, asked.origin), t('No empty card field on this page.'));
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
      case 'fill-password':
        if (pageLogins.length === 1) void fillLogin(pageLogins[0]!);
        else setLoginPicker(true);
        break;
      case 'fill-address':
        if (pageOrigin(tab.url)) setAddressPicker({ tabId: tab.id, origin: pageOrigin(tab.url) });
        break;
      case 'fill-card': {
        const origin = pageOrigin(tab.url);
        if (cardFillAllowed(origin)) void openCardPicker({ tabId: tab.id, origin });
        else showToast(t('Corvus fills cards only into secure (https) pages.'), 'warning');
        break;
      }
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
          logins={pageLogins.length}
          addresses={addresses.length}
          cards={cards.length}
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

      <LoginPicker open={loginPicker} logins={pageLogins} onPick={(l) => void fillLogin(l)} onClose={() => setLoginPicker(false)} />

      <AddressPicker open={addressPicker !== null} addresses={addresses} onPick={(a) => void fillAddress(a)} onClose={() => setAddressPicker(null)} />

      <CardPicker
        open={cardPicker !== null}
        cards={cards}
        onPick={(card) => {
          const opened = cardPicker;
          setCardPicker(null);
          if (opened) setCvvFor({ card, ...opened });
        }}
        onClose={() => setCardPicker(null)}
      />

      <CvvDialog card={cvvFor?.card ?? null} onAnswer={(cvv) => void fillCard(cvv)} />

      {signIn ? <SignInDialog prompt={signIn.prompt} username={signIn.username} refused={signIn.refused} logins={signIn.refused ? [] : signIn.logins} onAnswer={answerSignIn} /> : null}

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
