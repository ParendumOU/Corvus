import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import * as Device from 'expo-device';
import { router } from 'expo-router';
import { useRef, useState } from 'react';
import { Platform, ScrollView, StyleSheet, TextInput, View } from 'react-native';

import { Button } from '@/components/button';
import { CardHeader } from '@/components/card';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { MaxContentWidth, Spacing } from '@/constants/theme';
import { pairPhone } from '@/hooks/use-session';
import { useTheme } from '@/hooks/use-theme';
import { t } from '@/lib/i18n';
import { checkManualPairing, checkPairingCode, phoneDeviceName, type PairingCheck } from '@/lib/pairing';

export default function PairScreen() {
  const theme = useTheme();
  const [permission, requestPermission] = useCameraPermissions();
  const [server, setServer] = useState('');
  const [phrase, setPhrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One scan at a time: the camera reports the same code many times a second.
  const handling = useRef(false);

  const finish = async (check: PairingCheck): Promise<void> => {
    if (!check.ok) {
      setError(check.error);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await pairPhone(check.info, check.chainId, phoneDeviceName(Device.modelName, Platform.OS));
      if (router.canGoBack()) router.back();
      else router.replace('/');
    } catch (err) {
      setError(t('Could not join the sync chain: {error}', { error: err instanceof Error ? err.message : String(err) }));
    } finally {
      setBusy(false);
    }
  };

  const onScanned = (result: BarcodeScanningResult): void => {
    if (handling.current || busy) return;
    handling.current = true;
    void finish(checkPairingCode(result.data)).finally(() => {
      handling.current = false;
    });
  };

  // Fields sit on the card, so they take the page's background and a border to stand out from it.
  const inputStyle = [styles.input, { color: theme.text, backgroundColor: theme.background, borderColor: theme.backgroundSelected }];
  const canScan = Platform.OS !== 'web';

  return (
    <ThemedView style={styles.container}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <ThemedText type="body" themeColor="textSecondary">
          {t('On your computer, open Corvus Settings, then Sync, and choose “Pair a phone”. Anyone with that code can read your synced data, so pair only your own phone.')}
        </ThemedText>

        {canScan && (
          <ThemedView type="backgroundElement" style={styles.card}>
            <CardHeader title={t('Scan the code')} description={t('Point the camera at the code your computer shows.')} />
            {permission?.granted ? (
              <CameraView style={styles.camera} facing="back" barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onBarcodeScanned={onScanned} />
            ) : (
              <Button label={t('Use the camera')} kind="secondary" onPress={() => void requestPermission()} />
            )}
          </ThemedView>
        )}

        <ThemedView type="backgroundElement" style={styles.card}>
          <CardHeader title={canScan ? t('Or enter it by hand') : t('Enter the code')} />
          <View style={styles.field}>
            <ThemedText type="smallBold" themeColor="textSecondary">
              {t('Sync server address')}
            </ThemedText>
            <TextInput
              testID="pair-server"
              style={inputStyle}
              value={server}
              onChangeText={setServer}
              placeholder="https://sync.example.com"
              placeholderTextColor={theme.textSecondary}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
            />
          </View>
          <View style={styles.field}>
            <ThemedText type="smallBold" themeColor="textSecondary">
              {t('Recovery phrase (24 words), or the pairing code')}
            </ThemedText>
            <TextInput
              testID="pair-phrase"
              style={[inputStyle, styles.phrase]}
              value={phrase}
              onChangeText={setPhrase}
              placeholder="raven common …"
              placeholderTextColor={theme.textSecondary}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry={false}
              multiline
            />
          </View>
          <Button label={t('Pair')} busy={busy} disabled={!phrase.trim()} onPress={() => void finish(checkManualPairing(server, phrase))} testID="pair-submit" />
        </ThemedView>

        {error && (
          <ThemedText type="small" style={styles.error} testID="pair-error">
            {error}
          </ThemedText>
        )}
      </ScrollView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    padding: Spacing.four,
    gap: Spacing.three,
    maxWidth: MaxContentWidth,
    width: '100%',
    alignSelf: 'center',
  },
  card: {
    gap: 20,
    padding: 20,
    borderRadius: Spacing.four,
  },
  camera: {
    height: 280,
    borderRadius: Spacing.three,
    overflow: 'hidden',
  },
  field: {
    gap: Spacing.two,
  },
  input: {
    minHeight: 52,
    paddingHorizontal: Spacing.three,
    borderRadius: 12,
    borderWidth: 1,
    fontSize: 16,
  },
  phrase: {
    minHeight: 112,
    paddingVertical: 14,
    textAlignVertical: 'top',
  },
  error: {
    color: '#D93025',
  },
});
