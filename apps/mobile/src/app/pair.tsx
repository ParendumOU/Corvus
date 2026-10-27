import * as Device from 'expo-device';
import { router } from 'expo-router';
import { useRef, useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';

import { Button } from '@/components/button';
import { Card, CardHeader } from '@/components/card';
import { Banner } from '@/components/feedback';
import { TextField } from '@/components/fields';
import { Icon } from '@/components/icon';
import { QrScanner, useQrCameraPermission } from '@/components/qr-scanner';
import { Screen } from '@/components/screen';
import { Radius, Space } from '@/constants/theme';
import { pairPhone } from '@/hooks/use-session';
import { useTheme } from '@/hooks/use-theme';
import { t } from '@/lib/i18n';
import { checkManualPairing, checkPairingCode, pairingFailedMessage, phoneDeviceName, type PairingCheck } from '@/lib/pairing';

export default function PairScreen() {
  const theme = useTheme();
  const [permission, requestPermission] = useQrCameraPermission();
  const [server, setServer] = useState('');
  const [phrase, setPhrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One scan at a time: the camera keeps reporting a code while it stays in view.
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
      setError(pairingFailedMessage(err, check.info.serverUrl));
    } finally {
      setBusy(false);
    }
  };

  const onScanned = (data: string): void => {
    if (handling.current || busy) return;
    handling.current = true;
    void finish(checkPairingCode(data)).finally(() => {
      handling.current = false;
    });
  };

  const canScan = Platform.OS !== 'web';

  return (
    <Screen>
      <Banner
        icon="shield"
        message={t('On your computer, open Corvus Settings, then Sync, and choose “Pair a phone”. Anyone with that code can read your synced data, so pair only your own phone.')}
      />

      {canScan && (
        <Card>
          <CardHeader title={t('Scan the code')} description={t('Point the camera at the code your computer shows.')} />
          {permission?.granted ? (
            <View style={styles.viewfinder}>
              <QrScanner style={styles.camera} onScanned={onScanned} />
              <View style={[styles.frame, { borderColor: theme.accent }]} pointerEvents="none" />
            </View>
          ) : (
            <Button label={t('Use the camera')} icon="camera" onPress={() => void requestPermission()} />
          )}
        </Card>
      )}

      <Card>
        <View style={styles.manualHead}>
          <Icon name="keyboard" size={22} color={theme.textSecondary} />
          <View style={styles.grow}>
            <CardHeader title={canScan ? t('Or enter it by hand') : t('Enter the code')} />
          </View>
        </View>
        <TextField
          testID="pair-server"
          label={t('Sync server address')}
          value={server}
          onChangeText={setServer}
          placeholder="https://sync.example.com"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
        />
        <TextField
          testID="pair-phrase"
          label={t('Recovery phrase (24 words), or the pairing code')}
          value={phrase}
          onChangeText={setPhrase}
          placeholder="raven common …"
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry={false}
          multiline
          lines={4}
        />
        {error && <Banner tone="error" message={error} testID="pair-error" />}
        <Button label={t('Pair')} busy={busy} disabled={!phrase.trim()} onPress={() => void finish(checkManualPairing(server, phrase))} testID="pair-submit" />
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  viewfinder: {
    height: 300,
    borderRadius: Radius.lg,
    overflow: 'hidden',
    backgroundColor: '#000',
  },
  camera: {
    flex: 1,
  },
  frame: {
    position: 'absolute',
    top: 40,
    bottom: 40,
    alignSelf: 'center',
    aspectRatio: 1,
    borderWidth: 3,
    borderRadius: Radius.lg,
  },
  manualHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.md,
  },
  grow: {
    flex: 1,
  },
});
