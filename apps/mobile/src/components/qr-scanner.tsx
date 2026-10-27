/**
 * The camera preview that scans the pairing code, here with expo-camera: on iOS it decodes QR codes on
 * the phone with Apple's AVFoundation. Android has its own scanner (qr-scanner.android.tsx), because
 * expo-camera's is Google ML Kit there. pair.tsx is type-checked against this file, so the Android
 * file keeps the same exports.
 */
import { CameraView, useCameraPermissions } from 'expo-camera';
import type { StyleProp, ViewStyle } from 'react-native';

export interface QrScannerProps {
  style?: StyleProp<ViewStyle>;
  /** The text of a QR code in view; called again while it stays in view. */
  onScanned: (data: string) => void;
}

/** The camera permission: [status, ask for it]. */
export const useQrCameraPermission = useCameraPermissions;

export function QrScanner({ style, onScanned }: QrScannerProps) {
  return <CameraView style={style} facing="back" barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onBarcodeScanned={(result) => onScanned(result.data)} />;
}
