import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

type Plugin = string | [string, Record<string, unknown>];

const read = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const { expo } = read('../app.json') as { expo: { ios: { infoPlist: Record<string, unknown> }; plugins: Plugin[]; locales: Record<string, string> } };

/** The texts iOS shows when the app asks for a permission, as app.json sets them (Info.plist and expo-camera). */
function permissionTexts(): Record<string, unknown> {
  const texts = Object.fromEntries(Object.entries(expo.ios.infoPlist).filter(([key]) => key.endsWith('UsageDescription')));
  const camera = expo.plugins.find((p): p is [string, Record<string, unknown>] => Array.isArray(p) && p[0] === 'expo-camera');
  if (camera?.[1].cameraPermission) texts.NSCameraUsageDescription = camera[1].cameraPermission;
  return texts;
}

describe('iOS permission texts', () => {
  it('each have a Spanish version, for iOS only', () => {
    const es = read(`../${expo.locales.es}`) as Record<string, Record<string, string>>;
    const english = permissionTexts();
    expect(Object.keys(es)).toEqual(['ios']);
    expect(Object.keys(es.ios!).sort()).toEqual(Object.keys(english).sort());
    for (const [key, text] of Object.entries(es.ios!)) {
      expect(text, key).toMatch(/^Corvus .+\.$/);
      expect(text, key).not.toBe(english[key]);
    }
  });
});
