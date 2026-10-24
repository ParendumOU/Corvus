import { EventEmitter } from "node:events";
import type { WebContents } from "electron";
import { describe, expect, it } from "vitest";
import { chromeUserAgent, clientHintHeaders, electronUserAgent, followSignInUserAgent, userAgentFor } from "../src/main/user-agent";

const NATIVE =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) corvus/0.3.3 Chrome/142.0.7444.59 Electron/44.1.0 Safari/537.36";
const AGENTS = { chrome: chromeUserAgent(NATIVE), electron: electronUserAgent(NATIVE) };

class FakeWebContents extends EventEmitter {
  /** Electron returns "" until a page gets its own UA. */
  ua = "";
  sets: string[] = [];
  loads: Array<{ url: string; userAgent?: string }> = [];
  getUserAgent(): string {
    return this.ua;
  }
  setUserAgent(ua: string): void {
    this.ua = ua;
    this.sets.push(ua);
  }
  isDestroyed(): boolean {
    return false;
  }
  stops = 0;
  stop(): void {
    this.stops += 1;
  }
  async loadURL(url: string, opts: { userAgent?: string } = {}): Promise<void> {
    // Like Chromium, a UA change while the page loads reloads the page first.
    if (opts.userAgent && opts.userAgent !== this.ua) this.go("https://previous.example/", { initiator: undefined });
    if (opts.userAgent) this.ua = opts.userAgent;
    this.loads.push({ url, ...opts });
    this.go(url);
  }
  go(url: string, extra: { isMainFrame?: boolean; isSameDocument?: boolean; initiator?: object } = {}, event = "did-start-navigation"): void {
    this.emit(event, { url, isMainFrame: true, isSameDocument: false, initiator: {}, ...extra });
  }
}

const tick = () => new Promise((r) => setImmediate(r));

describe("sign-in user agent", () => {
  it("keeps Electron's token but drops the app's", () => {
    expect(AGENTS.electron).toBe(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.7444.59 Electron/44.1.0 Safari/537.36",
    );
    expect(AGENTS.chrome).not.toContain("Electron/");
  });

  it("reduces the Chrome UA's version to its major number, like Chromium does", () => {
    expect(AGENTS.chrome).toBe(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
    );
  });

  it("gives only Google's sign-in host the Electron UA", () => {
    expect(userAgentFor("https://accounts.google.com/v3/signin/identifier?flowName=GlifWebSignIn", AGENTS)).toBe(AGENTS.electron);
    expect(userAgentFor("https://mail.google.com/mail/u/0/", AGENTS)).toBe(AGENTS.chrome);
    expect(userAgentFor("https://accounts.google.com.evil.example/", AGENTS)).toBe(AGENTS.chrome);
    expect(userAgentFor("not a url", AGENTS)).toBe(AGENTS.chrome);
  });

  it("leaves pages alone while they stay on the Chrome UA", async () => {
    const fake = new FakeWebContents();
    followSignInUserAgent(fake as unknown as WebContents, AGENTS);
    fake.go("https://mail.google.com/", { initiator: undefined });
    fake.go("https://example.com/");
    await tick();
    expect(fake.sets).toEqual([]);
    expect(fake.loads).toEqual([]);
  });

  it("starts a navigation into the sign-in host again with Electron's UA, once", async () => {
    const fake = new FakeWebContents();
    followSignInUserAgent(fake as unknown as WebContents, AGENTS);
    fake.go("https://accounts.google.com/ServiceLogin");
    await tick();
    // The reload Chromium starts for the UA change is not taken for a page navigation.
    expect(fake.loads).toEqual([{ url: "https://accounts.google.com/ServiceLogin", userAgent: AGENTS.electron }]);
    expect(fake.stops).toBe(1);
    fake.go("https://accounts.google.com/v3/signin/challenge", { isSameDocument: true });
    fake.go("https://ads.example/frame", { isMainFrame: false });
    await tick();
    expect(fake.loads).toHaveLength(1);
  });

  it("restarts redirects into or out of the sign-in host", async () => {
    const fake = new FakeWebContents();
    followSignInUserAgent(fake as unknown as WebContents, AGENTS);
    fake.go("https://accounts.google.com/ServiceLogin", {}, "did-redirect-navigation");
    await tick();
    fake.go("https://mail.google.com/mail/u/0/", {}, "did-redirect-navigation");
    await tick();
    expect(fake.loads.map((l) => l.userAgent)).toEqual([AGENTS.electron, AGENTS.chrome]);
  });

  it("switches a page leaving the sign-in host without restarting it (it may be a form POST)", async () => {
    const fake = new FakeWebContents();
    fake.ua = AGENTS.electron;
    followSignInUserAgent(fake as unknown as WebContents, AGENTS);
    fake.go("https://app.example/oauth/callback");
    await tick();
    expect(fake.loads).toEqual([]);
    expect(fake.ua).toBe(AGENTS.chrome);
    // A navigation Corvus starts itself (typed URL) is restarted with the right UA.
    fake.ua = AGENTS.electron;
    fake.go("https://example.com/", { initiator: undefined });
    await tick();
    expect(fake.loads).toEqual([{ url: "https://example.com/", userAgent: AGENTS.chrome }]);
  });
});

describe("navigation client hints", () => {
  it("match what Chromium itself sends for its version", () => {
    // Seen on Electron 44 (Chromium 152) subresource requests, and the GREASE brand of Chrome 156.
    expect(clientHintHeaders(152, "win32")).toEqual({
      "sec-ch-ua": '"Not?A_Brand";v="24", "Chromium";v="152"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Windows"',
    });
    expect(clientHintHeaders(156, "darwin")["sec-ch-ua"]).toContain('"Not:A-Brand";v="8"');
    expect(clientHintHeaders(156, "darwin")["sec-ch-ua-platform"]).toBe('"macOS"');
  });
});
