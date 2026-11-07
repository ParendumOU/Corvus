import { useEffect, useRef, useState, type FormEvent } from "react";
import "./lock-screen.css";
import type { LockKind, LockScreenView, UnlockAttempt } from "../../shared/profile-lock";
import { lockProblemText } from "../common/lock-text";
import { chromeApi, errorMessage } from "../common/api";
import { t } from "../common/i18n";
import { IconLock, IconPlus } from "../common/icons";

/** Seconds left until `at`, ticking; 0 once it passed. */
function useCountdown(at: number | null): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!at || at <= Date.now()) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [at]);
  return at ? Math.max(0, Math.ceil((at - now) / 1000)) : 0;
}

/** A generic stand-in for the pages behind: shapes and soft color, never anything of the profile's. */
function Placeholder() {
  return (
    <div className="lock-backdrop" aria-hidden>
      <div className="lock-ghost">
        <div className="ghost-bar" />
        <div className="ghost-page">
          <div className="ghost-line w60" />
          <div className="ghost-line w90" />
          <div className="ghost-line w75" />
          <div className="ghost-cards">
            <div className="ghost-card" />
            <div className="ghost-card" />
            <div className="ghost-card" />
          </div>
          <div className="ghost-line w85" />
          <div className="ghost-line w50" />
        </div>
      </div>
      <div className="lock-blob a" />
      <div className="lock-blob b" />
      <div className="lock-blob c" />
    </div>
  );
}

function Avatar({ name, color, size = 56 }: { name: string; color?: string | undefined; size?: number }) {
  return (
    <span className="lock-avatar" style={{ background: color ?? "var(--accent)", width: size, height: size, fontSize: size * 0.42 }}>
      {name.charAt(0).toUpperCase()}
    </span>
  );
}

/** "New profile" from the lock screen: a name and, if the person wants, its own lock. */
function NewProfileForm({ onDone }: { onDone: () => void }) {
  const api = chromeApi();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<LockKind | "none">("none");
  const [secret, setSecret] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    if (!name.trim()) return;
    if (kind !== "none") {
      const problem = lockProblemText(kind, secret);
      if (problem) return setError(problem);
      if (secret !== again) return setError(t("The two entries do not match."));
    }
    setBusy(true);
    setError(null);
    api
      .call("lock.newProfile", name, kind === "none" ? null : { kind, secret })
      .then(onDone)
      .catch((err: unknown) => setError(errorMessage(err)))
      .finally(() => setBusy(false));
  };

  return (
    <form className="lock-new" onSubmit={submit} onKeyDown={(e) => e.key === "Escape" && onDone()}>
      <input className="input" autoFocus placeholder={t("Profile name")} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
      <div className="lock-kinds" role="radiogroup" aria-label={t("Lock")}>
        {(["none", "pin", "password"] as const).map((k) => (
          <button key={k} type="button" role="radio" aria-checked={kind === k} className={`lock-kind ${kind === k ? "on" : ""}`} onClick={() => setKind(k)}>
            {k === "none" ? t("No lock") : k === "pin" ? t("PIN") : t("Password")}
          </button>
        ))}
      </div>
      {kind !== "none" && (
        <>
          <input
            className="input"
            type="password"
            inputMode={kind === "pin" ? "numeric" : "text"}
            autoComplete="new-password"
            placeholder={kind === "pin" ? t("New PIN (at least 6 digits)") : t("New password (at least 8 characters)")}
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
          />
          <input className="input" type="password" inputMode={kind === "pin" ? "numeric" : "text"} autoComplete="new-password" placeholder={t("Repeat it")} value={again} onChange={(e) => setAgain(e.target.value)} />
        </>
      )}
      {error && <div className="lock-error">{error}</div>}
      <div className="lock-row">
        <button type="button" className="btn ghost" onClick={onDone}>
          {t("Cancel")}
        </button>
        <button type="submit" className="btn primary" disabled={busy || !name.trim()}>
          {t("Create and open")}
        </button>
      </div>
    </form>
  );
}

/**
 * What a window of a locked profile shows: a blurred stand-in for its pages and, in the middle, the
 * form to unlock it with each way it has, to switch to another profile or to create a new one.
 */
export function LockScreen({ lock, platform }: { lock: LockScreenView; platform: string }) {
  const api = chromeApi();
  const [secret, setSecret] = useState("");
  const [code, setCode] = useState("");
  const [useCode, setUseCode] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [panel, setPanel] = useState<"none" | "switch" | "new">("none");
  const [retryAt, setRetryAt] = useState<number | null>(lock.retryAt);
  const field = useRef<HTMLInputElement>(null);
  const wait = useCountdown(retryAt);

  useEffect(() => setRetryAt(lock.retryAt), [lock.retryAt]);
  useEffect(() => {
    if (panel === "none") field.current?.focus();
  }, [panel, useCode, busy]);

  const attempt = (a: UnlockAttempt): void => {
    setBusy(true);
    setError(null);
    api
      .call("lock.unlock", a)
      .then((result) => {
        if (result.ok) return;
        setError(result.error);
        setRetryAt(result.retryAt);
        setSecret("");
        setCode("");
      })
      .catch((err: unknown) => setError(errorMessage(err)))
      .finally(() => setBusy(false));
  };

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    if (busy || wait > 0) return;
    if (useCode) {
      if (code.trim()) attempt({ method: "totp", code: code.trim() });
    } else if (secret) attempt({ method: "secret", secret });
  };

  const pin = lock.kind === "pin";
  const mac = platform === "darwin";
  return (
    <div className={`lock-screen ${mac ? "mac" : "wco"}`} data-lock-screen>
      <Placeholder />
      <div className="lock-drag" />
      <div className="lock-center">
        <div className="lock-card" role="dialog" aria-label={t("This profile is locked")}>
          <div className="lock-head">
            <Avatar name={lock.name} color={lock.avatar} />
            <div className="lock-title">
              <span className="lock-name">{lock.name}</span>
              <span className="lock-sub">
                <IconLock size={13} /> {t("This profile is locked")}
              </span>
            </div>
          </div>

          {panel === "none" && (
            <form className="lock-form" onSubmit={submit}>
              {useCode ? (
                <input
                  ref={field}
                  className="input lock-field"
                  data-lock-code
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={8}
                  placeholder={t("6-digit code from your authenticator app")}
                  value={code}
                  disabled={busy}
                  onChange={(e) => setCode(e.target.value.replace(/[^\d ]/g, ""))}
                />
              ) : (
                <input
                  ref={field}
                  className="input lock-field"
                  data-lock-secret
                  type="password"
                  inputMode={pin ? "numeric" : "text"}
                  autoComplete="off"
                  placeholder={pin ? t("PIN") : t("Password")}
                  value={secret}
                  disabled={busy}
                  onChange={(e) => setSecret(e.target.value)}
                />
              )}
              <button type="submit" className="btn primary lock-go" data-lock-unlock disabled={busy || wait > 0}>
                {t("Unlock")}
              </button>
              {error && (
                <div className="lock-error" role="alert" data-lock-error>
                  {error}
                </div>
              )}
              {wait > 0 && <div className="lock-wait">{t("Try again in {seconds} s", { seconds: wait })}</div>}
              {(lock.methods.totp || lock.methods.hello || lock.methods.fido2) && (
                <div className="lock-methods">
                  {lock.methods.totp && (
                    <button type="button" className="btn ghost small" onClick={() => setUseCode((v) => !v)}>
                      {useCode ? (pin ? t("Use the PIN") : t("Use the password")) : t("Use a code from an authenticator app")}
                    </button>
                  )}
                  {lock.methods.hello && (
                    <button type="button" className="btn ghost small" disabled={busy || wait > 0} onClick={() => attempt({ method: "hello" })}>
                      {t("Use Windows Hello")}
                    </button>
                  )}
                  {lock.methods.fido2 && (
                    <button type="button" className="btn ghost small" disabled={busy || wait > 0} onClick={() => attempt({ method: "fido2" })}>
                      {t("Use a security key")}
                    </button>
                  )}
                </div>
              )}
            </form>
          )}

          {panel === "switch" && (
            <div className="lock-profiles">
              {lock.profiles.map((p) => (
                <button key={p.id} type="button" className="lock-profile" onClick={() => void api.call("lock.switchProfile", p.id).then(() => setPanel("none"))}>
                  <Avatar name={p.name} color={p.avatar} size={28} />
                  <span className="lock-profile-name">{p.name}</span>
                  {p.locked && <IconLock size={13} />}
                </button>
              ))}
              <button type="button" className="btn ghost small" onClick={() => setPanel("none")}>
                {t("Back")}
              </button>
            </div>
          )}

          {panel === "new" && <NewProfileForm onDone={() => setPanel("none")} />}

          {panel === "none" && (
            <div className="lock-foot">
              {lock.profiles.length > 0 && (
                <button type="button" className="btn ghost small" onClick={() => setPanel("switch")}>
                  {t("Switch profile")}
                </button>
              )}
              <button type="button" className="btn ghost small" onClick={() => setPanel("new")}>
                <IconPlus size={13} /> {t("New profile")}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
