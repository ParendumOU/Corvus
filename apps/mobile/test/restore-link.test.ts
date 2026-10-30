import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const { restoreLinkOnRebuild } = createRequire(import.meta.url)('../plugins/with-restore-link.js') as { restoreLinkOnRebuild: (source: string) => string };

const MAIN_ACTIVITY = `package com.parendum.corvus.mobile
import expo.modules.splashscreen.SplashScreenManager

import android.os.Build
import android.os.Bundle

class MainActivity : ReactActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    SplashScreenManager.registerOnActivity(this)
    super.onCreate(null)
  }
}
`;

const RESTORE = '    if (savedInstanceState != null) intent = Intent(Intent.ACTION_VIEW, Uri.parse("corvus://restore"))';

describe('restoreLinkOnRebuild', () => {
  it('starts an activity built again from its saved state with the restore link, before React Native reads the intent', () => {
    const out = restoreLinkOnRebuild(MAIN_ACTIVITY);
    expect(out).toContain(`${RESTORE}\n    super.onCreate(null)\n`);
    expect(out).toMatch(/^import android\.content\.Intent$/m);
    expect(out).toMatch(/^import android\.net\.Uri$/m);
  });

  it('changes nothing the second time', () => {
    const once = restoreLinkOnRebuild(MAIN_ACTIVITY);
    expect(restoreLinkOnRebuild(once)).toBe(once);
  });

  it('keeps the imports the activity already has', () => {
    const own = MAIN_ACTIVITY.replace('import android.os.Build\n', 'import android.content.Intent\nimport android.net.Uri\nimport android.os.Build\n');
    expect(restoreLinkOnRebuild(own).match(/^import android\.(content\.Intent|net\.Uri)$/gm)).toHaveLength(2);
  });

  it('fails loudly when the activity has no onCreate to hook', () => {
    expect(() => restoreLinkOnRebuild('class MainActivity : ReactActivity()\n')).toThrow(/super\.onCreate/);
  });
});
