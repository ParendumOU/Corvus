/**
 * Corvus's QR code scanner on Android (android/…/QrScannerModule.kt): a camera preview whose frames
 * are decoded on the phone with ZXing, so pairing needs no Google ML Kit (expo-camera's scanner on
 * Android, which sends Google diagnostics). On iOS and in the web build the native module does not
 * exist and both exports are null; iOS scans with expo-camera, which uses Apple's AVFoundation.
 */
import { requireNativeView, requireOptionalNativeModule, type PermissionResponse } from 'expo';
import type { ComponentType } from 'react';
import type { NativeSyntheticEvent, ViewProps } from 'react-native';

interface QrScannerNative {
  getCameraPermissionsAsync(): Promise<PermissionResponse>;
  requestCameraPermissionsAsync(): Promise<PermissionResponse>;
}

export type CodeScannedEvent = NativeSyntheticEvent<{ data: string }>;

export interface QrScannerViewProps extends ViewProps {
  /** A QR code in view: the same code is reported at most once every 2 seconds. */
  onCodeScanned?: (event: CodeScannedEvent) => void;
}

export const QrScanner = requireOptionalNativeModule<QrScannerNative>('CorvusQrScanner');

// expo's types can bring another copy of @types/react than the app's: give the view the app's type.
export const QrScannerView = (QrScanner ? requireNativeView<QrScannerViewProps>('CorvusQrScanner') : null) as unknown as ComponentType<QrScannerViewProps> | null;
