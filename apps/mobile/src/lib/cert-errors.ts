/**
 * Certificate errors: a site whose HTTPS certificate the phone cannot trust. The WebView reports
 * them as a failed load (Android: the SslError kind, 0 to 5, where its other errors are negative;
 * iOS: an NSURLErrorDomain code), and the tab shows "Your connection is not private" instead of a
 * generic error, with "Not secure" in the address bar.
 */

/** What is wrong with the certificate, as the page explains it. */
export type CertErrorKind = 'authority' | 'untrusted' | 'expired' | 'not-yet-valid' | 'date' | 'name' | 'invalid';

/** Android's android.net.http.SslError primary errors. */
const ANDROID: Readonly<Record<number, CertErrorKind>> = {
  0: 'not-yet-valid',
  1: 'expired',
  2: 'name',
  3: 'authority',
  4: 'date',
  5: 'invalid',
};

/** iOS's NSURLError codes for the server's certificate (not the client certificate ones). */
const IOS: Readonly<Record<number, CertErrorKind>> = {
  [-1201]: 'date',
  // A self-signed certificate and one for another name both come as "untrusted".
  [-1202]: 'untrusted',
  [-1203]: 'authority',
  [-1204]: 'not-yet-valid',
};

/** The certificate error behind a failed load, or null when the load failed for another reason. */
export function certErrorOf(domain: string | undefined, code: number, os: string): CertErrorKind | null {
  if (os === 'android') return domain ? null : (ANDROID[code] ?? null);
  if (os === 'ios') return domain === 'NSURLErrorDomain' ? (IOS[code] ?? null) : null;
  return null;
}
