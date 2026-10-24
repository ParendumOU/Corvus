import * as WebBrowser from 'expo-web-browser';
import { Linking, Platform } from 'react-native';

/** Opens a page in the in-app browser (Custom Tabs on Android, Safari View Controller on iOS). */
export async function openInApp(url: string): Promise<void> {
  if (Platform.OS === 'web') {
    window.open(url, '_blank', 'noopener,noreferrer');
    return;
  }
  await WebBrowser.openBrowserAsync(url);
}

/** Opens a page in the phone's default browser app. */
export async function openInBrowser(url: string): Promise<void> {
  await Linking.openURL(url);
}
