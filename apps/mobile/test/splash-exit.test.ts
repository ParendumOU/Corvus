import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const { clearSplashExit } = createRequire(import.meta.url)('../plugins/with-splash-exit.js') as { clearSplashExit: (source: string) => string };

const MAIN_ACTIVITY = `package com.parendum.corvus.mobile
import expo.modules.splashscreen.SplashScreenManager

import android.os.Build
import android.os.Bundle

class MainActivity : ReactActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    // @generated begin expo-splashscreen - expo prebuild (DO NOT MODIFY) sync-f3ff59a738c56c9a6119210cb55f0b613eb8b6af
    SplashScreenManager.registerOnActivity(this)
    // @generated end expo-splashscreen
    super.onCreate(null)
  }
}
`;

const CLEAR = '    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) splashScreen.clearOnExitAnimationListener()';

describe('clearSplashExit', () => {
  it('drops the exit listener expo-splash-screen sets, right after onCreate', () => {
    const out = clearSplashExit(MAIN_ACTIVITY);
    expect(out).toBe(MAIN_ACTIVITY.replace('    super.onCreate(null)\n', `    super.onCreate(null)\n${CLEAR}\n`));
    expect(out.indexOf(CLEAR)).toBeGreaterThan(out.indexOf('SplashScreenManager.registerOnActivity(this)'));
  });

  it('changes nothing the second time', () => {
    const once = clearSplashExit(MAIN_ACTIVITY);
    expect(clearSplashExit(once)).toBe(once);
  });

  it('imports Build when the activity does not', () => {
    const out = clearSplashExit(MAIN_ACTIVITY.replace('import android.os.Build\n', ''));
    expect(out.startsWith('package com.parendum.corvus.mobile\n\nimport android.os.Build\n')).toBe(true);
    expect(out).toContain(CLEAR);
  });

  it('fails loudly when the activity has no onCreate to hook', () => {
    expect(() => clearSplashExit('class MainActivity : ReactActivity()\n')).toThrow(/super\.onCreate/);
  });
});
