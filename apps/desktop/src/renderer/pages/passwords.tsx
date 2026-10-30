import { useCallback, useEffect, useMemo, useState } from "react";
import type { CredentialSummary, PasswordOptions } from "../../shared/credentials";
import { DEFAULT_PASSWORD_OPTIONS, generatePassword } from "../../shared/credentials";
import type { RevealedCredential } from "../../shared/credentials-ipc";
import type { KeePassDbView, KeePassEntryDetails, KeePassEntrySummary, KeePassExportResult, KeePassState, KeePassUnlockResult } from "../../shared/keepass-ipc";
import { checkupSummary, type PasswordCheckupView, type PasswordHealth } from "../../shared/password-health";
import { formatTotpCode, type TotpCode } from "../../shared/totp";
import { errorMessage, internalApi } from "../common/api";
import { Modal } from "../common/modal";
import { IconAgent, IconCamera, IconClock, IconCopy, IconEdit, IconFile, IconFolder, IconLock, IconPlus, IconTrash } from "../common/icons";
import { Favicon, Pager, hostOf } from "../common/ui";
import { AuthenticatorImport } from "./authenticator-import";
import { PageShell, mount } from "./shell";
import "./passwords.css";

import { t } from "../common/i18n";
interface FormState {
  id: string | null;
  origin: string;
  username: string;
  password: string;
  notes: string;
  /** otpauth:// link or base32 secret as typed; "" = no 2FA. */
  totp: string;
  /** Readable name of an imported QR code, shown instead of the raw link. */
  totpLabel: string;
  agentTotp: boolean;
  agentSignIn: boolean;
}

const EMPTY_FORM: FormState = { id: null, origin: "", username: "", password: "", notes: "", totp: "", totpLabel: "", agentTotp: false, agentSignIn: false };

const TWO_FACTOR_WARNING =
  t("Keeping a 2FA secret next to the password turns two factors into one: anyone who can open this vault gets both. Use a separate authenticator for your most important accounts.");

/** Live 2FA code for one login: asks the main process for the current code (never the secret). */
function TotpCodeView({ load, copy }: { load: () => Promise<TotpCode | null>; copy: () => Promise<void> }) {
  const [code, setCode] = useState<TotpCode | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fetchCode = (): void => {
      void load().then((next) => {
        if (!alive) return;
        setCode(next);
        if (next) timer = setTimeout(fetchCode, Math.max(250, next.expiresAt - Date.now() + 50));
      });
    };
    fetchCode();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [load]);

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, []);

  if (!code) return null;
  const left = Math.max(0, Math.ceil((code.expiresAt - now) / 1000));
  const onCopy = (): void => {
    void copy().then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };
  return (
    <div className="pw-totp" title={t("Current 2FA code")}>
      <IconClock size={13} />
      <span className="pw-totp-code">{formatTotpCode(code.code)}</span>
      <span className={`pw-totp-left ${left <= 5 ? "low" : ""}`} aria-label={t("{left} seconds left", { left })}>
        <span className="pw-totp-bar" style={{ width: `${(left / code.period) * 100}%` }} />
        {left}s
      </span>
      <button className="icon-btn" title={copied ? t("Copied") : t("Copy 2FA code")} onClick={onCopy}>
        <IconCopy size={14} />
      </button>
    </div>
  );
}

function VaultTotp({ id }: { id: string }) {
  const api = internalApi();
  const load = useCallback(() => api.call("credentials.totpCode", id) as Promise<TotpCode | null>, [api, id]);
  const copy = useCallback(() => api.call("credentials.copyTotp", id) as Promise<void>, [api, id]);
  return <TotpCodeView load={load} copy={copy} />;
}

/** "AI: sign-in" / "AI: 2FA" chips for logins an agent may use. */
function AgentChips({ signIn, totp, globalOn }: { signIn: boolean; totp: boolean; globalOn: boolean }) {
  if (!signIn && !totp) return null;
  const title = globalOn ? t("AI agents may use this after asking you") : t("Opted in, but AI agent use is off in Settings");
  return (
    <span className={`pw-agent ${globalOn ? "" : "off"}`} title={title}>
      <IconAgent size={12} />
      {[signIn ? "sign-in" : "", totp ? "2FA" : ""].filter(Boolean).join(" + ")}
    </span>
  );
}

/** "In 12 breaches" / "Reused" / "Weak" chips for one login, from the last password checkup. */
function HealthChips({ health }: { health: PasswordHealth | undefined }) {
  if (!health) return null;
  const breaches = health.breaches ?? 0;
  return (
    <>
      {breaches > 0 && (
        <span className="pw-health danger" title={t("This password appears in known data breaches: change it on the site, then here")}>{t("In {v}", { v: breaches.toLocaleString() })}{" "}{breaches === 1 ? "breach" : "breaches"}
        </span>
      )}
      {health.reusedWith > 0 && (
        <span className="pw-health" title={health.reusedWith === 1 ? t("The same password is saved for 1 other login") : t("The same password is saved for {n} other logins", { n: health.reusedWith })}>{t("Reused")}</span>
      )}
      {health.weak && (
        <span className="pw-health" title={t("Short, common or easy to guess")}>{t("Weak")}</span>
      )}
    </>
  );
}

/** Breached, reused and weak passwords at a glance, with the (on request) breach check. */
function CheckupCard({ view, onRun }: { view: PasswordCheckupView | null; onRun: () => void }) {
  if (!view || view.items.length === 0) return null;
  const { breached, reused, weak } = checkupSummary(view.items);
  return (
    <div className="card pw-checkup">
      <div className="card-head">
        <h2>{t("Password checkup")}</h2>
        <button className="btn small" disabled={view.running} onClick={onRun}>
          {view.running ? t("Checking…") : view.checkedAt ? t("Check again") : t("Check for breaches")}
        </button>
      </div>
      <div className="card-body pw-checkup-body">
        <div className="pw-checkup-line">
          <strong>{view.checkedAt ? breached : "—"}</strong>
          {view.checkedAt
            ? breached > 0
              ? breached === 1 ? t("password appears in known data breaches. Change it first.") : t("passwords appear in known data breaches. Change them first.")
              : t("of your passwords appear in known data breaches.")
            : t("Find out whether your saved passwords appear in known data breaches.")}
        </div>
        <div className="pw-checkup-line">
          <strong>{reused}</strong> {reused === 1 ? t("login shares a password with another login.") : t("logins share a password with another login.")}</div>
        <div className="pw-checkup-line">
          <strong>{weak}</strong> {weak === 1 ? t("password is weak (short, common or easy to guess).") : t("passwords are weak (short, common or easy to guess).")}</div>
        {view.error && <div className="pw-error">{view.error}</div>}
        <div className="pw-hint">{t("Only the first 5 characters of each password’s SHA-1 hash are sent to Have I Been Pwned, which answers with every breached hash that starts with them; the match happens on this device and your passwords never leave it.")}</div>
      </div>
    </div>
  );
}

function PasswordsPage() {
  const api = internalApi();
  const [checkup, setCheckup] = useState<PasswordCheckupView | null>(null);
  const reloadCheckup = useCallback(() => void api.call("credentials.checkup").then(setCheckup), [api]);
  const runCheckup = (): void => {
    setCheckup((c) => (c ? { ...c, running: true } : c));
    void api.call("credentials.runCheckup").then(setCheckup, reloadCheckup);
  };
  useEffect(() => {
    reloadCheckup();
    return api.onEvent((e) => (e.type === "credentials-changed" || e.type === "keepass-changed") && reloadCheckup());
  }, [api, reloadCheckup]);
  const health = new Map((checkup?.items ?? []).map((h) => [h.id, h]));
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<CredentialSummary[]>([]);
  const [persisted, setPersisted] = useState(true);
  const [agentAccess, setAgentAccess] = useState(false);
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [form, setForm] = useState<FormState | null>(null);
  const [options, setOptions] = useState<PasswordOptions>(DEFAULT_PASSWORD_OPTIONS);
  const [error, setError] = useState<string | null>(null);
  const [qrError, setQrError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [autoIds, setAutoIds] = useState<Set<string>>(new Set());
  const setAutoSignIn = useCallback(
    (id: string, on: boolean) => void api.call("credentials.setAutoSignIn", id, on).then((ids) => setAutoIds(new Set(ids))),
    [api],
  );

  const load = useCallback((q: string) => void api.call("credentials.list", q).then(setItems), [api]);

  useEffect(() => {
    void api.call("credentials.persisted").then(setPersisted);
    void api.call("credentials.agentAccess").then(setAgentAccess);
    void api.call("credentials.autoSignInIds").then((ids) => setAutoIds(new Set(ids)));
  }, [api]);

  useEffect(() => {
    const timer = setTimeout(() => load(query), 120);
    return () => clearTimeout(timer);
  }, [query, load]);

  useEffect(() => api.onEvent((e) => e.type === "credentials-changed" && load(query)), [api, query, load]);

  const reveal = async (id: string): Promise<void> => {
    if (revealed[id]) {
      setRevealed(({ [id]: _gone, ...rest }) => rest);
      return;
    }
    if (!window.confirm(t("Reveal this password?"))) return;
    const cred = (await api.call("credentials.reveal", id)) as RevealedCredential;
    setRevealed((r) => ({ ...r, [id]: cred.password }));
  };

  const copyPassword = async (id: string): Promise<void> => {
    const cred = (await api.call("credentials.reveal", id)) as RevealedCredential;
    await api.call("clipboard.write", cred.password);
  };

  const openEdit = async (item: CredentialSummary): Promise<void> => {
    if (!window.confirm(t("Edit this login? Its password and 2FA secret will be shown in the form."))) return;
    const cred = (await api.call("credentials.reveal", item.id)) as RevealedCredential;
    setError(null);
    setQrError(null);
    setForm({
      id: item.id,
      origin: cred.origin,
      username: cred.username,
      password: cred.password,
      notes: cred.notes,
      totp: cred.totp,
      totpLabel: "",
      agentTotp: cred.agentTotp,
      agentSignIn: cred.agentSignIn,
    });
  };

  const remove = (id: string): void => {
    if (!window.confirm(t("Delete this login? This cannot be undone."))) return;
    void api.call("credentials.remove", id).then(() => load(query));
  };

  const generate = (): void => void api.call("credentials.generate", options).then((pw) => setForm((f) => (f ? { ...f, password: pw } : f)));

  const importQr = async (): Promise<void> => {
    setQrError(null);
    const result = await api.call("credentials.importTotpQr");
    if (!result) return;
    if (!result.ok) {
      setQrError(result.error);
      return;
    }
    setForm((f) => (f ? { ...f, totp: result.uri, totpLabel: result.label || t("QR code imported") } : f));
  };

  const submit = async (): Promise<void> => {
    if (!form) return;
    setError(null);
    const fields = {
      origin: form.origin,
      username: form.username,
      password: form.password,
      notes: form.notes,
      totp: form.totp,
      agentTotp: form.agentTotp && Boolean(form.totp.trim()),
      agentSignIn: form.agentSignIn,
    };
    try {
      if (form.id) await api.call("credentials.update", form.id, fields);
      else await api.call("credentials.add", fields);
      setForm(null);
      load(query);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const set = (patch: Partial<FormState>): void => setForm((f) => (f ? { ...f, ...patch } : f));
  const toggle = (key: keyof PasswordOptions): void => setOptions((o) => ({ ...o, [key]: !o[key] }));
  const anyTotp = items.some((i) => i.hasTotp);
  const hasTotp = Boolean(form?.totp.trim());

  return (
    <PageShell
      title={t("Passwords")}
      active="passwords"
      toolbar={
        <>
          <input className="input" placeholder={t("Search logins")} value={query} onChange={(e) => setQuery(e.target.value)} />
          <button className="btn" onClick={() => {
            setForm(null);
            setImporting(true);
          }}>
            <IconCamera size={14} />{" "}{t("Import from Google Authenticator")}</button>
          <button className="btn primary" onClick={() => {
            setError(null);
            setQrError(null);
            setImporting(false);
            setForm(EMPTY_FORM);
          }}>
            <IconPlus size={14} />{" "}{t("Add")}</button>
        </>
      }
    >
      {!persisted && (
        <div className="card">
          <div className="pw-warn">{t("No system keychain is available, so saved logins are kept in memory for this session only and are not written to disk.")}</div>
        </div>
      )}

      {importing && <AuthenticatorImport onClose={() => setImporting(false)} onImported={() => load(query)} />}

      {form && (
        <div className="card">
          <div className="card-head">
            <h2>{form.id ? t("Edit login") : t("Add login")}</h2>
          </div>
          <div className="card-body padded pw-form">
            <label className="pw-field">
              <span>{t("Site")}</span>
              <input className="input" placeholder={t("https://example.com")} value={form.origin} onChange={(e) => set({ origin: e.target.value })} />
            </label>
            <label className="pw-field">
              <span>{t("Username")}</span>
              <input className="input" autoComplete="off" value={form.username} onChange={(e) => set({ username: e.target.value })} />
            </label>
            <label className="pw-field">
              <span>{t("Password")}</span>
              <input className="input" type="text" autoComplete="off" value={form.password} onChange={(e) => set({ password: e.target.value })} />
            </label>
            <div className="pw-gen">
              <button className="btn small" onClick={generate}>{t("Generate")}</button>
              <label className="pw-opt">{t("Length")}<input className="input pw-len" type="number" min={4} max={128} value={options.length} onChange={(e) => setOptions((o) => ({ ...o, length: Number(e.target.value) || 20 }))} />
              </label>
              <label className="pw-opt"><input type="checkbox" checked={options.uppercase} onChange={() => toggle("uppercase")} /> A-Z</label>
              <label className="pw-opt"><input type="checkbox" checked={options.lowercase} onChange={() => toggle("lowercase")} /> a-z</label>
              <label className="pw-opt"><input type="checkbox" checked={options.digits} onChange={() => toggle("digits")} /> 0-9</label>
              <label className="pw-opt"><input type="checkbox" checked={options.symbols} onChange={() => toggle("symbols")} /> !@#</label>
            </div>
            <div className="pw-field">
              <span>{t("2FA (optional)")}</span>
              {form.totpLabel ? (
                <div className="pw-totp-imported">
                  <IconClock size={13} /> {form.totpLabel}
                  <button className="btn small ghost" onClick={() => set({ totp: "", totpLabel: "" })}>{t("Remove")}</button>
                </div>
              ) : (
                <input
                  className="input pw-totp-input"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={t("Paste an otpauth:// link or the base32 secret")}
                  value={form.totp}
                  onChange={(e) => set({ totp: e.target.value })}
                />
              )}
              <div className="pw-gen">
                <button className="btn small" onClick={() => void importQr()}>{t("Import QR code image")}</button>
                {hasTotp && !form.totpLabel && <button className="btn small ghost" onClick={() => set({ totp: "" })}>{t("Remove 2FA")}</button>}
                <span>{t("Decoded on this device; the image is not uploaded.")}</span>
              </div>
              {qrError && <div className="pw-error">{qrError}</div>}
              {hasTotp && <div className="pw-warn">{TWO_FACTOR_WARNING}</div>}
            </div>
            <div className="pw-field">
              <span>{t("AI agents")}</span>
              <label className="pw-opt">
                <input type="checkbox" checked={form.agentSignIn} onChange={(e) => set({ agentSignIn: e.target.checked })} />{" "}{t("Let AI agents sign in with this login")}</label>
              <label className="pw-opt">
                <input type="checkbox" disabled={!hasTotp} checked={form.agentTotp && hasTotp} onChange={(e) => set({ agentTotp: e.target.checked })} />{" "}{t("Let AI agents use this 2FA code")}</label>
              <div className="pw-hint">{t("Agents never see the password or the code: Corvus fills them into the page after you approve each use.")}{!agentAccess && (
                  <>
                    {" "}{t("AI agent use is off for every login until you turn it on in")}{" "}<a href="corvus://settings/#passwords">{t("Settings")}</a>.
                  </>
                )}
              </div>
            </div>
            <label className="pw-field">
              <span>{t("Notes")}</span>
              <textarea className="input pw-notes" value={form.notes} onChange={(e) => set({ notes: e.target.value })} />
            </label>
            {error && <div className="pw-error">{error}</div>}
            <div className="pw-actions">
              <button className="btn primary" onClick={submit}>{t("Save")}</button>
              <button className="btn ghost" onClick={() => setForm(null)}>{t("Cancel")}</button>
            </div>
          </div>
        </div>
      )}

      {!form && !importing && <CheckupCard view={checkup} onRun={runCheckup} />}

      {anyTotp && !form && !importing && (
        <div className="card">
          <div className="pw-warn">{TWO_FACTOR_WARNING}</div>
        </div>
      )}

      <div className="card">
        {items.length === 0 ? (
          <div className="empty">{query ? t("No logins match your search.") : t("No saved logins yet. Sign in to a site or add one with the Add button.")}</div>
        ) : (
          <div className="list">
            {items.map((item) => (
              <div key={item.id} className="list-row" style={{ alignItems: "center" }}>
                <Favicon url={item.origin} />
                <div className="grow">
                  <div className="title">
                    {item.username || t("(no username)")} <AgentChips signIn={item.agentSignIn} totp={item.agentTotp} globalOn={agentAccess} />
                    <HealthChips health={health.get(item.id)} />
                  </div>
                  <div className="sub">{hostOf(item.origin)}</div>
                  <AutoSignInToggle id={item.id} on={autoIds.has(item.id)} onChange={setAutoSignIn} />
                  {revealed[item.id] && <div className="pw-reveal">{revealed[item.id]}</div>}
                </div>
                {item.hasTotp && <VaultTotp id={item.id} />}
                <div className="actions">
                  <button className="btn small ghost" title={t("Reveal password")} onClick={() => void reveal(item.id)}>
                    <IconLock size={13} /> {revealed[item.id] ? t("Hide") : t("Show")}
                  </button>
                  <button className="icon-btn" title={t("Copy password")} onClick={() => void copyPassword(item.id)}>
                    <IconCopy size={15} />
                  </button>
                  <button className="icon-btn" title={t("Edit")} onClick={() => void openEdit(item)}>
                    <IconEdit size={15} />
                  </button>
                  <button className="icon-btn" title={t("Delete")} onClick={() => remove(item.id)}>
                    <IconTrash size={15} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <KeePassSection query={query} agentAccess={agentAccess} autoIds={autoIds} onAutoSignIn={setAutoSignIn} health={health} />
    </PageShell>
  );
}

/** Per-login opt-in: when this login's form loads, Corvus asks once, then fills and submits it. */
function AutoSignInToggle({ id, on, onChange }: { id: string; on: boolean; onChange: (id: string, on: boolean) => void }) {
  return (
    <label className="pw-opt pw-auto" title={t("Corvus asks before each automatic sign-in")}>
      <input type="checkbox" checked={on} onChange={(e) => onChange(id, e.target.checked)} />{" "}{t("Sign in automatically on this site (asks first)")}</label>
  );
}

function KeePassTotp({ id }: { id: string }) {
  const api = internalApi();
  const load = useCallback(() => api.call("keepass.totpCode", id) as Promise<TotpCode | null>, [api, id]);
  const copy = useCallback(() => api.call("keepass.copyTotp", id) as Promise<void>, [api, id]);
  return <TotpCodeView load={load} copy={copy} />;
}

function baseName(file: string): string {
  return file.split(/[\\/]/).pop() ?? file;
}

/** Inline unlock form for one database: master password, optional key file, "Keep unlocked". */
function UnlockForm({ db, canRemember, onDone }: { db: KeePassDbView; canRemember: boolean; onDone: () => void }) {
  const api = internalApi();
  const [password, setPassword] = useState("");
  const [keyFile, setKeyFile] = useState<string | null>(null);
  const [keep, setKeep] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const unlock = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    const result = (await api.call("keepass.unlock", db.id, password, keyFile, keep)) as KeePassUnlockResult;
    setBusy(false);
    if (result.ok) {
      setPassword("");
      onDone();
    } else {
      setError(result.error);
    }
  };

  return (
    <form
      className="kp-unlock"
      onSubmit={(e) => {
        e.preventDefault();
        void unlock();
      }}
    >
      <input
        className="input"
        type="password"
        autoFocus
        autoComplete="off"
        placeholder={t("Master password for {name}", { name: db.name })}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      <div className="pw-gen">
        <button type="button" className="btn small" onClick={() => void api.call("keepass.pickKeyFile").then((p) => p && setKeyFile(p))}>
          {keyFile ? t("Key file: {keyFile}", { keyFile: baseName(keyFile) }) : t("Key file (optional)")}
        </button>
        {keyFile && (
          <button type="button" className="btn small ghost" onClick={() => setKeyFile(null)}>{t("No key file")}</button>
        )}
        <label className="pw-opt" title={canRemember ? "" : t("No system keychain is available on this device.")}>
          <input type="checkbox" disabled={!canRemember} checked={keep && canRemember} onChange={(e) => setKeep(e.target.checked)} />{" "}{t("Keep unlocked on this device")}</label>
      </div>
      <div className="pw-hint">
        {keep
          ? t("The master password is stored encrypted with your system keychain, never in plain text and never synced. The database unlocks when Corvus starts and does not auto-lock.")
          : t("The database stays unlocked until you lock it, Corvus quits, or the idle time in Settings passes.")}
      </div>
      {error && <div className="pw-error">{error}</div>}
      <div className="pw-actions">
        <button type="submit" className="btn primary small" disabled={busy}>
          {busy ? t("Unlocking...") : t("Unlock")}
        </button>
        <button type="button" className="btn ghost small" onClick={onDone}>{t("Cancel")}</button>
      </div>
    </form>
  );
}

function ExportForm({ onClose }: { onClose: () => void }) {
  const api = internalApi();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<KeePassExportResult>(null);
  const mismatch = confirm.length > 0 && confirm !== password;

  const run = async (): Promise<void> => {
    setBusy(true);
    setResult((await api.call("keepass.export", password)) as KeePassExportResult);
    setBusy(false);
  };

  return (
    <div className="kp-export">
      <div className="pw-hint">{t("Writes your saved logins and their 2FA secrets to a new KeePass database, protected by a master password you choose. Corvus never overwrites an existing file.")}</div>
      <input className="input" type="password" autoComplete="new-password" placeholder={t("New master password (8+ characters)")} value={password} onChange={(e) => setPassword(e.target.value)} />
      <input className="input" type="password" autoComplete="new-password" placeholder={t("Repeat the master password")} value={confirm} onChange={(e) => setConfirm(e.target.value)} />
      {mismatch && <div className="pw-error">{t("The passwords do not match.")}</div>}
      {result && (result.ok ? <div className="pw-hint">{t("Exported {count} logins to {path}.", { count: result.count, path: result.path })}</div> : <div className="pw-error">{result.error}</div>)}
      <div className="pw-actions">
        <button className="btn primary small" disabled={busy || password.length < 8 || password !== confirm} onClick={() => void run()}>
          {busy ? t("Exporting...") : t("Choose file and export")}
        </button>
        <button className="btn ghost small" onClick={onClose}>{t("Close")}</button>
      </div>
    </div>
  );
}

const STATUS_LABEL: Record<KeePassDbView["status"], string> = { locked: t("Locked"), unlocking: t("Unlocking"), unlocked: t("Unlocked"), missing: t("File not found") };

/** KeePass databases as a second source of logins (browse, add, edit), plus export of the built-in vault. */
function KeePassSection({
  query,
  agentAccess,
  autoIds,
  onAutoSignIn,
  health,
}: {
  query: string;
  agentAccess: boolean;
  autoIds: Set<string>;
  onAutoSignIn: (id: string, on: boolean) => void;
  health: Map<string, PasswordHealth>;
}) {
  const api = internalApi();
  const [state, setState] = useState<KeePassState | null>(null);
  const [entries, setEntries] = useState<KeePassEntrySummary[]>([]);
  const [unlocking, setUnlocking] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [exporting, setExporting] = useState(false);

  const refresh = useCallback(() => {
    void api.call("keepass.state").then(setState);
    void api.call("keepass.entries", query).then(setEntries);
  }, [api, query]);

  useEffect(() => {
    const timer = setTimeout(refresh, 120);
    return () => clearTimeout(timer);
  }, [refresh]);

  useEffect(() => api.onEvent((e) => e.type === "keepass-changed" && refresh()), [api, refresh]);

  const reveal = async (id: string): Promise<void> => {
    if (revealed[id]) {
      setRevealed(({ [id]: _gone, ...rest }) => rest);
      return;
    }
    if (!window.confirm(t("Reveal this password?"))) return;
    const password = (await api.call("keepass.reveal", id)) as string;
    setRevealed((r) => ({ ...r, [id]: password }));
  };

  const optIn = (id: string, patch: { signIn?: boolean; totp?: boolean }): void => {
    void api.call("keepass.setAgentOptIn", id, patch).then(refresh);
  };

  const removeSource = (id: string): void => {
    if (!window.confirm(t("Stop using this KeePass source? The database file itself is not touched."))) return;
    void api.call("keepass.removeSource", id).then(setState);
  };

  const sourceOf = (db: KeePassDbView) => state?.sources.find((s) => s.id === db.sourceId);

  return (
    <div className="card" id="keepass">
      <div className="card-head">
        <h2>{t("KeePass")}</h2>
        <p className="muted">{t("Use logins and 2FA codes from KeePass (.kdbx) databases. Corvus writes to a database only to add or edit an entry you ask for here, keeping a .bak copy of the file first.")}</p>
      </div>
      <div className="card-body padded pw-form">
        <div className="pw-gen">
          <button className="btn small" onClick={() => void api.call("keepass.addFiles").then(setState)}>
            <IconFile size={13} />{" "}{t("Add database file")}</button>
          <button className="btn small" onClick={() => void api.call("keepass.addFolder").then(setState)}>
            <IconFolder size={13} />{" "}{t("Add folder")}</button>
          {state && state.databases.some((d) => d.status === "unlocked") && (
            <button className="btn small ghost" onClick={() => void api.call("keepass.lock", null).then(setState)}>
              <IconLock size={13} />{" "}{t("Lock all")}</button>
          )}
          <button className="btn small ghost" onClick={() => setExporting((v) => !v)}>{t("Export saved logins to KeePass")}</button>
        </div>
        {exporting && <ExportForm onClose={() => setExporting(false)} />}

        {state && state.sources.length === 0 && <div className="pw-hint">{t("No KeePass databases yet. Add a .kdbx file, or a folder that holds them.")}</div>}
        {state && state.sources.filter((s) => s.kind === "folder").map((s) => (
          <div key={s.id} className="kp-source">
            <IconFolder size={13} /> <span className="grow">{s.path}</span>
            <span className="pw-hint">{s.databases} {s.databases === 1 ? "database" : "databases"}</span>
            <button className="icon-btn" title={t("Remove folder")} onClick={() => removeSource(s.id)}>
              <IconTrash size={14} />
            </button>
          </div>
        ))}

        {state && state.databases.length > 0 && (
          <div className="list kp-dbs">
            {state.databases.map((db) => (
              <div key={db.id} className="kp-db">
                <div className="list-row" style={{ alignItems: "center" }}>
                  <IconLock size={15} />
                  <div className="grow">
                    <div className="title">
                      {db.name} <span className={`kp-status ${db.status}`}>{STATUS_LABEL[db.status]}</span>
                      {db.remembered && <span className="kp-status kept" title={t("Unlocks when Corvus starts")}>{t("Kept unlocked")}</span>}
                    </div>
                    <div className="sub">
                      {db.path}
                      {db.status === "unlocked" ? t(" · {entryCount} entries", { entryCount: db.entryCount }) : ""}
                    </div>
                    {db.error && <div className="pw-error">{db.error}</div>}
                  </div>
                  <div className="actions">
                    {db.status === "locked" && unlocking !== db.id && (
                      <button className="btn small primary" onClick={() => setUnlocking(db.id)}>{t("Unlock")}</button>
                    )}
                    {db.status === "unlocked" && (
                      <button className="btn small ghost" title={db.remembered ? t("Locks it and forgets the kept master password") : t("Lock now")} onClick={() => void api.call("keepass.lock", db.id).then(setState)}>{t("Lock")}</button>
                    )}
                    {sourceOf(db)?.kind === "file" && (
                      <button className="icon-btn" title={t("Remove database")} onClick={() => removeSource(db.sourceId)}>
                        <IconTrash size={14} />
                      </button>
                    )}
                  </div>
                </div>
                {unlocking === db.id && db.status !== "unlocked" && (
                  <UnlockForm
                    db={db}
                    canRemember={state.canRemember}
                    onDone={() => {
                      setUnlocking(null);
                      refresh();
                    }}
                  />
                )}
              </div>
            ))}
          </div>
        )}

        <KeePassBrowser
          entries={entries}
          dbs={state?.databases ?? []}
          agentAccess={agentAccess}
          autoIds={autoIds}
          onAutoSignIn={onAutoSignIn}
          health={health}
          revealed={revealed}
          reveal={(id) => void reveal(id)}
          optIn={optIn}
          refresh={refresh}
        />
        {entries.some((e) => e.hasTotp) && <div className="pw-warn">{TWO_FACTOR_WARNING}</div>}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ KeePass entries: browse, add, edit

const KP_PAGE = 25;

/** The form for a new entry, or for changing one (its password stays unless a new one is typed). */
function KeePassEntryForm({ dbs, editing, onClose, onSaved }: { dbs: KeePassDbView[]; editing: KeePassEntrySummary | null; onClose: () => void; onSaved: () => void }) {
  const api = internalApi();
  const [dbId, setDbId] = useState(editing?.dbId ?? dbs[0]?.id ?? "");
  const [groups, setGroups] = useState<string[]>([""]);
  const [form, setForm] = useState<KeePassEntryDetails>({ title: editing?.title ?? "", username: editing?.username ?? "", url: "", notes: "", group: editing?.group ?? "" });
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (dbId) void api.call("keepass.groups", dbId).then((g) => setGroups(g.length ? g : [""]));
  }, [api, dbId]);
  useEffect(() => {
    if (editing) void api.call("keepass.details", editing.id).then((d) => d && setForm(d));
  }, [api, editing]);

  const set = (patch: Partial<KeePassEntryDetails>): void => setForm((f) => ({ ...f, ...patch }));
  const save = (): void => {
    setBusy(true);
    setError(null);
    const uuid = editing ? editing.id.split(":").slice(2).join(":") : undefined;
    api
      .call("keepass.saveEntry", dbId, { ...form, ...(uuid ? { uuid } : {}), ...(password || !editing ? { password } : {}) })
      .then(onSaved)
      .catch((e: unknown) => setError(errorMessage(e)))
      .finally(() => setBusy(false));
  };

  return (
    <Modal
      wide
      title={editing ? t("Edit KeePass entry") : t("New KeePass entry")}
      onClose={onClose}
      footer={
        <>
          <span className="grow muted small">{t("Corvus keeps a .bak copy of the file before its first change.")}</span>
          <button className="btn" onClick={onClose}>
            {t("Cancel")}
          </button>
          <button className="btn primary" disabled={busy || !form.title.trim() || !dbId} onClick={save}>
            {busy ? t("Saving…") : t("Save to the database")}
          </button>
        </>
      }
    >
      {error && <div className="pw-error">{error}</div>}
      <div className="kp-form-grid">
        {!editing && dbs.length > 1 && (
          <label className="modal-field">
            <span>{t("Database")}</span>
            <select className="input" value={dbId} onChange={(e) => setDbId(e.target.value)}>
              {dbs.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {!editing && (
          <label className="modal-field">
            <span>{t("Group")}</span>
            <select className="input" value={form.group} onChange={(e) => set({ group: e.target.value })}>
              {groups.map((g) => (
                <option key={g} value={g}>
                  {g || t("(top level)")}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="modal-field">
          <span>{t("Title")}</span>
          <input className="input" autoFocus value={form.title} onChange={(e) => set({ title: e.target.value })} />
        </label>
        <label className="modal-field">
          <span>{t("Username")}</span>
          <input className="input" value={form.username} autoComplete="off" spellCheck={false} onChange={(e) => set({ username: e.target.value })} />
        </label>
        <label className="modal-field">
          <span>{editing ? t("New password (leave empty to keep it)") : t("Password")}</span>
          <span className="kp-password">
            <input className="input" type={show ? "text" : "password"} value={password} autoComplete="new-password" spellCheck={false} onChange={(e) => setPassword(e.target.value)} />
            <button type="button" className="btn small ghost" onClick={() => setShow((s) => !s)}>
              {show ? t("Hide") : t("Show")}
            </button>
            <button
              type="button"
              className="btn small"
              onClick={() => {
                setPassword(generatePassword(DEFAULT_PASSWORD_OPTIONS));
                setShow(true);
              }}
            >
              {t("Generate")}
            </button>
          </span>
        </label>
        <label className="modal-field">
          <span>{t("Address")}</span>
          <input className="input" value={form.url} placeholder="https://" spellCheck={false} onChange={(e) => set({ url: e.target.value })} />
        </label>
        <label className="modal-field kp-notes">
          <span>{t("Notes")}</span>
          <textarea className="input" rows={3} value={form.notes} onChange={(e) => set({ notes: e.target.value })} />
        </label>
      </div>
    </Modal>
  );
}

/**
 * The entries of the unlocked databases: groups as folders on the left, a search, a compact table a
 * page at a time; a row opens to its password, 2FA code, AI agent options and Edit.
 */
function KeePassBrowser({
  entries,
  dbs,
  agentAccess,
  autoIds,
  onAutoSignIn,
  health,
  revealed,
  reveal,
  optIn,
  refresh,
}: {
  entries: KeePassEntrySummary[];
  dbs: KeePassDbView[];
  agentAccess: boolean;
  autoIds: Set<string>;
  onAutoSignIn: (id: string, on: boolean) => void;
  health: Map<string, PasswordHealth>;
  revealed: Record<string, string>;
  reveal: (id: string) => void;
  optIn: (id: string, patch: { signIn?: boolean; totp?: boolean }) => void;
  refresh: () => void;
}) {
  const api = internalApi();
  const [search, setSearch] = useState("");
  const [group, setGroup] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const [form, setForm] = useState<{ editing: KeePassEntrySummary | null } | null>(null);
  const unlocked = dbs.filter((d) => d.status === "unlocked");

  // Groups as folders: every group path with how many entries it holds (subgroups included).
  const groups = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of entries) {
      const parts = e.group ? e.group.split(" / ") : [];
      for (let i = 1; i <= parts.length; i++) {
        const p = parts.slice(0, i).join(" / ");
        counts.set(p, (counts.get(p) ?? 0) + 1);
      }
    }
    return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [entries]);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return entries.filter(
      (e) =>
        (group === null || e.group === group || e.group.startsWith(`${group} / `)) &&
        (!q || [e.title, e.username, e.site, e.group].some((v) => v.toLowerCase().includes(q))),
    );
  }, [entries, search, group]);
  useEffect(() => setPage(0), [search, group, entries.length]);
  const slice = shown.slice(page * KP_PAGE, page * KP_PAGE + KP_PAGE);

  if (entries.length === 0 && unlocked.length === 0) return null;
  return (
    <div className="kp-browser">
      <div className="kp-toolbar">
        <input className="input kp-search" placeholder={t("Search KeePass entries")} value={search} onChange={(e) => setSearch(e.target.value)} />
        <span className="grow" />
        {unlocked.length > 0 && (
          <button className="btn small primary" onClick={() => setForm({ editing: null })}>
            <IconPlus size={13} /> {t("New entry")}
          </button>
        )}
      </div>
      <div className="kp-layout">
        <nav className="kp-groups" aria-label={t("Groups")}>
          <button className={group === null ? "active" : ""} onClick={() => setGroup(null)}>
            <IconFolder size={14} /> <span className="grow">{t("All entries")}</span> <span className="kp-count">{entries.length}</span>
          </button>
          {groups.map(([path, count]) => {
            const depth = path.split(" / ").length - 1;
            return (
              <button key={path} className={group === path ? "active" : ""} style={{ paddingLeft: 10 + depth * 14 }} title={path} onClick={() => setGroup(path)}>
                <IconFolder size={14} /> <span className="grow">{path.split(" / ").pop()}</span> <span className="kp-count">{count}</span>
              </button>
            );
          })}
        </nav>
        <div className="kp-list">
          {slice.length === 0 && <div className="pw-hint">{search ? t("No entries match.") : t("No entries in this group.")}</div>}
          {slice.map((e) => {
            const expanded = open === e.id;
            return (
              <div key={e.id} className={`kp-entry ${expanded ? "open" : ""}`}>
                <button className="kp-row" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : e.id)}>
                  {e.site ? <Favicon url={`https://${e.site}`} /> : <IconLock size={15} />}
                  <span className="kp-main">
                    <span className="kp-title">{e.title || e.site || t("(untitled)")}</span>
                    <span className="kp-sub">{e.username || t("(no username)")}</span>
                  </span>
                  <span className="kp-site">{e.site}</span>
                  <span className="kp-chips">
                    {e.hasTotp && <span className="pill">2FA</span>}
                    <AgentChips signIn={e.agentSignIn} totp={e.agentTotp} globalOn={agentAccess} />
                    <HealthChips health={health.get(e.id)} />
                  </span>
                </button>
                <div className="kp-quick">
                  {e.hasTotp && <KeePassTotp id={e.id} />}
                  <button className="icon-btn" title={t("Copy password")} onClick={() => void api.call("keepass.copyPassword", e.id)}>
                    <IconCopy size={15} />
                  </button>
                </div>
                {expanded && (
                  <div className="kp-details">
                    <div className="kp-detail-line muted small">
                      {e.dbName}
                      {e.group ? ` · ${e.group}` : ""}
                    </div>
                    {revealed[e.id] && <div className="pw-reveal">{revealed[e.id]}</div>}
                    <AutoSignInToggle id={e.id} on={autoIds.has(e.id)} onChange={onAutoSignIn} />
                    <div className="pw-gen kp-optins">
                      <label className="pw-opt">
                        <input type="checkbox" checked={e.agentSignIn} onChange={(ev) => optIn(e.id, { signIn: ev.target.checked })} /> {t("Let AI agents sign in with this login")}
                      </label>
                      {e.hasTotp && (
                        <label className="pw-opt">
                          <input type="checkbox" checked={e.agentTotp} onChange={(ev) => optIn(e.id, { totp: ev.target.checked })} /> {t("Let AI agents use this 2FA code")}
                        </label>
                      )}
                    </div>
                    <div className="kp-detail-actions">
                      <button className="btn small ghost" onClick={() => reveal(e.id)}>
                        <IconLock size={13} /> {revealed[e.id] ? t("Hide password") : t("Show password")}
                      </button>
                      <button className="btn small" onClick={() => setForm({ editing: e })}>
                        <IconEdit size={13} /> {t("Edit")}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
          <Pager page={page} size={KP_PAGE} total={shown.length} onPage={setPage} />
        </div>
      </div>
      {form && (
        <KeePassEntryForm
          dbs={unlocked}
          editing={form.editing}
          onClose={() => setForm(null)}
          onSaved={() => {
            setForm(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}

mount(<PasswordsPage />);
