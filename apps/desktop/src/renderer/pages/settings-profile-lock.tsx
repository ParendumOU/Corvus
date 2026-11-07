import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import type { LockKind, LockMethodView, ProfileLockView, TotpLockSetup } from "../../shared/profile-lock";
import { lockProblemText } from "../common/lock-text";
import { errorMessage, internalApi } from "../common/api";
import { t } from "../common/i18n";
import { Row, Section } from "./shell";

/** A new PIN or password, typed twice; `null` until both are valid and equal. */
export function NewSecretFields({ kind, onChange }: { kind: LockKind; onChange: (secret: string | null, problem: string | null) => void }) {
  const [secret, setSecret] = useState("");
  const [again, setAgain] = useState("");
  useEffect(() => {
    const problem = secret ? lockProblemText(kind, secret) : null;
    const mismatch = again && secret !== again ? t("The two entries do not match.") : null;
    onChange(!problem && secret && secret === again ? secret : null, problem ?? mismatch);
  }, [kind, secret, again, onChange]);
  const numeric = kind === "pin" ? "numeric" : "text";
  return (
    <>
      <input
        className="input"
        type="password"
        inputMode={numeric}
        autoComplete="new-password"
        data-lock-new
        placeholder={kind === "pin" ? t("New PIN (at least 6 digits)") : t("New password (at least 8 characters)")}
        value={secret}
        onChange={(e) => setSecret(e.target.value)}
      />
      <input className="input" type="password" inputMode={numeric} autoComplete="new-password" data-lock-repeat placeholder={t("Repeat it")} value={again} onChange={(e) => setAgain(e.target.value)} />
    </>
  );
}

type Mode = { kind: "enable"; lock: LockKind } | { kind: "change" } | { kind: "remove" } | { kind: "totp" } | { kind: "hello" } | { kind: "fido2" } | { kind: "remove-method"; method: LockMethodView } | null;

const methodName = (m: LockMethodView): string => (m.type === "totp" ? t("Authenticator app") : m.type === "hello" ? t("Windows Hello") : t("Security key"));

/** A small form under the rows: its fields, then Cancel and the action. */
function LockForm({ children, action, disabled, busy, onSubmit, onCancel }: { children: ReactNode; action: string; disabled?: boolean; busy: boolean; onSubmit: () => void; onCancel: () => void }) {
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    if (!disabled && !busy) onSubmit();
  };
  return (
    <form className="lock-settings-form" onSubmit={submit} onKeyDown={(e) => e.key === "Escape" && onCancel()}>
      {children}
      <div className="lock-settings-actions">
        <button type="button" className="btn small ghost" onClick={onCancel}>
          {t("Cancel")}
        </button>
        <button type="submit" className="btn small primary" disabled={disabled || busy} data-lock-save>
          {action}
        </button>
      </div>
    </form>
  );
}

/**
 * Settings > Lock, for this window's profile: none, a PIN or a password, and further ways to unlock
 * (an authenticator app, Windows Hello, a security key). Every change asks the current PIN or
 * password first.
 */
export function ProfileLockSection() {
  const api = internalApi();
  const [view, setView] = useState<ProfileLockView | null>(null);
  const [mode, setMode] = useState<Mode>(null);
  const [current, setCurrent] = useState("");
  const [fresh, setFresh] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [nextKind, setNextKind] = useState<LockKind>("pin");
  const [label, setLabel] = useState("");
  const [setup, setSetup] = useState<TotpLockSetup | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(() => void api.call("profileLock.view").then(setView), [api]);
  useEffect(() => {
    reload();
    return api.onEvent((e) => {
      if (e.type === "profile-lock-changed") reload();
    });
  }, [api, reload]);
  const onSecret = useCallback((secret: string | null, why: string | null) => {
    setFresh(secret);
    setProblem(why);
  }, []);

  const open = (next: Mode): void => {
    setMode(next);
    setCurrent("");
    setFresh(null);
    setProblem(null);
    setLabel("");
    setSetup(null);
    setCode("");
    setError(null);
    setNotice(null);
    if (next?.kind === "change") setNextKind(view?.kind ?? "pin");
  };

  const run = (p: Promise<ProfileLockView>, done?: (v: ProfileLockView) => string | null): void => {
    setBusy(true);
    setError(null);
    p.then((v) => {
      setView(v);
      open(null);
      setNotice(done ? done(v) : null);
    })
      .catch((e: unknown) => setError(errorMessage(e)))
      .finally(() => setBusy(false));
  };

  if (!view) return null;
  const pin = view.kind === "pin";
  const currentField = (
    <input
      className="input"
      type="password"
      inputMode={pin ? "numeric" : "text"}
      autoComplete="current-password"
      autoFocus
      data-lock-current
      placeholder={pin ? t("Current PIN") : t("Current password")}
      value={current}
      onChange={(e) => setCurrent(e.target.value)}
    />
  );
  const keychainOnly = t("A code from an app cannot hold a key: while this way to unlock is added, the profile's secrets on this computer are protected by the system keychain alone (as without a lock), with the lock screen in front of them.");

  return (
    <Section
      id="profile-lock"
      title={t("Lock")}
      description={t("Lock this profile with Alt+H when you step away: its pages hide behind a lock screen, and its saved passwords, 2FA codes, cards, KeePass and sync stay encrypted until it is unlocked.")}
    >
      {!view.keychain && <div className="notice error">{t("A lock needs the system keychain, which is not available.")}</div>}
      {view.kind === null ? (
        <Row label={t("No lock")} hint={t("Anyone at this computer can open this profile's pages and saved passwords.")}>
          <button className="btn small" disabled={!view.keychain} data-lock-enable="pin" onClick={() => open({ kind: "enable", lock: "pin" })}>
            {t("Use a PIN")}
          </button>
          <button className="btn small" disabled={!view.keychain} data-lock-enable="password" onClick={() => open({ kind: "enable", lock: "password" })}>
            {t("Use a password")}
          </button>
        </Row>
      ) : (
        <>
          <Row label={pin ? t("Locked with a PIN") : t("Locked with a password")} hint={t("Alt+H locks it now. It also starts locked when Corvus starts.")}>
            <button className="btn small" data-lock-now onClick={() => void api.call("profileLock.lockNow")}>
              {t("Lock now")}
            </button>
            <button className="btn small" onClick={() => open({ kind: "change" })}>
              {t("Change…")}
            </button>
            <button className="btn small ghost danger" onClick={() => open({ kind: "remove" })}>
              {t("Remove lock…")}
            </button>
          </Row>
          {view.methods.map((m) => (
            <Row
              key={m.id}
              label={`${methodName(m)}${m.label && m.label !== methodName(m) ? ` · ${m.label}` : ""}`}
              hint={m.keyBound ? t("Opens the encryption itself.") : t("A gate only: the key it opens is protected by the system keychain alone.")}
            >
              <button className="btn small ghost danger" onClick={() => open({ kind: "remove-method", method: m })}>
                {t("Remove…")}
              </button>
            </Row>
          ))}
          <Row label={t("Other ways to unlock")} hint={view.webauthn ? t("Windows Hello and security keys that support it (PRF) open the encryption themselves; Corvus says so when one cannot.") : undefined}>
            <button className="btn small" data-lock-add="totp" onClick={() => open({ kind: "totp" })}>
              {t("Authenticator app…")}
            </button>
            {view.webauthn && (
              <>
                <button className="btn small" onClick={() => open({ kind: "hello" })}>
                  {t("Windows Hello…")}
                </button>
                <button className="btn small" onClick={() => open({ kind: "fido2" })}>
                  {t("Security key…")}
                </button>
              </>
            )}
          </Row>
        </>
      )}

      {mode?.kind === "enable" && (
        <LockForm
          action={t("Turn on the lock")}
          busy={busy}
          disabled={!fresh}
          onCancel={() => open(null)}
          onSubmit={() => run(api.call("profileLock.enable", mode.lock, fresh!), () => t("This profile is locked with Alt+H from now on."))}
        >
          <NewSecretFields kind={mode.lock} onChange={onSecret} />
          {problem && <div className="muted small error-text">{problem}</div>}
        </LockForm>
      )}

      {mode?.kind === "change" && (
        <LockForm action={t("Save")} busy={busy} disabled={!fresh || !current} onCancel={() => open(null)} onSubmit={() => run(api.call("profileLock.change", current, nextKind, fresh!))}>
          {currentField}
          <div className="lock-settings-kinds">
            {(["pin", "password"] as const).map((k) => (
              <label key={k} className="inline">
                <input type="radio" name="lock-kind" checked={nextKind === k} onChange={() => setNextKind(k)} />
                {k === "pin" ? t("PIN") : t("Password")}
              </label>
            ))}
          </div>
          <NewSecretFields key={nextKind} kind={nextKind} onChange={onSecret} />
          {problem && <div className="muted small error-text">{problem}</div>}
        </LockForm>
      )}

      {mode?.kind === "remove" && (
        <LockForm action={t("Remove lock")} busy={busy} disabled={!current} onCancel={() => open(null)} onSubmit={() => run(api.call("profileLock.remove", current))}>
          <div className="muted small">{t("Its secrets go back to being protected by the system keychain alone.")}</div>
          {currentField}
        </LockForm>
      )}

      {mode?.kind === "remove-method" && (
        <LockForm action={t("Remove")} busy={busy} disabled={!current} onCancel={() => open(null)} onSubmit={() => run(api.call("profileLock.removeMethod", current, mode.method.id))}>
          {currentField}
        </LockForm>
      )}

      {mode?.kind === "totp" && !setup && (
        <LockForm
          action={t("Continue")}
          busy={busy}
          disabled={!current}
          onCancel={() => open(null)}
          onSubmit={() => {
            setBusy(true);
            setError(null);
            api
              .call("profileLock.totpStart", current)
              .then(setSetup)
              .catch((e: unknown) => setError(errorMessage(e)))
              .finally(() => setBusy(false));
          }}
        >
          <div className="notice">{keychainOnly}</div>
          {currentField}
        </LockForm>
      )}

      {mode?.kind === "totp" && setup && (
        <LockForm
          action={t("Add")}
          busy={busy}
          disabled={!/^\d{6}$/.test(code.replace(/\s+/g, ""))}
          onCancel={() => open(null)}
          onSubmit={() => run(api.call("profileLock.totpConfirm", setup.setupId, code, label))}
        >
          <div className="muted small">{t("Scan this code with your authenticator app (it is shown only now), then type the code the app shows.")}</div>
          <img className="lock-qr" alt={t("Code to scan")} src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(setup.qrSvg)}`} />
          <code className="lock-secret" data-lock-totp-secret>
            {setup.secret.replace(/(.{4})/g, "$1 ").trim()}
          </code>
          <input className="input" placeholder={t("Name (optional)")} value={label} maxLength={60} onChange={(e) => setLabel(e.target.value)} />
          <input className="input" inputMode="numeric" autoComplete="one-time-code" placeholder={t("6-digit code")} value={code} data-lock-totp-code onChange={(e) => setCode(e.target.value.replace(/[^\d ]/g, ""))} />
        </LockForm>
      )}

      {(mode?.kind === "hello" || mode?.kind === "fido2") && (
        <LockForm
          action={mode.kind === "hello" ? t("Set up Windows Hello") : t("Set up the security key")}
          busy={busy}
          disabled={!current}
          onCancel={() => open(null)}
          onSubmit={() =>
            run(api.call("profileLock.addAuthenticator", mode.kind, current, label), (v) =>
              v.methods[v.methods.length - 1]?.keyBound
                ? t("Added: it opens the encryption itself.")
                : t("Added. This authenticator cannot give Corvus a key (no PRF): it unlocks the profile, but its copy of the key is protected by the system keychain alone."),
            )
          }
        >
          <div className="muted small">{mode.kind === "hello" ? t("Windows asks for your face, fingerprint or Windows PIN.") : t("Windows asks you to insert and touch the key (and its PIN, if it has one).")}</div>
          <input className="input" placeholder={t("Name (optional)")} value={label} maxLength={60} onChange={(e) => setLabel(e.target.value)} />
          {currentField}
        </LockForm>
      )}

      {error && <div className="notice error">{error}</div>}
      {notice && <div className="notice">{notice}</div>}
    </Section>
  );
}
