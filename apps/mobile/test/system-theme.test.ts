import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const { syncThemeOnResume } = createRequire(import.meta.url)('../plugins/with-system-theme.js') as { syncThemeOnResume: (source: string) => string };

const MAIN_ACTIVITY = `package com.parendum.corvus.mobile

import com.facebook.react.ReactActivity

class MainActivity : ReactActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(null)
  }

  override fun getMainComponentName(): String = "main"
}
`;

const ON_RESUME = `  override fun onResume() {
    super.onResume()
    reactHost?.onConfigurationChanged(this)
  }
`;

describe('syncThemeOnResume', () => {
  it('passes the configuration to React Native on every resume', () => {
    expect(syncThemeOnResume(MAIN_ACTIVITY)).toBe(MAIN_ACTIVITY.replace('class MainActivity : ReactActivity() {\n', `class MainActivity : ReactActivity() {\n${ON_RESUME}\n`));
  });

  it('changes nothing the second time', () => {
    const once = syncThemeOnResume(MAIN_ACTIVITY);
    expect(syncThemeOnResume(once)).toBe(once);
  });

  it('fails loudly when the activity already has an onResume', () => {
    const own = MAIN_ACTIVITY.replace('  override fun getMainComponentName', '  override fun onResume() {\n    super.onResume()\n  }\n\n  override fun getMainComponentName');
    expect(() => syncThemeOnResume(own)).toThrow(/onResume/);
  });

  it('fails loudly when there is no MainActivity to hook', () => {
    expect(() => syncThemeOnResume('class Other : Activity()\n')).toThrow(/MainActivity/);
  });
});
