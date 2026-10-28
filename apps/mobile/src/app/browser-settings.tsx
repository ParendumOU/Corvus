import { BrowserSettings } from '@/components/browser-settings';
import { Screen } from '@/components/screen';

/** The browser's settings over the page (from its menu and its shield): back returns to the page. */
export default function BrowserSettingsScreen() {
  return (
    <Screen>
      <BrowserSettings />
    </Screen>
  );
}
