import { app, net, type Session, type WebContents } from "electron";
import { CertExceptions, certErrorCode, certHost, isIpHost, type CertValidity } from "../shared/cert-errors";

/** A page load that failed on the site's certificate, as Chromium reported it. */
export interface CertProblem {
  url: string;
  /** Host without port (the key of the exception a "Proceed" adds). */
  host: string;
  /** Chromium's error name ("ERR_CERT_AUTHORITY_INVALID"). */
  code: string;
  /** The certificate the site sent ("" when unknown: then nobody can proceed). */
  fingerprint: string;
  validity?: CertValidity;
  /** Chromium enforces HSTS for the host (preloaded or learned): Chrome offers no "Proceed" then. */
  hsts: boolean;
}

/** Longest wait for the network stack's HSTS answer. */
const HSTS_PROBE_MS = 2000;
/** The smoke test's YouTube stand-in (an HSTS-preloaded host) serves a throwaway certificate. */
const SMOKE_TRUSTED: ReadonlySet<string> = new Set(process.env.CORVUS_SMOKE_TEST === "1" ? ["www.youtube.com"] : []);

/**
 * Certificate errors of pages. A main-frame load whose certificate fails is let fail (Chromium's
 * default) after noting what failed, so the tab can show Corvus's interstitial in its place; a
 * subresource with a bad certificate stays blocked, with no interstitial, as in Chrome. Certificates
 * a person accepted ("Proceed") are let through for their host in that session only.
 */
export class CertErrorService {
  readonly exceptions = new CertExceptions<Session>();
  private readonly failed = new WeakMap<WebContents, CertProblem>();

  install(): void {
    app.on("certificate-error", (event, wc, url, error, certificate, callback, isMainFrame) => {
      event.preventDefault();
      const host = certHost(url);
      if (SMOKE_TRUSTED.has(host) || this.exceptions.allows(wc.session, host, certificate.fingerprint)) return callback(true);
      if (!isMainFrame) return callback(false);
      const problem = {
        url,
        host,
        code: certErrorCode(error),
        fingerprint: certificate.fingerprint,
        validity: { start: certificate.validStart, expiry: certificate.validExpiry },
      };
      // Known before the load fails, so the tab (and an agent waiting on it) has the whole answer at once.
      void this.isHsts(wc.session, host).then((hsts) => {
        if (!wc.isDestroyed()) this.failed.set(wc, { ...problem, hsts });
        callback(false);
      });
    });
  }

  /** What made the main-frame load of `url` in `wc` fail on its certificate (once), or null. */
  take(wc: WebContents, url: string): CertProblem | null {
    const problem = this.failed.get(wc);
    this.failed.delete(wc);
    return problem && problem.url === url ? problem : null;
  }

  /** The error a site's pages were let through with in this session ("Not secure"), or null. */
  proceededWith(session: Session, url: string): string | null {
    return url.startsWith("https:") ? this.exceptions.errorFor(session, certHost(url)) : null;
  }

  /**
   * Whether Chromium enforces HSTS for `host` in this session (preloaded or sent by the site), asked
   * of its own network stack, since Electron does not pass that on with the error. A plain http request
   * to port 1, a port Chromium never connects to: with HSTS it is answered at once by Chromium's
   * internal redirect to https, without network; without HSTS it fails at once (ERR_UNSAFE_PORT).
   */
  isHsts(session: Session, host: string): Promise<boolean> {
    if (!host || isIpHost(host)) return Promise.resolve(false);
    return new Promise((resolve) => {
      let request: Electron.ClientRequest;
      try {
        request = net.request({ url: `http://${host}:1/`, session, redirect: "manual" });
      } catch {
        resolve(false);
        return;
      }
      let settled = false;
      const done = (hsts: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        request.abort();
        resolve(hsts);
      };
      const timer = setTimeout(() => done(false), HSTS_PROBE_MS);
      request.on("redirect", (_status, _method, location) => done(location.startsWith("https:")));
      request.on("response", () => done(false));
      request.on("error", () => done(false));
      request.end();
    });
  }
}
