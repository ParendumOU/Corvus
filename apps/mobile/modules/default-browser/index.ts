/**
 * Corvus as the phone's default browser: the Android side (android/…/DefaultBrowserModule.kt). On iOS
 * and in the web build the native module does not exist and `DefaultBrowser` is null: Apple lets only
 * real browsers be the default one.
 */
import { requireOptionalNativeModule } from 'expo';

export interface DefaultBrowserStatus {
  /** Corvus is the phone's default browser. */
  isDefault: boolean;
  /** The system has the "Set as default browser" dialog (Android 10 and later). */
  roleAvailable: boolean;
  /** The app that opens web pages now (Corvus included), or null when the system asks each time. */
  systemDefault: string | null;
}

export interface InstalledBrowser {
  packageName: string;
  label: string;
}

/** What asking to become the default browser ended in. */
export type DefaultBrowserRequest = 'granted' | 'dismissed' | 'settings' | 'unavailable';

interface DefaultBrowserNative {
  getStatusAsync(): Promise<DefaultBrowserStatus>;
  /** Every browser app but Corvus. */
  getBrowsersAsync(): Promise<InstalledBrowser[]>;
  /** Shows the system's "Set as default browser" dialog, or the Default apps settings where there is none. */
  requestDefaultAsync(): Promise<DefaultBrowserRequest>;
  openDefaultAppsSettingsAsync(): Promise<boolean>;
  /** Opens a page in this browser app; with `leave`, Corvus then steps back to the app the link came from. */
  openUrlAsync(url: string, packageName: string, leave: boolean): Promise<boolean>;
  /** Steps back to the app Corvus was opened from. */
  leaveAsync(): Promise<boolean>;
}

export const DefaultBrowser = requireOptionalNativeModule<DefaultBrowserNative>('CorvusDefaultBrowser');
