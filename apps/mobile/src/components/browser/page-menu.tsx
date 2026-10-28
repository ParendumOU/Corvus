import type { ConsentPageState, DeviceInfo } from '@corvus/shared';
import { Platform, StyleSheet, Switch, View } from 'react-native';

import { Favicon } from '@/components/favicon';
import { Icon } from '@/components/icon';
import { Sheet, SheetRow } from '@/components/sheet';
import { ThemedText } from '@/components/themed-text';
import { Space } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { isSecure, isWebPage } from '@/lib/address';
import { t } from '@/lib/i18n';
import { tabHost } from '@/lib/replica';

export type PageMenuAction = 'new-tab' | 'ask' | 'send' | 'read-later' | 'bookmark' | 'watch' | 'share' | 'find' | 'open-in' | 'desktop' | 'blocking' | 'settings';

function MenuSwitch({ value, onChange, label }: { value: boolean; onChange: (on: boolean) => void; label: string }) {
  const theme = useTheme();
  return (
    <Switch
      value={value}
      onValueChange={onChange}
      accessibilityLabel={label}
      trackColor={{ false: theme.borderStrong, true: theme.accent }}
      thumbColor={value ? theme.onAccent : theme.textSecondary}
      ios_backgroundColor={theme.borderStrong}
    />
  );
}

/** What can be done with the page on screen: Corvus's actions first, then the browser's own. */
export function PageMenu({
  open,
  url,
  title,
  paired,
  bookmarked,
  desktop,
  canFind,
  canBlock,
  blockingHere,
  onAction,
  onClose,
}: {
  open: boolean;
  url: string;
  title: string;
  paired: boolean;
  bookmarked: boolean;
  desktop: boolean;
  /** Find in page is available (Android). */
  canFind: boolean;
  /** This phone blocks ads and trackers (Android) and blocking is on. */
  canBlock: boolean;
  blockingHere: boolean;
  onAction: (action: PageMenuAction) => void;
  onClose: () => void;
}) {
  const theme = useTheme();
  const web = isWebPage(url);
  const needsPairing = paired ? undefined : t('Pair with a computer first');
  return (
    <Sheet
      open={open}
      onClose={onClose}
      testID="page-menu"
      header={
        web ? (
          <View style={styles.head}>
            <Favicon url={url} size={32} />
            <View style={styles.grow}>
              <ThemedText type="bodyStrong" numberOfLines={1}>
                {title || tabHost(url)}
              </ThemedText>
              <ThemedText type="small" themeColor="textSecondary" numberOfLines={1}>
                {url}
              </ThemedText>
            </View>
          </View>
        ) : null
      }>
      <SheetRow icon="plus" label={t('New tab')} onPress={() => onAction('new-tab')} testID="menu-new-tab" />
      {web ? (
        <>
          <View style={[styles.divider, { backgroundColor: theme.divider }]} />
          <SheetRow icon="sparkle" label={t('Ask Corvus about this page')} detail={needsPairing} disabled={!paired} onPress={() => onAction('ask')} active testID="menu-ask" />
          <SheetRow icon="send" label={t('Send to a computer')} detail={needsPairing} disabled={!paired} onPress={() => onAction('send')} testID="menu-send" />
          <SheetRow icon="book" label={t('Save to reading list')} detail={needsPairing} disabled={!paired} onPress={() => onAction('read-later')} testID="menu-read-later" />
          <SheetRow
            icon={bookmarked ? 'starFilled' : 'star'}
            label={bookmarked ? t('Bookmarked') : t('Bookmark')}
            detail={needsPairing ?? (bookmarked ? t('Tap to remove the bookmark') : undefined)}
            disabled={!paired}
            active={bookmarked}
            onPress={() => onAction('bookmark')}
            testID="menu-bookmark"
          />
          <SheetRow icon="eye" label={t('Watch this page')} detail={needsPairing ?? t('Your computers check it for changes')} disabled={!paired} onPress={() => onAction('watch')} testID="menu-watch" />
          <View style={[styles.divider, { backgroundColor: theme.divider }]} />
          <SheetRow icon="share" label={t('Share')} onPress={() => onAction('share')} testID="menu-share" />
          {canFind ? <SheetRow icon="search" label={t('Find in page')} onPress={() => onAction('find')} testID="menu-find" /> : null}
          {Platform.OS === 'android' ? <SheetRow icon="external" label={t('Open in…')} detail={t('Another browser, or send or keep the link')} onPress={() => onAction('open-in')} testID="menu-open-in" /> : null}
          <SheetRow icon="monitor" label={t('Desktop site')} onPress={() => onAction('desktop')} trailing={<MenuSwitch value={desktop} onChange={() => onAction('desktop')} label={t('Desktop site')} />} testID="menu-desktop" />
          {canBlock ? (
            <SheetRow
              icon={blockingHere ? 'shieldCheck' : 'shieldOff'}
              label={t('Block ads and trackers here')}
              detail={tabHost(url)}
              onPress={() => onAction('blocking')}
              trailing={<MenuSwitch value={blockingHere} onChange={() => onAction('blocking')} label={t('Block ads and trackers here')} />}
              testID="menu-blocking"
            />
          ) : null}
          {!isSecure(url) ? (
            <View style={styles.note}>
              <Icon name="unlock" size={18} color={theme.warning} />
              <ThemedText type="small" style={[styles.grow, { color: theme.warning }]}>
                {t('The connection to this site is not encrypted: do not type passwords or card numbers here.')}
              </ThemedText>
            </View>
          ) : null}
        </>
      ) : null}
      <View style={[styles.divider, { backgroundColor: theme.divider }]} />
      <SheetRow icon="settings" label={t('Browser settings')} onPress={() => onAction('settings')} testID="menu-settings" />
    </Sheet>
  );
}

/** Cookie banners on the page on screen (Android, with "Reject cookie banners" on). */
export interface SiteConsent {
  /** Corvus answers this site's banners (it is not one that keeps its banner). */
  here: boolean;
  /** What happened to the page's banner, with the platform's readable name. */
  banner: ConsentPageState | null;
  /** Banners rejected or hidden since the app started. */
  handled: number;
}

function bannerLine(banner: ConsentPageState | null): string {
  if (!banner) return t('No cookie banner to answer on this page');
  const cmp = banner.cmp;
  switch (banner.outcome) {
    case 'rejected':
      return cmp ? t('Cookie banner rejected ({cmp})', { cmp }) : t('Cookie banner rejected');
    case 'hidden':
      return cmp ? t('Cookie banner hidden ({cmp})', { cmp }) : t('Cookie banner hidden');
    case 'failed':
      return cmp ? t('Cookie banner could not be answered ({cmp})', { cmp }) : t('Cookie banner could not be answered');
    default:
      return cmp ? t('Answering the cookie banner ({cmp})…', { cmp }) : t('Answering the cookie banner…');
  }
}

/**
 * Tapping the shield: whether the page is encrypted, what was blocked on it, blocking for the site,
 * and what happened to its cookie banner, with the site's exception.
 */
export function SitePanel({
  open,
  url,
  blocked,
  canBlock,
  blockingOn,
  blockingHere,
  consent,
  onToggle,
  onToggleConsent,
  onSettings,
  onClose,
}: {
  open: boolean;
  url: string;
  blocked: number;
  canBlock: boolean;
  /** Blocking is on in Settings. */
  blockingOn: boolean;
  blockingHere: boolean;
  /** Null where cookie banners are not answered (iOS, the web build, the setting off). */
  consent: SiteConsent | null;
  onToggle: () => void;
  onToggleConsent: () => void;
  onSettings: () => void;
  onClose: () => void;
}) {
  const theme = useTheme();
  const secure = isSecure(url);
  return (
    <Sheet
      open={open}
      onClose={onClose}
      testID="site-panel"
      header={
        <View style={styles.head}>
          <Favicon url={url} size={32} />
          <ThemedText type="heading" numberOfLines={1} style={styles.grow}>
            {tabHost(url) || url}
          </ThemedText>
        </View>
      }>
      <SheetRow
        icon={secure ? 'lock' : 'unlock'}
        label={secure ? t('Connection is secure') : t('Connection is not secure')}
        detail={secure ? t('What you send to this site is encrypted on the way.') : t('Do not type passwords or card numbers here.')}
        testID="site-connection"
      />
      {canBlock ? (
        <>
          <SheetRow
            icon={blockingHere && blockingOn ? 'shieldCheck' : 'shieldOff'}
            label={blockingOn ? (blocked === 1 ? t('1 ad or tracker blocked on this page') : t('{n} ads and trackers blocked on this page', { n: blocked })) : t('Ad and tracker blocking is off')}
            detail={blockingOn ? t('Requests to ad and tracker hosts from the filter lists your computers use (EasyList, EasyPrivacy and more) never leave the phone.') : undefined}
            testID="site-blocked"
          />
          {blockingOn ? (
            <SheetRow
              icon="shield"
              label={t('Block ads and trackers on this site')}
              detail={blockingHere ? undefined : t('Off for this site: the page loads everything.')}
              onPress={onToggle}
              trailing={<MenuSwitch value={blockingHere} onChange={onToggle} label={t('Block ads and trackers on this site')} />}
              testID="site-toggle"
            />
          ) : null}
        </>
      ) : null}
      {consent && isWebPage(url) ? (
        <>
          {consent.here ? (
            <SheetRow
              icon="cookie"
              label={bannerLine(consent.banner)}
              detail={consent.handled === 1 ? t('1 cookie banner rejected since Corvus started') : t('{n} cookie banners rejected since Corvus started', { n: consent.handled })}
              active={consent.banner?.outcome === 'rejected' || consent.banner?.outcome === 'hidden'}
              testID="site-cookie-banner"
            />
          ) : null}
          <SheetRow
            icon="cookie"
            label={t('Allow this site’s cookie banner')}
            detail={consent.here ? t('Corvus rejects it for you.') : t('Corvus leaves it for you to answer.')}
            onPress={onToggleConsent}
            trailing={<MenuSwitch value={!consent.here} onChange={onToggleConsent} label={t('Allow this site’s cookie banner')} />}
            testID="site-cookie-allow"
          />
        </>
      ) : null}
      <SheetRow icon="settings" label={t('Browser settings')} onPress={onSettings} testID="site-settings" />
    </Sheet>
  );
}

/** A computer picker for "Send to a computer" when there are several. */
export function ComputerPicker({ open, computers, onPick, onClose }: { open: boolean; computers: readonly DeviceInfo[]; onPick: (id: string) => void; onClose: () => void }) {
  return (
    <Sheet open={open} onClose={onClose} header={<ThemedText type="title" style={styles.title}>{t('Send to a computer')}</ThemedText>} testID="send-picker">
      {computers.map((c) => (
        <SheetRow key={c.id} icon="screen" label={c.name} onPress={() => onPick(c.id)} testID={`send-pick-${c.name}`} />
      ))}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.md,
    paddingHorizontal: Space.xl,
    paddingBottom: Space.sm,
  },
  title: {
    paddingHorizontal: Space.xl,
    paddingBottom: Space.sm,
  },
  grow: {
    flex: 1,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    marginVertical: Space.xs,
    marginHorizontal: Space.lg,
  },
  note: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Space.md,
    paddingHorizontal: Space.lg,
    paddingVertical: Space.sm,
  },
});
