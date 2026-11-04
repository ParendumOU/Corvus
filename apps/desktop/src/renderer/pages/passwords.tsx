import { useCallback, useEffect, useMemo, useState, type CSSProperties, type InputHTMLAttributes, type ReactNode } from "react";
import { ADDRESS_FIELD_KEYS, addressLine, emptyAddressFields, searchAddresses, type AddressFields, type AutofillAddress } from "../../shared/addresses";
import { CARD_FIELD_KEYS, cardExpiry, emptyCardFields, maskedCardNumber, searchCards, type CardFields, type CardSummary } from "../../shared/cards";
import type { CredentialSummary, PasswordOptions } from "../../shared/credentials";
import { DEFAULT_PASSWORD_OPTIONS, generatePassword, searchCredentials } from "../../shared/credentials";
import type { RevealedCredential } from "../../shared/credentials-ipc";
import type { KeePassDbView, KeePassEntryDetails, KeePassEntrySummary, KeePassExportResult, KeePassState, KeePassUnlockResult } from "../../shared/keepass-ipc";
import { daysSince } from "../../shared/backup-reminder";
import { checkupSummary, sortByBreaches, type PasswordCheckupView, type PasswordHealth } from "../../shared/password-health";
import {
  DELETE_ARM_MS,
  deleteTargetOf,
  initialDeleteChoice,
  initialTab,
  keepassEntryChanged,
  PAGE_SIZE,
  pageSlice,
  PASSWORDS_TABS,
  searchTwoFactor,
  sortLogins,
  TAB_STORAGE_KEY,
  tabHash,
  twoFactorItems,
  type DeleteChoice,
  type DeleteTarget,
  type PasswordsTab,
  type TwoFactorItem,
} from "../../shared/password-tabs";
import { formatTotpCode, type TotpCode } from "../../shared/totp";
import { errorMessage, internalApi } from "../common/api";
import { Modal } from "../common/modal";
import { IconAgent, IconCamera, IconCard, IconCheck, IconClock, IconCopy, IconDownload, IconEdit, IconEye, IconEyeOff, IconFile, IconFolder, IconLocation, IconLock, IconPlus, IconSearch, IconTrash } from "../common/icons";
import { Favicon, Pager, Toggle, hostOf } from "../common/ui";
import { AuthenticatorImport } from "./authenticator-import";
import { DeleteLoginDialog } from "./delete-login";
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

/**
 * A field of an edit form that holds a secret (a password, a 2FA secret). With `blur`, its text stays
 * blurred, hard to read on screen or in a screen share, except while the pointer is over the field or
 * it has the focus; Copy copies the value without showing it.
 */
function SecretInput({
  value,
  onChange,
  blur = true,
  className = "",
  ...rest
}: { value: string; onChange: (value: string) => void; blur?: boolean } & Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange">) {
  const api = internalApi();
  const [copied, setCopied] = useState(false);
  const copy = (): void => {
    void api.call("clipboard.write", value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };
  return (
    <span className="pw-secret">
      <input {...rest} className={`${blur ? "pw-blur" : ""} ${className}`.trim()} value={value} onChange={(e) => onChange(e.target.value)} />
      <button type="button" className="icon-btn pw-secret-copy" title={copied ? t("Copied") : t("Copy")} aria-label={copied ? t("Copied") : t("Copy")} disabled={!value} onClick={copy}>
        {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
      </button>
    </span>
  );
}

/** One clock for the countdowns of a list's rows on screen. */
function useClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, []);
  return now;
}

/**
 * The 2FA code cell of a row, the same in the three lists: the current code, fetched from the main
 * process (never the secret) when the row shows and again when its period ends, its countdown and
 * Copy. `load` changes with the login, so a 2FA secret just edited shows its new code at once; rows on
 * other pages are not mounted, so they cost nothing.
 */
function TotpCell({ load, copy, now }: { load: () => Promise<TotpCode | null>; copy: () => Promise<void>; now: number }) {
  const [code, setCode] = useState<TotpCode | null | undefined>(undefined);
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

  if (code === undefined) {
    return (
      <div className="pt-code">
        <span className="tf-code muted">{t("Loading…")}</span>
      </div>
    );
  }
  if (!code) return <div className="pt-code" />;
  const left = Math.max(0, Math.ceil((code.expiresAt - now) / 1000));
  const onCopy = (): void => {
    void copy().then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };
  const copyName = copied ? t("Copied") : t("Copy 2FA code");
  return (
    <div className="pt-code" title={t("Current 2FA code")}>
      <span className="tf-code pw-totp-code">{formatTotpCode(code.code)}</span>
      <span className="tf-left" aria-label={t("{left} seconds left", { left })} title={t("{left} seconds left", { left })}>
        <CountdownRing left={left} period={code.period} />
        <span className="tf-secs">{left}</span>
      </span>
      <button className="btn small ghost pt-copy" title={copyName} aria-label={copyName} onClick={onCopy}>
        {copied ? <IconCheck size={13} /> : <IconCopy size={13} />} <span className="pt-label">{copied ? t("Copied") : t("Copy")}</span>
      </button>
    </div>
  );
}

/** A saved login's code; `version` (its last change) fetches the code again after an edit. */
function VaultTotp({ id, version, now }: { id: string; version: number; now: number }) {
  const api = internalApi();
  const load = useCallback(() => api.call("credentials.totpCode", id) as Promise<TotpCode | null>, [api, id, version]);
  const copy = useCallback(() => api.call("credentials.copyTotp", id) as Promise<void>, [api, id]);
  return <TotpCell load={load} copy={copy} now={now} />;
}

/** A KeePass entry's code; `version` (its summary, new after each reload) fetches it again after an edit. */
function KeePassTotp({ id, version, now }: { id: string; version: object; now: number }) {
  const api = internalApi();
  const load = useCallback(() => api.call("keepass.totpCode", id) as Promise<TotpCode | null>, [api, id, version]);
  const copy = useCallback(() => api.call("keepass.copyTotp", id) as Promise<void>, [api, id]);
  return <TotpCell load={load} copy={copy} now={now} />;
}

/** The first column of a row: the site's icon, or a lock for an entry without an address. */
function RowIcon({ url }: { url: string }) {
  return <span className="pt-icon">{url ? <Favicon url={url} /> : <IconLock size={15} />}</span>;
}

/**
 * The name column: the site (or entry title) and the username, each cut with an ellipsis and shown
 * in full on hover; `children` adds a line under them (where a KeePass entry is, a revealed password).
 */
function NameCell({ primary, secondary, primaryClass = "", children }: { primary: string; secondary: string; primaryClass?: string; children?: ReactNode }) {
  return (
    <div className="pt-name">
      <span className={`pt-primary ${primaryClass}`.trim()} title={primary}>
        {primary}
      </span>
      <span className="pt-secondary" title={secondary}>
        {secondary}
      </span>
      {children}
    </div>
  );
}

/** A row action: icon and word on a wide list, the icon alone (named by `name`, aria-label, and `title`, its tooltip) on a narrow one. */
function RowAction({ icon, label, name = label, title = name, className = "", disabled, onClick }: { icon: ReactNode; label: string; name?: string; title?: string; className?: string; disabled?: boolean; onClick: () => void }) {
  return (
    <button className={`btn small ghost pt-act ${className}`.trim()} title={title} aria-label={name} disabled={disabled} onClick={onClick}>
      {icon} <span className="pt-label">{label}</span>
    </button>
  );
}

/** The light header row naming a table's columns (hidden when the rows fold onto two lines). */
function TableHead({ name, options }: { name: string; options?: boolean }) {
  return (
    <div className="pt-head" aria-hidden="true">
      <span />
      <span>{name}</span>
      <span>{t("Status")}</span>
      <span>{t("2FA code")}</span>
      {/* A non-breaking hyphen: the narrow header breaks between the words, not inside "sign-in". */}
      {options && <span className="pt-head-option">{t("Auto sign-in").replace("-", "\u2011")}</span>}
      <span className="pt-head-actions">{t("Actions")}</span>
    </div>
  );
}

/** "AI: sign-in" / "AI: 2FA" chips for logins an agent may use. */
function AgentChips({ signIn, totp, globalOn }: { signIn: boolean; totp: boolean; globalOn: boolean }) {
  if (!signIn && !totp) return null;
  const title = globalOn ? t("AI agents may use this after asking you") : t("Opted in, but AI agent use is off in Settings");
  return (
    <span className={`pw-agent ${globalOn ? "" : "off"}`} title={title}>
      <IconAgent size={12} />
      {[signIn ? t("sign-in") : "", totp ? "2FA" : ""].filter(Boolean).join(" + ")}
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
        <span className="pw-health danger" title={t("This password appears in known data breaches: change it on the site, then here")}>{breaches === 1 ? t("In 1 breach") : t("In {n} breaches", { n: breaches.toLocaleString() })}
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

/** When the last backup was made ("" while it is loading). */
function lastBackupText(at: number | null | undefined): string {
  if (at === undefined) return "";
  if (at === null) return t("Never backed up");
  const days = daysSince(at, Date.now());
  return days === 0 ? t("Last backup: today") : days === 1 ? t("Last backup: yesterday") : t("Last backup: {n} days ago", { n: days });
}

/** "Back up now", with when the last backup was made as its tooltip (the header's buttons stay one row). */
function BackupButton({ lastBackupAt, onClick }: { lastBackupAt: number | null | undefined; onClick: () => void }) {
  return (
    <button className="btn" title={lastBackupText(lastBackupAt) || undefined} onClick={onClick}>
      <IconDownload size={14} /> {t("Back up now")}
    </button>
  );
}

function readStoredTab(): string | null {
  try {
    return localStorage.getItem(TAB_STORAGE_KEY);
  } catch {
    return null;
  }
}

function storeTab(tab: PasswordsTab): void {
  try {
    localStorage.setItem(TAB_STORAGE_KEY, tab);
  } catch {
    // Storage off (private mode, blocked): the tab is still in the address.
  }
}

/** "Passwords", "2FA codes", "Addresses" and "Payment methods", with how many each holds; arrow keys move between them. */
function TabBar({ tab, counts, onTab }: { tab: PasswordsTab; counts: Record<PasswordsTab, number>; onTab: (tab: PasswordsTab) => void }) {
  const tabs: Array<[PasswordsTab, string]> = [
    ["passwords", t("Passwords")],
    ["2fa", t("2FA codes")],
    ["addresses", t("Addresses")],
    ["cards", t("Payment methods")],
  ];
  return (
    <div
      className="pw-tabs"
      role="tablist"
      aria-label={t("Passwords")}
      onKeyDown={(e) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        e.preventDefault();
        const at = PASSWORDS_TABS.indexOf(tab) + (e.key === "ArrowRight" ? 1 : -1);
        const next = PASSWORDS_TABS[(at + PASSWORDS_TABS.length) % PASSWORDS_TABS.length]!;
        onTab(next);
        document.getElementById(`pw-tab-${next}`)?.focus();
      }}
    >
      {tabs.map(([id, label]) => (
        <button
          key={id}
          id={`pw-tab-${id}`}
          role="tab"
          aria-selected={tab === id}
          aria-controls="pw-panel"
          tabIndex={tab === id ? 0 : -1}
          className={`pw-tab ${tab === id ? "on" : ""}`}
          onClick={() => onTab(id)}
        >
          {label} <span className="pw-tab-count">{counts[id]}</span>
        </button>
      ))}
    </div>
  );
}

/** A ring that empties as the code's period runs out. */
function CountdownRing({ left, period }: { left: number; period: number }) {
  const r = 8;
  const around = 2 * Math.PI * r;
  return (
    <svg className={`tf-ring ${left <= 5 ? "low" : ""}`} width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
      <circle className="tf-ring-track" cx="10" cy="10" r={r} />
      <circle className="tf-ring-left" cx="10" cy="10" r={r} strokeDasharray={around} strokeDashoffset={around * (1 - left / period)} />
    </svg>
  );
}

/** A row's code in the 2FA codes tab, from the vault or a KeePass database; every reload of the list gives new items, so an edited secret shows its code at once. */
function TwoFactorCode({ item, now }: { item: TwoFactorItem; now: number }) {
  const api = internalApi();
  const load = useCallback(() => (item.source === "keepass" ? api.call("keepass.totpCode", item.id) : api.call("credentials.totpCode", item.id)) as Promise<TotpCode | null>, [api, item]);
  const copy = useCallback(() => (item.source === "keepass" ? api.call("keepass.copyTotp", item.id) : api.call("credentials.copyTotp", item.id)) as Promise<void>, [api, item]);
  return <TotpCell load={load} copy={copy} now={now} />;
}

/** "KeePass: <database>" for a row from a KeePass database, cut with an ellipsis. */
function SourcePill({ name }: { name: string }) {
  const text = name ? `KeePass: ${name}` : "KeePass";
  return (
    <span className="pill pt-pill" title={text}>
      {text}
    </span>
  );
}

/**
 * Every login with a 2FA (the vault, and unlocked KeePass databases), a page at a time, in the same
 * columns as the logins: the site and username, its status, the current code, Show login, Edit and
 * Delete. One clock drives the countdowns of the rows on screen. Edit and Delete open over the list,
 * which keeps its page.
 */
function TwoFactorTab({
  items,
  query,
  onShow,
  onEdit,
  onDelete,
  onImport,
}: {
  items: TwoFactorItem[];
  query: string;
  onShow: (item: TwoFactorItem) => void;
  onEdit: (item: TwoFactorItem) => void;
  onDelete: (item: TwoFactorItem) => void;
  onImport: () => void;
}) {
  const [page, setPage] = useState(0);
  const now = useClock();
  const shown = useMemo(() => searchTwoFactor(items, query), [items, query]);
  const slice = pageSlice(shown, page);
  useEffect(() => setPage(0), [query]);

  return (
    <div className="card tf-card">
      <div className="card-head tf-head">
        <p className="muted">{t("The current code of every login with 2FA. Corvus also fills it on the site when it asks for the code.")}</p>
        <button className="btn small" onClick={onImport}>
          <IconCamera size={13} /> {t("Import from Google Authenticator")}
        </button>
      </div>
      {items.length === 0 ? (
        <div className="empty tf-empty">
          {t("No 2FA codes yet. Add one to a login (Edit, then 2FA), or import your accounts from Google Authenticator.")}
        </div>
      ) : shown.length === 0 ? (
        <div className="empty">{t("No 2FA codes match your search.")}</div>
      ) : (
        <div className="pt-wrap tf-list">
          <div className="pt pt-2fa">
            <TableHead name={t("Site and username")} />
            {slice.items.map((item) => (
              <div key={item.id} className="pt-row tf-row" data-id={item.id}>
                <RowIcon url={item.url} />
                <NameCell primary={item.site || item.title || t("(no site)")} primaryClass="tf-host" secondary={item.username || t("(no username)")} />
                <div className="pt-meta">
                  <div className="pt-status">
                    {!item.hasPassword && <span className="pill">{t("2FA only")}</span>}
                    {item.source === "keepass" && <SourcePill name={item.sourceName} />}
                  </div>
                  <TwoFactorCode item={item} now={now} />
                </div>
                <div className="pt-actions">
                  <RowAction className="tf-show" icon={<IconSearch size={13} />} label={t("Show login")} title={t("Show this login in the Passwords tab")} onClick={() => onShow(item)} />
                  <RowAction className="tf-edit" icon={<IconEdit size={13} />} label={t("Edit")} title={t("Change the site, the username or the 2FA secret")} onClick={() => onEdit(item)} />
                  <RowAction className="tf-delete" icon={<IconTrash size={13} />} label={t("Delete")} title={t("Delete this login, or only its 2FA")} onClick={() => onDelete(item)} />
                </div>
              </div>
            ))}
            <Pager page={slice.page} size={PAGE_SIZE} total={shown.length} onPage={setPage} />
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The fields of the vault's login form, in the Passwords tab's card or over the 2FA codes tab. The
 * password and the 2FA secret stay blurred until pointed at or focused.
 */
function LoginFields({
  form,
  set,
  options,
  setOptions,
  agentAccess,
  qrError,
  onImportQr,
}: {
  form: FormState;
  set: (patch: Partial<FormState>) => void;
  options: PasswordOptions;
  setOptions: (update: (o: PasswordOptions) => PasswordOptions) => void;
  agentAccess: boolean;
  qrError: string | null;
  onImportQr: () => void;
}) {
  const api = internalApi();
  const hasTotp = Boolean(form.totp.trim());
  const toggle = (key: keyof PasswordOptions): void => setOptions((o) => ({ ...o, [key]: !o[key] }));
  const generate = (): void => void api.call("credentials.generate", options).then((pw) => set({ password: pw }));
  return (
    <>
      <label className="pw-field">
        <span>{t("Site")}</span>
        <input className="input pw-origin" placeholder={t("https://example.com")} value={form.origin} onChange={(e) => set({ origin: e.target.value })} />
      </label>
      <label className="pw-field">
        <span>{t("Username")}</span>
        <input className="input pw-username" autoComplete="off" value={form.username} onChange={(e) => set({ username: e.target.value })} />
      </label>
      <label className="pw-field">
        <span>{t("Password")}</span>
        <SecretInput className="pw-password" type="text" autoComplete="off" spellCheck={false} value={form.password} onChange={(password) => set({ password })} />
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
          <SecretInput
            className="pw-totp-input"
            autoComplete="off"
            spellCheck={false}
            placeholder={t("Paste an otpauth:// link or the base32 secret")}
            value={form.totp}
            onChange={(totp) => set({ totp })}
          />
        )}
        <div className="pw-gen">
          <button className="btn small" onClick={onImportQr}>{t("Import QR code image")}</button>
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
    </>
  );
}

function PasswordsPage() {
  const api = internalApi();
  const [checkup, setCheckup] = useState<PasswordCheckupView | null>(null);
  const reloadCheckup = useCallback(() => void api.call("credentials.checkup").then(setCheckup), [api]);
  // The breach check also sorts the logins, most breached first.
  const [byBreaches, setByBreaches] = useState(false);
  const runCheckup = (): void => {
    setByBreaches(true);
    setPage(0);
    setCheckup((c) => (c ? { ...c, running: true } : c));
    void api.call("credentials.runCheckup").then(setCheckup, reloadCheckup);
  };
  useEffect(() => {
    reloadCheckup();
    return api.onEvent((e) => (e.type === "credentials-changed" || e.type === "keepass-changed") && reloadCheckup());
  }, [api, reloadCheckup]);
  const health = useMemo(() => new Map((checkup?.items ?? []).map((h) => [h.id, h])), [checkup]);
  const [tab, setTab] = useState<PasswordsTab>(() => initialTab(location.hash, readStoredTab()));
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [allItems, setAllItems] = useState<CredentialSummary[]>([]);
  const [keepassItems, setKeepassItems] = useState<KeePassEntrySummary[]>([]);
  const [persisted, setPersisted] = useState(true);
  const [agentAccess, setAgentAccess] = useState(false);
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [form, setForm] = useState<FormState | null>(null);
  const [options, setOptions] = useState<PasswordOptions>(DEFAULT_PASSWORD_OPTIONS);
  const [error, setError] = useState<string | null>(null);
  const [qrError, setQrError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [backingUp, setBackingUp] = useState(() => location.hash === "#backup");
  const [lastBackupAt, setLastBackupAt] = useState<number | null | undefined>(undefined);
  const loadBackup = useCallback(() => void api.call("credentials.backupState").then((s) => setLastBackupAt(s.lastBackupAt)), [api]);
  const [autoIds, setAutoIds] = useState<Set<string>>(new Set());
  const setAutoSignIn = useCallback(
    (id: string, on: boolean) => void api.call("credentials.setAutoSignIn", id, on).then((ids) => setAutoIds(new Set(ids))),
    [api],
  );

  const load = useCallback(() => void api.call("credentials.list", "").then(setAllItems), [api]);
  const [addresses, setAddresses] = useState<AutofillAddress[]>([]);
  const [addressForm, setAddressForm] = useState<AddressFormState | null>(null);
  const [deletingAddress, setDeletingAddress] = useState<AutofillAddress | null>(null);
  const loadAddresses = useCallback(() => void api.call("addresses.list").then(setAddresses), [api]);
  const closeAddressForm = useCallback(() => setAddressForm(null), []);
  const closeDeleteAddress = useCallback(() => setDeletingAddress(null), []);
  const [cards, setCards] = useState<CardSummary[]>([]);
  const [cardForm, setCardForm] = useState<CardFormState | null>(null);
  const [deletingCard, setDeletingCard] = useState<CardSummary | null>(null);
  const loadCards = useCallback(() => void api.call("cards.list").then(setCards), [api]);
  const closeCardForm = useCallback(() => setCardForm(null), []);
  const closeDeleteCard = useCallback(() => setDeletingCard(null), []);
  const loadKeePass = useCallback(() => void api.call("keepass.entries", "").then(setKeepassItems), [api]);

  useEffect(() => {
    void api.call("credentials.persisted").then(setPersisted);
    void api.call("credentials.agentAccess").then(setAgentAccess);
    void api.call("credentials.autoSignInIds").then((ids) => setAutoIds(new Set(ids)));
    load();
    loadKeePass();
    loadBackup();
    loadAddresses();
    loadCards();
    return api.onEvent((e) => {
      if (e.type === "credentials-changed") load();
      if (e.type === "keepass-changed") loadKeePass();
    });
  }, [api, load, loadKeePass, loadBackup, loadAddresses, loadCards]);

  const chooseTab = useCallback((next: PasswordsTab) => {
    setTab(next);
    storeTab(next);
    history.replaceState(null, "", tabHash(next));
  }, []);
  // A link to the page with another tab (corvus://passwords/#2fa), or to the backup (#backup), while it is open.
  useEffect(() => {
    const onHash = (): void => {
      setTab(initialTab(location.hash, readStoredTab()));
      if (location.hash !== "#backup") return;
      setBackingUp(true);
      loadBackup();
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [loadBackup]);

  const items = useMemo(() => {
    const found = sortLogins(searchCredentials(allItems, query));
    return byBreaches ? sortByBreaches(found, health) : found;
  }, [allItems, query, byBreaches, health]);
  useEffect(() => setPage(0), [query]);
  const twoFactor = useMemo(() => twoFactorItems(allItems, keepassItems), [allItems, keepassItems]);
  const counts: Record<PasswordsTab, number> = { passwords: allItems.length + keepassItems.length, "2fa": twoFactor.length, addresses: addresses.length, cards: cards.length };

  const showLogin = (item: TwoFactorItem): void => {
    setQuery(item.site || item.username);
    chooseTab("passwords");
    window.scrollTo(0, 0);
  };

  const openBackup = (): void => {
    setImporting(false);
    setForm(null);
    setBackingUp(true);
    loadBackup();
    window.scrollTo(0, 0);
  };

  const startImport = (): void => {
    setBackingUp(false);
    setForm(null);
    setImporting(true);
  };

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

  const openEdit = async (id: string): Promise<void> => {
    if (!window.confirm(t("Edit this login? Its password and 2FA secret will be shown in the form."))) return;
    const cred = (await api.call("credentials.reveal", id)) as RevealedCredential;
    setError(null);
    setQrError(null);
    setForm({
      id,
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
  // Stable, so the dialogs over the page keep the focus where the person put it.
  const closeForm = useCallback(() => setForm(null), []);

  // From the 2FA codes tab: the vault's form or the KeePass entry form, over the list.
  const [keepassEditing, setKeepassEditing] = useState<KeePassEntrySummary | null>(null);
  const closeKeepassEdit = useCallback(() => setKeepassEditing(null), []);
  const editTwoFactor = (item: TwoFactorItem): void => {
    if (item.source === "keepass") setKeepassEditing(keepassItems.find((e) => e.id === item.id) ?? null);
    else void openEdit(item.id);
  };

  const [deleting, setDeleting] = useState<{ target: DeleteTarget; initial: DeleteChoice } | null>(null);
  const closeDelete = useCallback(() => setDeleting(null), []);
  const askDelete = (target: DeleteTarget): void => setDeleting({ target, initial: initialDeleteChoice(target, tab) });

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
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const set = (patch: Partial<FormState>): void => setForm((f) => (f ? { ...f, ...patch } : f));
  const anyTotp = twoFactor.length > 0;
  const fields = form && <LoginFields form={form} set={set} options={options} setOptions={setOptions} agentAccess={agentAccess} qrError={qrError} onImportQr={() => void importQr()} />;

  return (
    <PageShell
      title={t("Passwords")}
      active="passwords"
      toolbar={
        <>
          <input className="input" placeholder={tab === "2fa" ? t("Search 2FA codes") : tab === "addresses" ? t("Search addresses") : tab === "cards" ? t("Search payment methods") : t("Search logins")} value={query} onChange={(e) => setQuery(e.target.value)} />
          <button className="btn" title={t("Import from Google Authenticator")} onClick={startImport}>
            <IconCamera size={14} />{" "}<span className="pw-ga-label">{t("Import from Google Authenticator")}</span></button>
          <BackupButton lastBackupAt={lastBackupAt} onClick={openBackup} />
          <button className="btn primary" onClick={() => {
            if (tab === "addresses") {
              setAddressForm({ id: null, fields: emptyAddressFields() });
              return;
            }
            if (tab === "cards") {
              setCardForm({ id: null, fields: emptyCardFields(), masked: "" });
              return;
            }
            setError(null);
            setQrError(null);
            setImporting(false);
            setForm(EMPTY_FORM);
            chooseTab("passwords");
          }}>
            <IconPlus size={14} />{" "}{t("Add")}</button>
        </>
      }
    >
      <TabBar tab={tab} counts={counts} onTab={chooseTab} />

      {!persisted && (
        <div className="card">
          <div className="pw-warn">{t("No system keychain is available, so saved logins are kept in memory for this session only and are not written to disk.")}</div>
        </div>
      )}

      {importing && <AuthenticatorImport onClose={() => setImporting(false)} onImported={load} onBackup={openBackup} />}

      {backingUp && (
        <div className="card pw-backup-card" id="backup">
          <div className="card-head">
            <h2>{t("Back up your passwords and 2FA codes")}</h2>
            {lastBackupAt !== undefined && <p className="pw-backup-when">{lastBackupText(lastBackupAt)}</p>}
            <p className="muted">{t("Corvus writes every saved login, with its 2FA, to a new KeePass file (.kdbx) protected by a master password you choose, and never overwrites a file. Keep it somewhere other than this computer, such as a USB drive or a cloud folder: KeePassXC, KeePass and Corvus can open it.")}</p>
          </div>
          <div className="card-body padded">
            <ExportForm onClose={() => setBackingUp(false)} onDone={loadBackup} />
          </div>
        </div>
      )}

      <div id="pw-panel" role="tabpanel" aria-labelledby={`pw-tab-${tab}`} className="pw-panel">
        {tab === "2fa" && (
          <>
            {anyTotp && !importing && (
              <div className="card">
                <div className="pw-warn">{TWO_FACTOR_WARNING}</div>
              </div>
            )}
            <TwoFactorTab
              items={twoFactor}
              query={query}
              onShow={showLogin}
              onEdit={editTwoFactor}
              onDelete={(item) => askDelete(deleteTargetOf.twoFactor(item))}
              onImport={startImport}
            />
          </>
        )}

        {tab === "2fa" && form && (
          <Modal
            wide
            title={form.id ? t("Edit login") : t("Add login")}
            onClose={closeForm}
            footer={
              <>
                <button className="btn" onClick={closeForm}>{t("Cancel")}</button>
                <button className="btn primary" onClick={submit}>{t("Save")}</button>
              </>
            }
          >
            <div className="pw-form">
              {fields}
              {error && <div className="pw-error">{error}</div>}
            </div>
          </Modal>
        )}

        {tab === "passwords" && form && (
          <div className="card">
            <div className="card-head">
              <h2>{form.id ? t("Edit login") : t("Add login")}</h2>
            </div>
            <div className="card-body padded pw-form">
              {fields}
              {error && <div className="pw-error">{error}</div>}
              <div className="pw-actions">
                <button className="btn primary" onClick={submit}>{t("Save")}</button>
                <button className="btn ghost" onClick={closeForm}>{t("Cancel")}</button>
              </div>
            </div>
          </div>
        )}

        {tab === "passwords" && !form && !importing && <CheckupCard view={checkup} onRun={runCheckup} />}

        {tab === "passwords" && anyTotp && !form && !importing && (
          <div className="card">
            <div className="pw-warn">{TWO_FACTOR_WARNING}</div>
          </div>
        )}

        {tab === "passwords" && (
          <div className="card">
            {items.length === 0 ? (
              <div className="empty">{query ? t("No logins match your search.") : t("No saved logins yet. Sign in to a site or add one with the Add button.")}</div>
            ) : (
              <VaultTable
                items={items}
                page={page}
                onPage={setPage}
                health={health}
                agentAccess={agentAccess}
                autoIds={autoIds}
                onAutoSignIn={setAutoSignIn}
                revealed={revealed}
                onReveal={(id) => void reveal(id)}
                onCopy={(id) => void copyPassword(id)}
                onEdit={(id) => void openEdit(id)}
                onDelete={(item) => askDelete(deleteTargetOf.login(item))}
              />
            )}
          </div>
        )}

        {tab === "addresses" && addressForm && (
          <AddressFormCard
            key={addressForm.id ?? "new"}
            initial={addressForm}
            onClose={closeAddressForm}
            onSaved={() => {
              setAddressForm(null);
              loadAddresses();
            }}
          />
        )}

        {tab === "addresses" && (
          <AddressesTab
            items={addresses}
            query={query}
            onEdit={(a) => {
              setAddressForm({ id: a.id, fields: pickAddressFields(a) });
              window.scrollTo(0, 0);
            }}
            onDelete={setDeletingAddress}
          />
        )}

        {tab === "cards" && cardForm && (
          <CardFormCard
            key={cardForm.id ?? "new"}
            initial={cardForm}
            onClose={closeCardForm}
            onSaved={() => {
              setCardForm(null);
              loadCards();
            }}
          />
        )}

        {tab === "cards" && (
          <CardsTab
            items={cards}
            query={query}
            onEdit={(c) => {
              setCardForm({ id: c.id, fields: { label: c.label, nameOnCard: c.nameOnCard, number: "", expMonth: c.expMonth, expYear: c.expYear }, masked: maskedCardNumber(c.last4) });
              window.scrollTo(0, 0);
            }}
            onDelete={setDeletingCard}
          />
        )}

        {tab === "passwords" && (
          <KeePassSection
            query={query}
            agentAccess={agentAccess}
            autoIds={autoIds}
            onAutoSignIn={setAutoSignIn}
            health={health}
            byBreaches={byBreaches}
            onExport={openBackup}
            onDelete={(entry) => askDelete(deleteTargetOf.keepass(entry))}
          />
        )}
      </div>

      {keepassEditing && <KeePassEntryForm dbs={[]} editing={keepassEditing} agentAccess={agentAccess} onClose={closeKeepassEdit} onSaved={closeKeepassEdit} />}
      {deleting && (
        <DeleteLoginDialog
          target={deleting.target}
          initial={deleting.initial}
          onClose={closeDelete}
          onDone={() => {
            setDeleting(null);
            load();
          }}
        />
      )}
      {deletingAddress && (
        <DeleteAddressDialog
          address={deletingAddress}
          onClose={closeDeleteAddress}
          onDone={() => {
            setDeletingAddress(null);
            loadAddresses();
          }}
        />
      )}
      {deletingCard && (
        <DeleteCardDialog
          card={deletingCard}
          onClose={closeDeleteCard}
          onDone={() => {
            setDeletingCard(null);
            loadCards();
          }}
        />
      )}
    </PageShell>
  );
}

interface AddressFormState {
  id: string | null;
  fields: AddressFields;
}

const pickAddressFields = (a: AutofillAddress): AddressFields => Object.fromEntries(ADDRESS_FIELD_KEYS.map((k) => [k, a[k]])) as AddressFields;

/** How a saved address names itself in lists and in the delete confirmation: its phone and email under its name and place. */
const addressContact = (a: AutofillAddress): string => [a.phone, a.email].filter(Boolean).join(" \u00b7 ");

/** The saved addresses autofill offers on address forms, a page at a time, with Edit and Delete. */
function AddressesTab({ items, query, onEdit, onDelete }: { items: AutofillAddress[]; query: string; onEdit: (a: AutofillAddress) => void; onDelete: (a: AutofillAddress) => void }) {
  const [page, setPage] = useState(0);
  const shown = useMemo(() => searchAddresses(items, query), [items, query]);
  const slice = pageSlice(shown, page);
  useEffect(() => setPage(0), [query]);

  return (
    <div className="card ad-card">
      <div className="card-head">
        <p className="muted">{t("Corvus fills these into address forms on sites.")}</p>
      </div>
      {items.length === 0 ? (
        <div className="empty">{t("No saved addresses yet. Add one with the Add button.")}</div>
      ) : shown.length === 0 ? (
        <div className="empty">{t("No addresses match your search.")}</div>
      ) : (
        <div className="pt-wrap ad-list">
          <div className="pt pt-addresses">
            <div className="pt-head" aria-hidden="true">
              <span />
              <span>{t("Address")}</span>
              <span className="pt-head-actions">{t("Actions")}</span>
            </div>
            {slice.items.map((a) => (
              <div key={a.id} className="pt-row ad-row" data-id={a.id}>
                <span className="pt-icon">
                  <IconLocation size={15} />
                </span>
                <NameCell primary={addressLine(a)} secondary={addressContact(a)} />
                <div className="pt-actions">
                  <RowAction className="ad-edit" icon={<IconEdit size={13} />} label={t("Edit")} title={t("Change this address")} onClick={() => onEdit(a)} />
                  <RowAction className="ad-delete" icon={<IconTrash size={13} />} label={t("Delete")} title={t("Delete this address")} onClick={() => onDelete(a)} />
                </div>
              </div>
            ))}
            <Pager page={slice.page} size={PAGE_SIZE} total={shown.length} onPage={setPage} />
          </div>
        </div>
      )}
    </div>
  );
}

const addressLabel = (key: keyof AddressFields): string =>
  ({
    label: t("Label"),
    name: t("Full name"),
    givenName: t("First name"),
    familyName: t("Last name"),
    company: t("Company"),
    street: t("Street address"),
    postalCode: t("Postal code"),
    city: t("City"),
    region: t("Province or region"),
    country: t("Country code"),
    phone: t("Phone"),
    email: t("Email"),
  })[key];

/** Adding or changing a saved address, in a card over the list like the login form. */
function AddressFormCard({ initial, onClose, onSaved }: { initial: AddressFormState; onClose: () => void; onSaved: () => void }) {
  const api = internalApi();
  const [fields, setFields] = useState<AddressFields>(initial.fields);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (key: keyof AddressFields, value: string): void => setFields((f) => ({ ...f, [key]: value }));

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const saved = await api.call("addresses.save", initial.id ? { id: initial.id, fields } : { fields });
      if (saved) onSaved();
      else setError(t("An address needs a name, street, postal code, phone or email."));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card ad-form-card">
      <div className="card-head">
        <h2>{initial.id ? t("Edit address") : t("Add address")}</h2>
      </div>
      <div className="card-body padded pw-form">
        <div className="kp-form-grid ad-form">
          {ADDRESS_FIELD_KEYS.map((key) => (
            <label key={key} className={`pw-field ad-field-${key}${key === "street" || key === "label" ? " kp-wide" : ""}`}>
              <span>{addressLabel(key)}</span>
              {key === "street" ? (
                <textarea className="input pw-notes" rows={3} value={fields.street} onChange={(e) => set("street", e.target.value)} />
              ) : (
                <input
                  className="input"
                  type={key === "email" ? "email" : key === "phone" ? "tel" : "text"}
                  maxLength={key === "country" ? 2 : 500}
                  placeholder={key === "country" ? "ES" : undefined}
                  value={fields[key]}
                  onChange={(e) => set(key, key === "country" ? e.target.value.toUpperCase() : e.target.value)}
                />
              )}
            </label>
          ))}
        </div>
        {error && <div className="pw-error">{error}</div>}
        <div className="pw-actions">
          <button className="btn primary" disabled={busy} onClick={() => void submit()}>{t("Save")}</button>
          <button className="btn ghost" onClick={onClose}>{t("Cancel")}</button>
        </div>
      </div>
    </div>
  );
}

/** Deleting a saved address asks first; the red button stays off for a moment so a double click cannot reach it. */
function DeleteAddressDialog({ address, onClose, onDone }: { address: AutofillAddress; onClose: () => void; onDone: () => void }) {
  const api = internalApi();
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => setArmed(true), DELETE_ARM_MS);
    return () => clearTimeout(timer);
  }, []);

  const run = (): void => {
    setBusy(true);
    setError(null);
    api.call("addresses.remove", address.id).then(onDone, (err: unknown) => {
      setError(errorMessage(err));
      setBusy(false);
    });
  };

  return (
    <Modal
      title={t("Delete this address?")}
      onClose={onClose}
      footer={
        <>
          <button className="btn" autoFocus onClick={onClose}>
            {t("Cancel")}
          </button>
          <button className="btn danger-solid ad-confirm" disabled={!armed || busy} onClick={run}>
            {busy ? t("Deleting…") : t("Delete for good")}
          </button>
        </>
      }
    >
      <div className="dl-login">
        <IconLocation size={15} />
        <div className="dl-login-main">
          <strong className="dl-site">{addressLine(address)}</strong>
          <span className="dl-user">{addressContact(address)}</span>
        </div>
      </div>
      <p className="dl-text">{t("Corvus no longer offers it on address forms. This cannot be undone.")}</p>
      <p className="dl-text">{t("With sync on, the address is removed from your other devices too.")}</p>
      {error && <div className="pw-error">{error}</div>}
    </Modal>
  );
}

interface CardFormState {
  id: string | null;
  /** The card's fields; an edit starts with an empty number, which keeps the saved one. */
  fields: CardFields;
  /** The saved number, masked, shown as the number field's hint on an edit. */
  masked: string;
}

const summaryTitle = (c: CardSummary): string => `${c.brand} ...${c.last4}`;
const summaryLine = (c: CardSummary): string => [summaryTitle(c), cardExpiry(c)].filter(Boolean).join(" - ");

/** The saved payment cards autofill offers on card forms, a page at a time; the number shows only after a confirmation. */
function CardsTab({ items, query, onEdit, onDelete }: { items: CardSummary[]; query: string; onEdit: (c: CardSummary) => void; onDelete: (c: CardSummary) => void }) {
  const api = internalApi();
  const [page, setPage] = useState(0);
  const [asking, setAsking] = useState<CardSummary | null>(null);
  const [shown, setShown] = useState<{ id: string; number: string } | null>(null);
  const found = useMemo(() => searchCards(items, query), [items, query]);
  const slice = pageSlice(found, page);
  useEffect(() => setPage(0), [query]);
  useEffect(() => setShown(null), [items]);

  const reveal = (c: CardSummary): void => {
    setAsking(null);
    void api.call("cards.reveal", c.id).then((number) => setShown({ id: c.id, number }), () => setShown(null));
  };

  return (
    <div className="card ad-card cd-card">
      <div className="card-head">
        <p className="muted">{t("Corvus fills these into card forms on sites, after you type the CVV. It never saves the CVV.")}</p>
      </div>
      {items.length === 0 ? (
        <div className="empty">{t("No saved payment methods yet. Add one with the Add button.")}</div>
      ) : found.length === 0 ? (
        <div className="empty">{t("No payment methods match your search.")}</div>
      ) : (
        <div className="pt-wrap ad-list">
          <div className="pt pt-addresses">
            <div className="pt-head" aria-hidden="true">
              <span />
              <span>{t("Card")}</span>
              <span className="pt-head-actions">{t("Actions")}</span>
            </div>
            {slice.items.map((c) => {
              const open = shown?.id === c.id;
              const number = open ? shown.number.replace(/(\d{4})(?=\d)/g, "$1 ") : maskedCardNumber(c.last4);
              return (
                <div key={c.id} className="pt-row ad-row cd-row" data-id={c.id}>
                  <span className="pt-icon">
                    <IconCard size={15} />
                  </span>
                  <NameCell primary={c.label ? `${c.label} - ${summaryLine(c)}` : summaryLine(c)} secondary={[number, c.nameOnCard].filter(Boolean).join(" · ")} />
                  <div className="pt-actions">
                    {open ? (
                      <RowAction className="cd-hide" icon={<IconEyeOff size={13} />} label={t("Hide")} title={t("Hide the card number")} onClick={() => setShown(null)} />
                    ) : (
                      <RowAction className="cd-reveal" icon={<IconEye size={13} />} label={t("Show")} title={t("Show the card number")} onClick={() => setAsking(c)} />
                    )}
                    <RowAction className="cd-edit" icon={<IconEdit size={13} />} label={t("Edit")} title={t("Change this card")} onClick={() => onEdit(c)} />
                    <RowAction className="cd-delete" icon={<IconTrash size={13} />} label={t("Delete")} title={t("Delete this card")} onClick={() => onDelete(c)} />
                  </div>
                </div>
              );
            })}
            <Pager page={slice.page} size={PAGE_SIZE} total={found.length} onPage={setPage} />
          </div>
        </div>
      )}
      {asking && (
        <Modal
          title={t("Show the card number?")}
          onClose={() => setAsking(null)}
          footer={
            <>
              <button className="btn" autoFocus onClick={() => setAsking(null)}>
                {t("Cancel")}
              </button>
              <button className="btn primary cd-reveal-confirm" onClick={() => reveal(asking)}>
                {t("Show")}
              </button>
            </>
          }
        >
          <p className="dl-text">{t("The full number of {card} shows on screen until you hide it or leave the page.", { card: summaryTitle(asking) })}</p>
        </Modal>
      )}
    </div>
  );
}

const cardLabel = (key: keyof CardFields): string =>
  ({
    label: t("Label"),
    nameOnCard: t("Name on card"),
    number: t("Card number"),
    expMonth: t("Expiry month"),
    expYear: t("Expiry year"),
  })[key];

/** Adding or changing a saved card (never its CVV), in a card over the list like the address form. */
function CardFormCard({ initial, onClose, onSaved }: { initial: CardFormState; onClose: () => void; onSaved: () => void }) {
  const api = internalApi();
  const [fields, setFields] = useState<CardFields>(initial.fields);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (key: keyof CardFields, value: string): void => setFields((f) => ({ ...f, [key]: value }));

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await api.call("cards.save", initial.id ? { id: initial.id, fields } : { fields });
      onSaved();
    } catch {
      setError(t("Check the card number: it is not a valid card number."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card ad-form-card cd-form-card">
      <div className="card-head">
        <h2>{initial.id ? t("Edit card") : t("Add card")}</h2>
      </div>
      <div className="card-body padded pw-form">
        <div className="kp-form-grid ad-form">
          {CARD_FIELD_KEYS.map((key) => (
            <label key={key} className={`pw-field cd-field-${key}${key === "label" || key === "number" ? " kp-wide" : ""}`}>
              <span>{cardLabel(key)}</span>
              <input
                className="input"
                type="text"
                inputMode={key === "label" || key === "nameOnCard" ? "text" : "numeric"}
                autoComplete="off"
                maxLength={key === "expMonth" ? 2 : key === "expYear" ? 4 : key === "number" ? 23 : 100}
                placeholder={key === "number" ? initial.masked || undefined : key === "expMonth" ? "MM" : key === "expYear" ? "YYYY" : undefined}
                value={fields[key]}
                onChange={(e) => set(key, e.target.value)}
              />
            </label>
          ))}
        </div>
        {initial.id && <p className="muted">{t("Leave the number empty to keep the saved one.")}</p>}
        {error && <div className="pw-error">{error}</div>}
        <div className="pw-actions">
          <button className="btn primary" disabled={busy} onClick={() => void submit()}>{t("Save")}</button>
          <button className="btn ghost" onClick={onClose}>{t("Cancel")}</button>
        </div>
      </div>
    </div>
  );
}

/** Deleting a saved card asks first; the red button stays off for a moment so a double click cannot reach it. */
function DeleteCardDialog({ card, onClose, onDone }: { card: CardSummary; onClose: () => void; onDone: () => void }) {
  const api = internalApi();
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => setArmed(true), DELETE_ARM_MS);
    return () => clearTimeout(timer);
  }, []);

  const run = (): void => {
    setBusy(true);
    setError(null);
    api.call("cards.remove", card.id).then(onDone, (err: unknown) => {
      setError(errorMessage(err));
      setBusy(false);
    });
  };

  return (
    <Modal
      title={t("Delete this card?")}
      onClose={onClose}
      footer={
        <>
          <button className="btn" autoFocus onClick={onClose}>
            {t("Cancel")}
          </button>
          <button className="btn danger-solid cd-confirm" disabled={!armed || busy} onClick={run}>
            {busy ? t("Deleting…") : t("Delete for good")}
          </button>
        </>
      }
    >
      <div className="dl-login">
        <IconCard size={15} />
        <div className="dl-login-main">
          <strong className="dl-site">{summaryLine(card)}</strong>
          <span className="dl-user">{card.nameOnCard}</span>
        </div>
      </div>
      <p className="dl-text">{t("Corvus no longer offers it on card forms. This cannot be undone.")}</p>
      <p className="dl-text">{t("With sync on, the card is removed from your other devices too.")}</p>
      {error && <div className="pw-error">{error}</div>}
    </Modal>
  );
}

/** Per-login opt-in: when this login's form loads, Corvus asks once, then fills and submits it. */
function AutoSignInToggle({ id, on, onChange }: { id: string; on: boolean; onChange: (id: string, on: boolean) => void }) {
  return (
    <span className="pt-option" title={t("Corvus asks before each automatic sign-in")}>
      <Toggle label={t("Sign in automatically on this site (asks first)")} checked={on} onChange={(next) => onChange(id, next)} />
      <span className="pt-option-label" aria-hidden="true">
        {t("Auto sign-in")}
      </span>
    </span>
  );
}

/**
 * One login in the Passwords tab, a saved one or a KeePass entry, in the same columns: its site (or
 * title) and username, its status chips, its 2FA code, the automatic sign-in switch, then Show, Copy,
 * Edit and Delete, always in that order and place (Show and Copy are off for a login without a
 * password).
 */
function LoginRow({
  id,
  url,
  primary,
  secondary,
  where,
  chips,
  code,
  autoOn,
  onAutoSignIn,
  hasPassword,
  revealed,
  onReveal,
  onCopy,
  onEdit,
  onDelete,
}: {
  id: string;
  url: string;
  primary: string;
  secondary: string;
  /** Where a KeePass entry is: its database and group. */
  where?: string;
  chips: ReactNode;
  code: ReactNode;
  autoOn: boolean;
  onAutoSignIn: (id: string, on: boolean) => void;
  hasPassword: boolean;
  revealed: string | undefined;
  onReveal: () => void;
  onCopy: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="pt-row" data-id={id}>
      <RowIcon url={url} />
      <NameCell primary={primary} secondary={secondary}>
        {where && (
          <span className="pt-where" title={where}>
            <IconFolder size={11} /> {where}
          </span>
        )}
        {revealed !== undefined && <span className="pw-reveal">{revealed}</span>}
      </NameCell>
      <div className="pt-meta">
        <div className="pt-status">{chips}</div>
        {code ?? <div className="pt-code" />}
        <AutoSignInToggle id={id} on={autoOn} onChange={onAutoSignIn} />
      </div>
      <div className="pt-actions">
        <RowAction className="pt-reveal" icon={<IconLock size={13} />} label={revealed !== undefined ? t("Hide") : t("Show")} name={revealed !== undefined ? t("Hide password") : t("Reveal password")} disabled={!hasPassword} onClick={onReveal} />
        <RowAction className="pt-copy-password" icon={<IconCopy size={13} />} label={t("Copy")} name={t("Copy password")} disabled={!hasPassword} onClick={onCopy} />
        <RowAction className="pt-edit" icon={<IconEdit size={13} />} label={t("Edit")} onClick={onEdit} />
        <RowAction className="pt-delete" icon={<IconTrash size={13} />} label={t("Delete")} onClick={onDelete} />
      </div>
    </div>
  );
}

/** The status chips of a login: 2FA only, then what the password checkup found, then AI agents' use. */
function LoginChips({ hasPassword, hasTotp, health, signIn, totp, agentAccess }: { hasPassword: boolean; hasTotp: boolean; health: PasswordHealth | undefined; signIn: boolean; totp: boolean; agentAccess: boolean }) {
  return (
    <>
      {!hasPassword && hasTotp && <span className="pill">{t("2FA only")}</span>}
      <HealthChips health={health} />
      <AgentChips signIn={signIn} totp={totp} globalOn={agentAccess} />
    </>
  );
}

/** The saved logins of the vault, a page at a time, in the table every list of the page shares. */
function VaultTable({
  items,
  page,
  onPage,
  health,
  agentAccess,
  autoIds,
  onAutoSignIn,
  revealed,
  onReveal,
  onCopy,
  onEdit,
  onDelete,
}: {
  items: CredentialSummary[];
  page: number;
  onPage: (page: number) => void;
  health: Map<string, PasswordHealth>;
  agentAccess: boolean;
  autoIds: Set<string>;
  onAutoSignIn: (id: string, on: boolean) => void;
  revealed: Record<string, string>;
  onReveal: (id: string) => void;
  onCopy: (id: string) => void;
  onEdit: (id: string) => void;
  onDelete: (item: CredentialSummary) => void;
}) {
  const now = useClock();
  const slice = pageSlice(items, page);
  return (
    <div className="pt-wrap pw-list">
      <div className="pt pt-logins">
        <TableHead name={t("Site and username")} options />
        {slice.items.map((item) => (
          <LoginRow
            key={item.id}
            id={item.id}
            url={item.origin}
            primary={hostOf(item.origin)}
            secondary={item.username || t("(no username)")}
            chips={<LoginChips hasPassword={item.hasPassword} hasTotp={item.hasTotp} health={health.get(item.id)} signIn={item.agentSignIn} totp={item.agentTotp} agentAccess={agentAccess} />}
            code={item.hasTotp ? <VaultTotp id={item.id} version={item.updatedAt} now={now} /> : null}
            autoOn={autoIds.has(item.id)}
            onAutoSignIn={onAutoSignIn}
            hasPassword={item.hasPassword}
            revealed={revealed[item.id]}
            onReveal={() => onReveal(item.id)}
            onCopy={() => onCopy(item.id)}
            onEdit={() => onEdit(item.id)}
            onDelete={() => onDelete(item)}
          />
        ))}
        <Pager page={slice.page} size={PAGE_SIZE} total={items.length} onPage={onPage} />
      </div>
    </div>
  );
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

function ExportForm({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const api = internalApi();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<KeePassExportResult>(null);
  const mismatch = confirm.length > 0 && confirm !== password;

  const run = async (): Promise<void> => {
    setBusy(true);
    const done = (await api.call("keepass.export", password)) as KeePassExportResult;
    setResult(done);
    if (done?.ok) onDone();
    setBusy(false);
  };

  return (
    <div className="kp-export">
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
  byBreaches,
  onExport,
  onDelete,
}: {
  query: string;
  agentAccess: boolean;
  autoIds: Set<string>;
  onAutoSignIn: (id: string, on: boolean) => void;
  health: Map<string, PasswordHealth>;
  /** Most breached entries first (after a breach check). */
  byBreaches: boolean;
  /** Opens the backup form (the export of the built-in vault) at the top of the page. */
  onExport: () => void;
  /** Asks to delete an entry (or only its 2FA), in two steps. */
  onDelete: (entry: KeePassEntrySummary) => void;
}) {
  const api = internalApi();
  const [state, setState] = useState<KeePassState | null>(null);
  const [entries, setEntries] = useState<KeePassEntrySummary[]>([]);
  const [unlocking, setUnlocking] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<Record<string, string>>({});

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
          <button className="btn small ghost" onClick={onExport}>{t("Export saved logins to KeePass")}</button>
        </div>


        {state && state.sources.length === 0 && <div className="pw-hint">{t("No KeePass databases yet. Add a .kdbx file, or a folder that holds them.")}</div>}
        {state && state.sources.filter((s) => s.kind === "folder").map((s) => (
          <div key={s.id} className="kp-source">
            <IconFolder size={13} /> <span className="grow kp-path" title={s.path}>{s.path}</span>
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
                    <div className="title" title={db.name}>
                      {db.name} <span className={`kp-status ${db.status}`}>{STATUS_LABEL[db.status]}</span>
                      {db.remembered && <span className="kp-status kept" title={t("Unlocks when Corvus starts")}>{t("Kept unlocked")}</span>}
                    </div>
                    <div className="sub" title={db.path}>
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
          entries={byBreaches ? sortByBreaches(entries, health) : entries}
          dbs={state?.databases ?? []}
          agentAccess={agentAccess}
          autoIds={autoIds}
          onAutoSignIn={onAutoSignIn}
          health={health}
          revealed={revealed}
          reveal={(id) => void reveal(id)}
          refresh={refresh}
          onDelete={onDelete}
        />
        {entries.some((e) => e.hasTotp) && <div className="pw-warn">{TWO_FACTOR_WARNING}</div>}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ KeePass entries: browse, add, edit

const KP_PAGE = 25;

/**
 * The form for a new entry, or for changing one: its password and its 2FA stay unless new ones are
 * typed (neither is ever shown here), and what is typed in them stays blurred until pointed at.
 * `onClose` must be stable (the Modal moves the focus whenever it changes).
 */
function KeePassEntryForm({ dbs, editing, agentAccess, onClose, onSaved }: { dbs: KeePassDbView[]; editing: KeePassEntrySummary | null; agentAccess: boolean; onClose: () => void; onSaved: () => void }) {
  const api = internalApi();
  const [dbId, setDbId] = useState(editing?.dbId ?? dbs[0]?.id ?? "");
  const [groups, setGroups] = useState<string[]>([""]);
  const [form, setForm] = useState<KeePassEntryDetails>({ title: editing?.title ?? "", username: editing?.username ?? "", url: "", notes: "", group: editing?.group ?? "" });
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // What the entry holds now, to tell whether Save has anything to write to the file.
  const [loaded, setLoaded] = useState<KeePassEntryDetails | null>(null);
  // AI agents' use of the entry: kept in Corvus and never in the file, so they need no write to it.
  const [agentSignIn, setAgentSignIn] = useState(editing?.agentSignIn ?? false);
  const [agentTotp, setAgentTotp] = useState(editing?.agentTotp ?? false);
  const canTotp = Boolean(editing?.hasTotp || totp.trim());
  const importQr = (): void => {
    setError(null);
    void api.call("credentials.importTotpQr").then((result) => {
      if (result?.ok) setTotp(result.uri);
      else if (result) setError(result.error);
    });
  };

  useEffect(() => {
    if (dbId) void api.call("keepass.groups", dbId).then((g) => setGroups(g.length ? g : [""]));
  }, [api, dbId]);
  useEffect(() => {
    if (!editing) return;
    void api.call("keepass.details", editing.id).then((d) => {
      if (!d) return;
      setForm(d);
      setLoaded(d);
    });
  }, [api, editing]);

  const set = (patch: Partial<KeePassEntryDetails>): void => setForm((f) => ({ ...f, ...patch }));
  const writesFile = !editing || (loaded !== null && keepassEntryChanged(loaded, form, password, totp));
  const saveOptions = async (id: string): Promise<void> => {
    if (agentSignIn === (editing?.agentSignIn ?? false) && (agentTotp && canTotp) === (editing?.agentTotp ?? false)) return;
    await api.call("keepass.setAgentOptIn", id, { signIn: agentSignIn, totp: agentTotp && canTotp });
  };
  const save = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    const uuid = editing ? editing.id.split(":").slice(2).join(":") : undefined;
    try {
      const id = writesFile || !editing ? await api.call("keepass.saveEntry", dbId, { ...form, ...(uuid ? { uuid } : {}), ...(password || !editing ? { password } : {}), ...(totp.trim() ? { totp } : {}) }) : editing.id;
      await saveOptions(id);
      onSaved();
    } catch (e) {
      // The options are not in the file, so a file that cannot be written does not stop them.
      if (editing) await saveOptions(editing.id).catch(() => undefined);
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
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
          <button className="btn primary" disabled={busy || !dbId || (editing !== null && loaded === null) || (writesFile && !form.title.trim())} onClick={() => void save()}>
            {busy ? t("Saving…") : writesFile ? t("Save to the database") : t("Save")}
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
          <input className="input kp-field-title" autoFocus value={form.title} onChange={(e) => set({ title: e.target.value })} />
        </label>
        <label className="modal-field">
          <span>{t("Username")}</span>
          <input className="input kp-field-username" value={form.username} autoComplete="off" spellCheck={false} onChange={(e) => set({ username: e.target.value })} />
        </label>
        <label className="modal-field">
          <span>{editing ? t("New password (leave empty to keep it)") : t("Password")}</span>
          <span className="kp-password">
            <SecretInput className="kp-password-input" blur={show} type={show ? "text" : "password"} value={password} autoComplete="new-password" spellCheck={false} onChange={setPassword} />
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
          <input className="input kp-field-url" value={form.url} placeholder="https://" spellCheck={false} onChange={(e) => set({ url: e.target.value })} />
        </label>
        <div className="modal-field kp-wide">
          <span id="kp-totp-label">{editing?.hasTotp ? t("New 2FA secret (leave empty to keep it)") : t("2FA (optional)")}</span>
          <SecretInput
            className="kp-totp-input"
            aria-labelledby="kp-totp-label"
            autoComplete="off"
            spellCheck={false}
            placeholder={t("Paste an otpauth:// link or the base32 secret")}
            value={totp}
            onChange={setTotp}
          />
          <div className="pw-gen">
            <button type="button" className="btn small" onClick={importQr}>
              {t("Import QR code image")}
            </button>
            <span>{t("Decoded on this device; the image is not uploaded.")}</span>
          </div>
        </div>
        <div className="modal-field kp-wide">
          <span>{t("AI agents")}</span>
          <label className="pw-opt kp-ai-signin">
            <input type="checkbox" checked={agentSignIn} onChange={(e) => setAgentSignIn(e.target.checked)} /> {t("Let AI agents sign in with this login")}
          </label>
          <label className="pw-opt kp-ai-totp">
            <input type="checkbox" disabled={!canTotp} checked={agentTotp && canTotp} onChange={(e) => setAgentTotp(e.target.checked)} /> {t("Let AI agents use this 2FA code")}
          </label>
          <div className="pw-hint">
            {t("Agents never see the password or the code: Corvus fills them into the page after you approve each use.")}
            {!agentAccess && (
              <>
                {" "}
                {t("AI agent use is off for every login until you turn it on in")} <a href="corvus://settings/#passwords">{t("Settings")}</a>.
              </>
            )}
          </div>
        </div>
        <label className="modal-field kp-notes">
          <span>{t("Notes")}</span>
          <textarea className="input" rows={3} value={form.notes} onChange={(e) => set({ notes: e.target.value })} />
        </label>
      </div>
    </Modal>
  );
}

/**
 * The entries of the unlocked databases: groups as folders beside them (above them when the card is
 * narrow), a search, and the same table as the saved logins a page at a time, each row saying which
 * database and group it is in.
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
  refresh,
  onDelete,
}: {
  entries: KeePassEntrySummary[];
  dbs: KeePassDbView[];
  agentAccess: boolean;
  autoIds: Set<string>;
  onAutoSignIn: (id: string, on: boolean) => void;
  health: Map<string, PasswordHealth>;
  revealed: Record<string, string>;
  reveal: (id: string) => void;
  refresh: () => void;
  onDelete: (entry: KeePassEntrySummary) => void;
}) {
  const api = internalApi();
  const now = useClock();
  const [search, setSearch] = useState("");
  const [group, setGroup] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [form, setForm] = useState<{ editing: KeePassEntrySummary | null } | null>(null);
  const closeForm = useCallback(() => setForm(null), []);
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
          <button className={group === null ? "active" : ""} aria-pressed={group === null} onClick={() => setGroup(null)}>
            <IconFolder size={14} /> <span className="grow">{t("All entries")}</span> <span className="kp-count">{entries.length}</span>
          </button>
          {groups.map(([path, count]) => {
            const depth = path.split(" / ").length - 1;
            return (
              <button key={path} className={group === path ? "active" : ""} aria-pressed={group === path} style={{ "--depth": depth } as CSSProperties} title={path} onClick={() => setGroup(path)}>
                <IconFolder size={14} />{" "}
                <span className="grow">
                  <span className="kp-leaf">{path.split(" / ").pop()}</span>
                  <span className="kp-full">{path}</span>
                </span>{" "}
                <span className="kp-count">{count}</span>
              </button>
            );
          })}
        </nav>
        <div className="pt-wrap kp-list">
          {slice.length === 0 ? (
            <div className="pw-hint kp-none">{search ? t("No entries match.") : t("No entries in this group.")}</div>
          ) : (
            <div className="pt pt-logins">
              <TableHead name={t("Entry and username")} options />
              {slice.map((e) => (
                <LoginRow
                  key={e.id}
                  id={e.id}
                  url={e.site ? `https://${e.site}` : ""}
                  primary={e.title || e.site || t("(untitled)")}
                  secondary={[e.username || t("(no username)"), e.site && e.site !== e.title ? e.site : ""].filter(Boolean).join(" · ")}
                  where={e.group ? `${e.dbName} / ${e.group}` : e.dbName}
                  chips={<LoginChips hasPassword={e.hasPassword} hasTotp={e.hasTotp} health={health.get(e.id)} signIn={e.agentSignIn} totp={e.agentTotp} agentAccess={agentAccess} />}
                  code={e.hasTotp ? <KeePassTotp id={e.id} version={e} now={now} /> : null}
                  autoOn={autoIds.has(e.id)}
                  onAutoSignIn={onAutoSignIn}
                  hasPassword={e.hasPassword}
                  revealed={revealed[e.id]}
                  onReveal={() => reveal(e.id)}
                  onCopy={() => void api.call("keepass.copyPassword", e.id)}
                  onEdit={() => setForm({ editing: e })}
                  onDelete={() => onDelete(e)}
                />
              ))}
              <Pager page={page} size={KP_PAGE} total={shown.length} onPage={setPage} />
            </div>
          )}
        </div>
      </div>
      {form && (
        <KeePassEntryForm
          dbs={unlocked}
          editing={form.editing}
          agentAccess={agentAccess}
          onClose={closeForm}
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
