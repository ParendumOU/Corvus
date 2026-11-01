/**
 * The dialog for a site that asks for a username and password (HTTP Basic or Digest), as in Chrome:
 * the site, its realm, a warning over plain http, and the username sent last filled in again when
 * the site refused it. Cancel leaves the page on the site's 401 error. The passwords saved in Corvus
 * for that site are offered first, sent once the phone's lock is passed.
 */
import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, View } from 'react-native';

import { Button } from '@/components/button';
import { Banner } from '@/components/feedback';
import { TextField } from '@/components/fields';
import { ThemedText } from '@/components/themed-text';
import { Elevation, Radius, Space } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import type { SignInPrompt } from '@/lib/http-auth';
import { t } from '@/lib/i18n';
import type { Login } from '@/lib/passwords';
import { unlockPasswords } from '@/lib/unlock';

export function SignInDialog({
  prompt,
  username: initialUsername,
  refused,
  logins = [],
  onAnswer,
}: {
  prompt: SignInPrompt;
  username: string;
  /** The site asked again right after a sign-in: it did not accept the username and password. */
  refused: boolean;
  /** Saved logins for this site, offered as one-tap sign-ins. */
  logins?: readonly Login[];
  /** The username and password to send, or null to cancel. */
  onAnswer: (credentials: { username: string; password: string } | null) => void;
}) {
  const theme = useTheme();
  const [username, setUsername] = useState(initialUsername);
  const [password, setPassword] = useState('');

  useEffect(() => {
    setUsername(initialUsername);
    setPassword('');
  }, [prompt, initialUsername]);

  const send = (): void => onAnswer({ username, password });

  const signInWith = async (login: Login): Promise<void> => {
    if (await unlockPasswords()) onAnswer({ username: login.username, password: login.password });
  };

  return (
    <Modal visible transparent animationType="fade" statusBarTranslucent navigationBarTranslucent onRequestClose={() => onAnswer(null)}>
      <Pressable style={[styles.scrim, { backgroundColor: theme.scrim }]} onPress={() => onAnswer(null)} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" />
      <KeyboardAvoidingView style={styles.wrap} behavior={Platform.OS === 'ios' ? 'padding' : 'height'} pointerEvents="box-none">
        <View style={[styles.dialog, { backgroundColor: theme.surfaceRaised }, Elevation.overlay]} accessibilityViewIsModal testID="sign-in-dialog">
          <ThemedText type="title" accessibilityRole="header">
            {t('Sign in')}
          </ThemedText>
          <ThemedText type="body" themeColor="textSecondary">
            {prompt.site ? t('{host} asks for a username and password', { host: prompt.site }) : t('This site asks for a username and password')}
          </ThemedText>
          {prompt.realm ? (
            <ThemedText type="small" themeColor="textSecondary" numberOfLines={3}>
              {t('The site says: {realm}', { realm: prompt.realm })}
            </ThemedText>
          ) : null}
          {logins.length > 0 ? (
            <View style={styles.saved}>
              {logins.slice(0, 3).map((l) => (
                <Button key={l.id} label={t('Sign in as {username}', { username: l.username || t('No username') })} icon="lock" kind="tonal" onPress={() => void signInWith(l)} testID={`sign-in-saved-${l.id}`} />
              ))}
            </View>
          ) : null}
          {!prompt.private ? <Banner tone="warning" message={t('Your connection to this site is not private: the username and password are sent unencrypted.')} /> : null}
          <TextField
            label={t('Username')}
            value={username}
            onChangeText={setUsername}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="username"
            autoFocus={!initialUsername}
            testID="sign-in-username"
          />
          <TextField
            label={t('Password')}
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="password"
            autoFocus={!!initialUsername}
            returnKeyType="go"
            onSubmitEditing={send}
            error={refused ? t('The site did not accept that username and password.') : null}
            testID="sign-in-password"
          />
          <View style={styles.actions}>
            <Button label={t('Cancel')} kind="text" onPress={() => onAnswer(null)} testID="sign-in-cancel" />
            <Button label={t('Sign in')} onPress={send} testID="sign-in-confirm" />
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  wrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: Space.xxl,
  },
  dialog: {
    width: '100%',
    maxWidth: 400,
    gap: Space.lg,
    paddingTop: Space.xxl,
    paddingHorizontal: Space.xxl,
    paddingBottom: Space.lg,
    borderRadius: Radius.xl,
  },
  saved: {
    gap: Space.sm,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: Space.sm,
    marginTop: Space.xs,
  },
});
