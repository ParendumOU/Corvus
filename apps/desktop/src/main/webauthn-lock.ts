/**
 * Windows Hello and security keys for the profile lock, through Chromium's own WebAuthn (which on
 * Windows hands the request to the system: webauthn.dll shows Windows Hello or the security key
 * prompt). WebAuthn needs a secure https origin: a blank page at LOCK_ORIGIN, served by Corvus
 * itself in a session of its own that reaches no network, runs the ceremony in a 1x1 view of the
 * window the person is in (the system prompt needs a focused page there). The PRF extension, where
 * the authenticator has it, gives the key that seals the profile's lock key.
 */
import { session as electronSession, WebContentsView, type Session } from "electron";
import { b64url, checkAuthenticatorData, checkClientData, fromB64url, randomKey, SUPPORTED_COSE, verifyAssertion, type AssertionResult, type Expected } from "./profile-lock-crypto";
import { tr } from "./menu-i18n";
import type { BrowserWindowCtl } from "./window";

export const LOCK_RP_ID = "lock.corvus.invalid";
export const LOCK_ORIGIN = `https://${LOCK_RP_ID}`;
const PARTITION = "corvus-profile-lock-webauthn";
const TIMEOUT_MS = 120_000;

/** WebAuthn in Electron works through the system's own prompt only on Windows. */
export const webauthnSupported = (): boolean => process.platform === "win32";

let ceremonySession: Session | null = null;

function lockSession(): Session {
  if (ceremonySession) return ceremonySession;
  const ses = electronSession.fromPartition(PARTITION, { cache: false });
  const page = "<!doctype html><html><head><meta charset=\"utf-8\"><title>Corvus</title></head><body></body></html>";
  ses.protocol.handle("https", (request) =>
    new URL(request.url).host === LOCK_RP_ID ? new Response(page, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } }) : new Response("", { status: 404 }),
  );
  ses.protocol.handle("http", () => new Response("", { status: 404 }));
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ceremonySession = ses;
  return ses;
}

/** Runs `script` (a promise) in the ceremony page, in a 1x1 view on top of `win`. */
async function inCeremony<T>(win: BrowserWindowCtl, script: string): Promise<T> {
  const view = new WebContentsView({ webPreferences: { session: lockSession(), sandbox: true, contextIsolation: true, nodeIntegration: false } });
  view.setBackgroundColor("#00000000");
  win.setLockExempt(view, true);
  win.win.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 1, height: 1 });
  try {
    await view.webContents.loadURL(`${LOCK_ORIGIN}/`);
    view.webContents.focus();
    return (await view.webContents.executeJavaScript(script, true)) as T;
  } finally {
    win.setLockExempt(view, false);
    win.win.contentView.removeChildView(view);
    view.webContents.close();
    // The keyboard goes back to the lock form, or to the page that asked (Settings).
    if (win.locked) win.focusChrome();
    else win.focusContent();
  }
}

/** The page side: base64url in and out, errors as values (a rejected promise loses its name). */
const HELPERS = `
const b = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
`;

type PageResult<T> = ({ ok: true } & T) | { ok: false; name: string; message: string };

/** What the person sees when the system prompt ends without an answer. */
function ceremonyError(result: { name: string; message: string }): Error {
  if (result.name === "NotAllowedError" || result.name === "AbortError") return new Error(tr("Cancelled, or the time to answer ran out."));
  if (result.name === "InvalidStateError") return new Error(tr("That authenticator is already added."));
  if (result.name === "NotSupportedError") return new Error(tr("This authenticator cannot be used here."));
  return new Error(tr("The authenticator did not answer: {message}", { message: result.message }));
}

export interface Registration {
  credentialId: string;
  publicKey: string;
  algorithm: number;
  signCount: number;
  prfSalt?: Buffer;
  prfOutput?: Buffer;
}

/**
 * Registers Windows Hello ("hello") or a security key ("fido2") for a profile's lock. With PRF,
 * the authenticator's output for a random salt comes back too (from a second prompt when the first
 * did not give it), to seal the lock key with.
 */
export async function registerAuthenticator(win: BrowserWindowCtl, type: "hello" | "fido2", userName: string): Promise<Registration> {
  if (!webauthnSupported()) throw new Error(tr("Windows Hello and security keys work on Windows only."));
  const challenge = randomKey();
  const prfSalt = randomKey();
  const params = {
    rpId: LOCK_RP_ID,
    challenge: b64url(challenge),
    userId: b64url(randomKey(16)),
    userName: userName.slice(0, 60) || "Corvus",
    attachment: type === "hello" ? "platform" : "cross-platform",
    uv: type === "hello" ? "required" : "preferred",
    prfSalt: b64url(prfSalt),
    timeout: TIMEOUT_MS,
  };
  const script = `(async () => {${HELPERS}
const p = ${JSON.stringify(params)};
try {
  const cred = await navigator.credentials.create({ publicKey: {
    rp: { id: p.rpId, name: "Corvus" },
    user: { id: b(p.userId), name: p.userName, displayName: p.userName },
    challenge: b(p.challenge),
    pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -8 }, { type: "public-key", alg: -257 }],
    authenticatorSelection: { authenticatorAttachment: p.attachment, userVerification: p.uv, residentKey: "discouraged", requireResidentKey: false },
    timeout: p.timeout,
    attestation: "none",
    extensions: { prf: { eval: { first: b(p.prfSalt) } } },
  } });
  const r = cred.response;
  const ext = cred.getClientExtensionResults();
  const key = r.getPublicKey();
  return { ok: true, credentialId: u(cred.rawId), clientDataJSON: u(r.clientDataJSON), authenticatorData: u(r.getAuthenticatorData()),
    publicKey: key ? u(key) : null, algorithm: r.getPublicKeyAlgorithm(),
    prfEnabled: Boolean(ext.prf && ext.prf.enabled), prf: ext.prf && ext.prf.results && ext.prf.results.first ? u(ext.prf.results.first) : null };
} catch (e) { return { ok: false, name: String(e && e.name), message: String(e && e.message || e) }; }
})()`;
  const result = await inCeremony<PageResult<{ credentialId: string; clientDataJSON: string; authenticatorData: string; publicKey: string | null; algorithm: number; prfEnabled: boolean; prf: string | null }>>(win, script);
  if (!result.ok) throw ceremonyError(result);
  checkClientData(fromB64url(result.clientDataJSON), { challenge, origin: LOCK_ORIGIN, rpId: LOCK_RP_ID, type: "webauthn.create" });
  const { signCount } = checkAuthenticatorData(fromB64url(result.authenticatorData), LOCK_RP_ID, type === "hello");
  if (!result.publicKey || !(SUPPORTED_COSE as readonly number[]).includes(result.algorithm)) throw new Error(tr("This authenticator uses a kind of key Corvus does not support."));
  const registration: Registration = { credentialId: result.credentialId, publicKey: result.publicKey, algorithm: result.algorithm, signCount };
  if (!result.prfEnabled) return registration;
  let prf = result.prf;
  if (!prf) {
    const assertion = await assertAuthenticator(win, type, [{ credentialId: result.credentialId, prfSalt: b64url(prfSalt) }]);
    verifyAssertion(assertion.result, { ...registration, signCount: 0 }, assertion.expected, type === "hello");
    prf = assertion.result.prf ?? null;
  }
  return prf ? { ...registration, prfSalt, prfOutput: fromB64url(prf) } : registration;
}

/** Asks one of `credentials` for an assertion (with each one's PRF salt). The caller checks it. */
export async function assertAuthenticator(
  win: BrowserWindowCtl,
  type: "hello" | "fido2",
  credentials: Array<{ credentialId: string; prfSalt?: string }>,
): Promise<{ result: AssertionResult; expected: Expected }> {
  if (!webauthnSupported()) throw new Error(tr("Windows Hello and security keys work on Windows only."));
  if (credentials.length === 0) throw new Error(tr("This profile has no such authenticator."));
  const challenge = randomKey();
  const params = {
    rpId: LOCK_RP_ID,
    challenge: b64url(challenge),
    uv: type === "hello" ? "required" : "preferred",
    credentials,
    timeout: TIMEOUT_MS,
  };
  const script = `(async () => {${HELPERS}
const p = ${JSON.stringify(params)};
try {
  const salts = p.credentials.filter((c) => c.prfSalt);
  const cred = await navigator.credentials.get({ publicKey: {
    rpId: p.rpId,
    challenge: b(p.challenge),
    allowCredentials: p.credentials.map((c) => ({ type: "public-key", id: b(c.credentialId) })),
    userVerification: p.uv,
    timeout: p.timeout,
    ...(salts.length ? { extensions: { prf: { evalByCredential: Object.fromEntries(salts.map((c) => [c.credentialId, { first: b(c.prfSalt) }])) } } } : {}),
  } });
  const r = cred.response;
  const ext = cred.getClientExtensionResults();
  return { ok: true, credentialId: u(cred.rawId), clientDataJSON: u(r.clientDataJSON), authenticatorData: u(r.authenticatorData), signature: u(r.signature),
    prf: ext.prf && ext.prf.results && ext.prf.results.first ? u(ext.prf.results.first) : null };
} catch (e) { return { ok: false, name: String(e && e.name), message: String(e && e.message || e) }; }
})()`;
  const result = await inCeremony<PageResult<{ credentialId: string; clientDataJSON: string; authenticatorData: string; signature: string; prf: string | null }>>(win, script);
  if (!result.ok) throw ceremonyError(result);
  const { prf, ok: _ok, ...rest } = result;
  return { result: { ...rest, ...(prf ? { prf } : {}) }, expected: { challenge, origin: LOCK_ORIGIN, rpId: LOCK_RP_ID, type: "webauthn.get" } };
}
