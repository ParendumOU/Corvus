/**
 * The camera preview that scans the pairing code on Android: Corvus's own scanner
 * (modules/qr-scanner), which decodes the frames on the phone with ZXing. Nothing is sent anywhere,
 * unlike expo-camera's scanner on Android (Google ML Kit, which sends Google diagnostics), which is
 * left out of the Android build. Same exports as qr-scanner.tsx.
 */
import { createPermissionHook, PermissionStatus, type PermissionResponse } from 'expo';
import { StyleSheet, View } from 'react-native';

import { QrScanner as Native, QrScannerView } from '../../modules/qr-scanner';
import type { QrScannerProps } from './qr-scanner';

const unavailable: PermissionResponse = { status: PermissionStatus.DENIED, granted: false, canAskAgain: false, expires: 'never' };

/** The camera permission: [status, ask for it]. */
export const useQrCameraPermission = createPermissionHook<PermissionResponse, object>({
  getMethod: () => Native?.getCameraPermissionsAsync() ?? Promise.resolve(unavailable),
  requestMethod: () => Native?.requestCameraPermissionsAsync() ?? Promise.resolve(unavailable),
});

export function QrScanner({ style, onScanned }: QrScannerProps) {
  // The wrapper clips the preview to the rounded corners.
  return <View style={[style, styles.clip]}>{QrScannerView && <QrScannerView style={StyleSheet.absoluteFill} onCodeScanned={(event) => onScanned(event.nativeEvent.data)} />}</View>;
}

const styles = StyleSheet.create({
  clip: {
    overflow: 'hidden',
  },
});
