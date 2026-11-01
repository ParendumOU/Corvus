/**
 * The passwords saved in Corvus on the computers, synced to the phone (end-to-end encrypted, and
 * sealed again in the phone's storage). Read only: they are added and changed on a computer. Copying
 * or showing a password asks for the phone's lock first.
 */
import * as Clipboard from 'expo-clipboard';
import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Card } from '@/components/card';
import { EmptyState, LoadingState } from '@/components/empty-state';
import { Favicon } from '@/components/favicon';
import { Banner, showToast } from '@/components/feedback';
import { SearchField } from '@/components/fields';
import { ListRow } from '@/components/list';
import { Button } from '@/components/button';
import { Screen } from '@/components/screen';
import { ThemedText } from '@/components/themed-text';
import { Space } from '@/constants/theme';
import { refreshSession, useSession } from '@/hooks/use-session';
import { t } from '@/lib/i18n';
import { openInApp } from '@/lib/open-url';
import { filterLogins, loginHost, type Login } from '@/lib/passwords';
import { savedLogins } from '@/lib/session';
import { unlockPasswords } from '@/lib/unlock';

/** A copied password is cleared from the clipboard after this long, unless something else replaced it. */
const CLEAR_CLIPBOARD_MS = 60 * 1000;

async function copy(text: string, what: string): Promise<void> {
  await Clipboard.setStringAsync(text);
  showToast(what);
}

function LoginCard({ login }: { login: Login }) {
  const [shown, setShown] = useState(false);

  const withLock = async (action: () => Promise<void> | void): Promise<void> => {
    if (await unlockPasswords()) await action();
  };

  const copyPassword = (): Promise<void> =>
    withLock(async () => {
      await copy(login.password, t('Password copied'));
      setTimeout(() => {
        void Clipboard.getStringAsync()
          .then((now) => (now === login.password ? Clipboard.setStringAsync('') : undefined))
          .catch(() => undefined);
      }, CLEAR_CLIPBOARD_MS);
    });

  return (
    <Card padded={false} testID={`login-${login.id}`}>
      <ListRow
        leading={<Favicon url={login.origin} />}
        title={
          <ThemedText type="bodyStrong" numberOfLines={1}>
            {loginHost(login.origin)}
          </ThemedText>
        }
        subtitle={login.username || t('No username')}
        accessibilityRole="link"
        accessibilityHint={t('Opens the site')}
        onPress={() => void openInApp(login.origin)}
      />
      <View style={styles.body}>
        {shown ? (
          <ThemedText type="body" selectable testID={`login-password-${login.id}`}>
            {login.password}
          </ThemedText>
        ) : null}
        {shown && login.notes ? (
          <ThemedText type="small" themeColor="textSecondary">
            {login.notes}
          </ThemedText>
        ) : null}
        <View style={styles.actions}>
          {login.username ? <Button label={t('Copy username')} kind="text" onPress={() => void copy(login.username, t('Username copied'))} testID={`login-copy-user-${login.id}`} /> : null}
          <Button label={t('Copy password')} kind="tonal" onPress={() => void copyPassword()} testID={`login-copy-password-${login.id}`} />
          <Button label={shown ? t('Hide') : t('Show')} kind="text" onPress={() => (shown ? setShown(false) : void withLock(() => setShown(true)))} testID={`login-show-${login.id}`} />
        </View>
      </View>
    </Card>
  );
}

export default function PasswordsScreen() {
  const session = useSession();
  const [logins, setLogins] = useState<Login[] | null>(null);
  const [query, setQuery] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!session.pairing) return;
    setLogins(await savedLogins(session.pairing).catch(() => []));
  }, [session.pairing]);

  // Read again after every sync (a computer may have added or changed one).
  useEffect(() => {
    void load();
  }, [load, session.refreshing]);

  const refresh = async (): Promise<void> => {
    setRefreshing(true);
    try {
      await refreshSession();
      await load();
    } finally {
      setRefreshing(false);
    }
  };

  if (!session.pairing) {
    return (
      <Screen>
        <EmptyState icon="lock" title={t('No passwords yet')} description={t('Pair this phone with a computer to see the passwords saved in Corvus there.')} />
      </Screen>
    );
  }

  const shown = logins ? filterLogins(logins, query) : [];
  return (
    <Screen refreshing={refreshing} onRefresh={() => void refresh()} testID="passwords-screen">
      <Banner tone="info" message={t('The passwords saved in Corvus on your computers. Add or change them there; they sync to this phone end-to-end encrypted.')} />
      {logins === null ? (
        <LoadingState />
      ) : logins.length === 0 ? (
        <EmptyState icon="lock" title={t('No passwords yet')} description={t('Save passwords in Corvus on a computer, or import them there from another browser. They appear here after the next sync.')} />
      ) : (
        <View style={styles.list}>
          <SearchField value={query} onChangeText={setQuery} placeholder={t('Search passwords')} testID="passwords-search" />
          {shown.length === 0 ? (
            <ThemedText type="body" themeColor="textSecondary">
              {t('No password matches.')}
            </ThemedText>
          ) : (
            shown.map((l) => <LoginCard key={l.id} login={l} />)
          )}
        </View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  list: {
    gap: Space.md,
  },
  body: {
    paddingHorizontal: Space.lg,
    paddingBottom: Space.sm,
    gap: Space.sm,
  },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
    gap: Space.xs,
  },
});
