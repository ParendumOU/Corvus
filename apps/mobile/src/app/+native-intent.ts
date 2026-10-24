/** A link shared to Corvus from another app (Android share sheet) opens the Send screen. */
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  if (/^[a-z][a-z0-9+.-]*:\/\/expo-sharing\b/i.test(path)) return '/send';
  return path;
}
