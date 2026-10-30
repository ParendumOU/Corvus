import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AuthenticatorImportResult, AuthenticatorPreview, ImportAction, ImportRow, MissingCodes, PhotoReport, SkippedAccount } from "../../shared/authenticator-import";
import { errorMessage, internalApi } from "../common/api";
import { t } from "../common/i18n";
import { IconCamera, IconFolder, IconWarning } from "../common/icons";
import { hostOf } from "../common/ui";

type Stage = "start" | "reading" | "preview" | "done";

/** Rows that can be imported: the others are shown but have no checkbox to tick. */
const importable = (row: ImportRow): boolean => row.action === "attach" || row.action === "replace" || row.action === "create";

const accounts = (n: number): string => (n === 1 ? t("1 account") : t("{n} accounts", { n }));
const photos = (n: number): string => (n === 1 ? t("1 photo") : t("{n} photos", { n }));
const logins = (n: number): string => (n === 1 ? t("1 login") : t("{n} logins", { n }));

function photoText(report: PhotoReport, exportCount: number): string {
  const s = report.status;
  switch (s.kind) {
    case "batch": {
      const label = exportCount > 1 ? t("Export {exportNo}, QR {index} of {size}", { exportNo: s.exportNo, index: s.index, size: s.size }) : t("QR {index} of {size}", { index: s.index, size: s.size });
      return s.again ? t("{label}: already read, ignored", { label }) : t("{label}: {accounts}", { label, accounts: accounts(s.accounts) });
    }
    case "setup": {
      const label = t("Setup code for {name}", { name: [s.issuer, s.account].filter(Boolean).join(": ") });
      return s.again ? t("{label}: already read, ignored", { label }) : label;
    }
    case "none":
      return t("No QR code found. Take the photo again, closer and without glare.");
    case "unreadable":
      return t("Could not open this image. Use PNG or JPEG photos.");
    case "too-large":
      return t("This image is too large (over 64 MB).");
    case "not-2fa":
      return t("This QR code is not a 2FA code.");
    case "damaged":
      return t("This QR code is damaged or incomplete. Take the photo again.");
  }
}

const photoProblem = (report: PhotoReport): boolean => !["batch", "setup"].includes(report.status.kind);

function missingText(m: MissingCodes, exportCount: number): string {
  const text =
    m.missing.length === 1
      ? t("QR {index} of {size} is missing.", { index: m.missing[0]!, size: m.size })
      : t("QR codes {list} of {size} are missing.", { list: m.missing.join(", "), size: m.size });
  return exportCount > 1 ? t("Export {exportNo}: {text}", { exportNo: m.exportNo, text }) : text;
}

const SKIP_REASON: Record<SkippedAccount["reason"], string> = {
  hotp: t("counter-based codes (HOTP) are not supported"),
  md5: t("MD5 codes are not supported"),
  invalid: t("the entry is damaged"),
};

function actionText(row: ImportRow): string {
  const user = row.login?.username || t("(no username)");
  const site = row.login ? hostOf(row.login.origin) : "";
  switch (row.action) {
    case "attach":
      return t("Adds 2FA to your login {user} on {site}", { user, site });
    case "replace":
      return t("Replaces the different 2FA of your login {user} on {site}", { user, site });
    case "same":
      return t("Your login {user} on {site} already has this 2FA", { user, site });
    case "create":
      return t("New login (2FA only)");
    case "needs-site":
      return t("Enter the site where you sign in to import it");
  }
}

type Filter = ImportAction | null;

const FILTERS: Array<{ action: ImportAction; label: string }> = [
  { action: "attach", label: t("Matched") },
  { action: "create", label: t("New") },
  { action: "replace", label: t("Conflicts") },
  { action: "needs-site", label: t("Needs a site") },
  { action: "same", label: t("Already set") },
];

/**
 * Moves 2FA accounts from Google Authenticator into the vault: photos of its export QR codes are read
 * one by one in the main process, then every account is shown with where it goes. The secrets stay in
 * the main process: this page only sends row ids and the sites typed for them.
 */
export function AuthenticatorImport({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  const api = internalApi();
  const [stage, setStage] = useState<Stage>("start");
  const [importId, setImportId] = useState<string | null>(null);
  const [names, setNames] = useState<string[]>([]);
  const [reports, setReports] = useState<Array<PhotoReport | undefined>>([]);
  const [reading, setReading] = useState(0);
  const [preview, setPreview] = useState<AuthenticatorPreview | null>(null);
  const [sites, setSites] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AuthenticatorImportResult | null>(null);
  const live = useRef<string | null>(null);
  const stopped = useRef(false);
  const shownRows = useRef<ImportRow[]>([]);
  const planSeq = useRef(0);

  // The import ends (its accounts forgotten in the main process) when this view goes away.
  useEffect(
    () => () => {
      stopped.current = true;
      if (live.current) void api.call("credentials.authenticatorDiscard", live.current);
    },
    [api],
  );

  /** Takes the new plan, keeping the person's ticks on rows whose destination did not change. */
  const applyPreview = useCallback((next: AuthenticatorPreview) => {
    const old = new Map(shownRows.current.map((r) => [r.id, r]));
    shownRows.current = next.rows;
    setPreview(next);
    setSelected((current) => {
      const chosen = new Set(current);
      for (const row of next.rows) {
        const was = old.get(row.id);
        if (was && was.action === row.action && was.target === row.target) continue;
        const taken = next.rows.some((o) => o.id !== row.id && o.target === row.target && chosen.has(o.id));
        if (row.selected && !taken) chosen.add(row.id);
        else chosen.delete(row.id);
      }
      for (const row of next.rows) if (!importable(row)) chosen.delete(row.id);
      return chosen;
    });
  }, []);

  /** Plans again; an answer that a newer request overtook is dropped. */
  const loadPreview = useCallback(
    async (id: string, typed: Record<string, string>) => {
      const seq = ++planSeq.current;
      const next = await api.call("credentials.authenticatorPreview", id, typed);
      if (seq === planSeq.current) applyPreview(next);
    },
    [api, applyPreview],
  );

  const pick = async (kind: "files" | "folder"): Promise<void> => {
    setError(null);
    let picked;
    try {
      picked = await api.call("credentials.authenticatorPick", importId, kind);
    } catch (err) {
      setError(errorMessage(err));
      return;
    }
    if (!picked) return;
    live.current = picked.importId;
    setImportId(picked.importId);
    setNames(picked.names);
    if (picked.added === 0) {
      setError(picked.names.length === 0 ? t("There are no PNG or JPEG photos in that folder.") : t("Those photos are already in this import."));
      return;
    }
    setStage("reading");
    stopped.current = false;
    for (let i = picked.names.length - picked.added; i < picked.names.length; i++) {
      if (stopped.current) return;
      setReading(i);
      try {
        const report = await api.call("credentials.authenticatorRead", picked.importId, i);
        setReports((r) => {
          const next = [...r];
          next[i] = report;
          return next;
        });
      } catch (err) {
        setError(errorMessage(err));
        setStage("start");
        return;
      }
    }
    if (stopped.current) return;
    await loadPreview(picked.importId, sites);
    setStage("preview");
  };

  // Typing a site re-plans where the rows go (debounced).
  useEffect(() => {
    if (stage !== "preview" || !importId) return;
    const timer = setTimeout(() => void loadPreview(importId, sites), 250);
    return () => clearTimeout(timer);
  }, [sites, stage, importId, loadPreview]);

  const rows = preview?.rows ?? [];
  const exportCount = preview?.exportCount ?? 0;
  const counts = useMemo(() => {
    const by: Record<ImportAction, number> = { attach: 0, replace: 0, same: 0, create: 0, "needs-site": 0 };
    for (const r of rows) by[r.action]++;
    return by;
  }, [rows]);
  const shared = useMemo(() => {
    const per = new Map<string, number>();
    for (const r of rows) per.set(r.target, (per.get(r.target) ?? 0) + 1);
    return per;
  }, [rows]);
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter(
      (r) => (filter === null || r.action === filter) && (!q || [r.issuer, r.account, r.site, sites[r.id] ?? ""].some((v) => v.toLowerCase().includes(q))),
    );
  }, [rows, filter, query, sites]);
  const chosen = rows.filter((r) => selected.has(r.id) && importable(r));

  const toggle = (row: ImportRow, on: boolean): void =>
    setSelected((current) => {
      const next = new Set(current);
      if (on) {
        for (const other of rows) if (other.target === row.target) next.delete(other.id);
        next.add(row.id);
      } else next.delete(row.id);
      return next;
    });

  const selectVisible = (on: boolean): void =>
    setSelected((current) => {
      const next = new Set(current);
      for (const row of visible) {
        if (!on) next.delete(row.id);
        else if (importable(row) && row.action !== "replace" && !rows.some((o) => o.id !== row.id && o.target === row.target && next.has(o.id))) next.add(row.id);
      }
      return next;
    });

  const runImport = async (): Promise<void> => {
    if (!importId) return;
    setBusy(true);
    setError(null);
    try {
      const done = await api.call("credentials.authenticatorImport", importId, sites, chosen.map((r) => r.id));
      live.current = null;
      setResult(done);
      setStage("done");
      onImported();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const read = reports.filter(Boolean) as PhotoReport[];
  const exportsSeen = new Set(read.flatMap((r) => (r.status.kind === "batch" ? [r.status.exportNo] : []))).size;

  return (
    <div className="card ga-import">
      <div className="card-head">
        <h2>{t("Import from Google Authenticator")}</h2>
        <p className="muted">{t("The photos are read on this device and never uploaded. Corvus keeps each 2FA secret in its encrypted vault and fills the code on the site.")}</p>
      </div>
      <div className="card-body padded ga-body">
        {stage === "start" && (
          <>
            <ol className="ga-steps">
              <li>{t("In Google Authenticator, open the menu and choose Transfer accounts, then Export accounts.")}</li>
              <li>{t("Select the accounts and take a photo of each QR code it shows (\"QR code 1 of 4\", and so on).")}</li>
              <li>{t("Copy the photos to this computer and choose them here, or choose the folder that holds them.")}</li>
            </ol>
            <div className="pw-actions">
              <button className="btn primary" onClick={() => void pick("files")}>
                <IconCamera size={14} /> {t("Choose photos")}
              </button>
              <button className="btn" onClick={() => void pick("folder")}>
                <IconFolder size={14} /> {t("Choose a folder")}
              </button>
              <button className="btn ghost" onClick={onClose}>{t("Cancel")}</button>
            </div>
          </>
        )}

        {stage === "reading" && (
          <div className="ga-reading">
            <div className="ga-progress-line">
              <span className="spinner" />
              <strong>{t("Reading photo {n} of {total}", { n: reading + 1, total: names.length })}</strong>
            </div>
            <div className="ga-progress">
              <span style={{ width: `${(read.length / Math.max(1, names.length)) * 100}%` }} />
            </div>
            <PhotoList names={names} reports={reports} exportCount={exportsSeen} />
            <div className="pw-actions">
              <button className="btn ghost" onClick={() => {
                stopped.current = true;
                onClose();
              }}>{t("Cancel")}</button>
            </div>
          </div>
        )}

        {stage === "preview" && preview && (
          <>
            <div className="ga-summary">
              <strong>{t("{accounts} found in {photos}", { accounts: accounts(rows.length), photos: photos(names.length) })}</strong>
              <button className="btn small" onClick={() => void pick("files")}>
                <IconCamera size={13} /> {t("Add photos")}
              </button>
            </div>
            {preview.missing.length > 0 && (
              <div className="pw-warn">
                <IconWarning size={13} /> {preview.missing.map((m) => missingText(m, exportCount)).join(" ")}{" "}
                {t("Take a photo of each missing code and add it with Add photos, or import without those accounts.")}
              </div>
            )}
            <details className="ga-photos" open={read.some(photoProblem)}>
              <summary>
                {t("Photos: {n}", { n: names.length })}
                {read.some(photoProblem) && <span className="pill bad">{t("{n} with problems", { n: read.filter(photoProblem).length })}</span>}
              </summary>
              <PhotoList names={names} reports={reports} exportCount={exportsSeen} />
            </details>

            {rows.length > 0 && (
              <>
                <div className="ga-toolbar">
                  <div className="ga-chips" role="group" aria-label={t("Show")}>
                    <button className={`ga-chip ${filter === null ? "on" : ""}`} onClick={() => setFilter(null)}>
                      {t("All")} <span>{rows.length}</span>
                    </button>
                    {FILTERS.filter((f) => counts[f.action] > 0).map((f) => (
                      <button key={f.action} className={`ga-chip ${f.action} ${filter === f.action ? "on" : ""}`} onClick={() => setFilter(filter === f.action ? null : f.action)}>
                        {f.label} <span>{counts[f.action]}</span>
                      </button>
                    ))}
                  </div>
                  <div className="ga-tools">
                    <input className="input ga-filter" placeholder={t("Filter accounts")} value={query} onChange={(e) => setQuery(e.target.value)} />
                    <button className="btn small ghost" title={t("Conflicts stay as they are: tick each one you want to replace")} onClick={() => selectVisible(true)}>{t("Select all")}</button>
                    <button className="btn small ghost" onClick={() => selectVisible(false)}>{t("Select none")}</button>
                  </div>
                </div>

                <div className="ga-table" role="table" aria-label={t("Accounts")}>
                  <div className="ga-row ga-head" role="row">
                    <span />
                    <span>{t("Account")}</span>
                    <span>{t("Site")}</span>
                    <span>{t("What happens")}</span>
                  </div>
                  {visible.map((row) => (
                    <div key={row.id} className={`ga-row ${row.action} ${selected.has(row.id) ? "chosen" : ""}`} role="row">
                      <input
                        type="checkbox"
                        aria-label={t("Import {name}", { name: row.issuer || row.account })}
                        disabled={!importable(row)}
                        checked={selected.has(row.id) && importable(row)}
                        onChange={(e) => toggle(row, e.target.checked)}
                      />
                      <span className="ga-account">
                        <strong>{row.issuer || t("(no issuer)")}</strong>
                        <span className="muted">{row.account || t("(no account name)")}</span>
                      </span>
                      <input
                        className={`input ga-site ${row.action === "needs-site" ? "missing" : ""}`}
                        spellCheck={false}
                        placeholder={t("site.com")}
                        value={sites[row.id] ?? row.siteInput}
                        onChange={(e) => setSites((s) => ({ ...s, [row.id]: e.target.value }))}
                      />
                      <span className="ga-what">
                        {actionText(row)}
                        {row.action === "replace" && <span className="ga-note">{t("It already has a different 2FA code: tick the box to replace it.")}</span>}
                        {(shared.get(row.target) ?? 0) > 1 && importable(row) && <span className="ga-note">{t("Another account here goes to the same login: only one of them can be imported.")}</span>}
                      </span>
                    </div>
                  ))}
                  {visible.length === 0 && <div className="pw-hint ga-none">{t("No accounts match.")}</div>}
                </div>
              </>
            )}

            {preview.skipped.length > 0 && (
              <details className="ga-skipped">
                <summary>{preview.skipped.length === 1 ? t("1 account cannot be imported") : t("{n} accounts cannot be imported", { n: preview.skipped.length })}</summary>
                <ul>
                  {preview.skipped.map((s, i) => (
                    <li key={i}>
                      <strong>{[s.issuer, s.account].filter(Boolean).join(": ") || t("(no name)")}</strong>: {SKIP_REASON[s.reason]}
                    </li>
                  ))}
                </ul>
              </details>
            )}

            <div className="pw-warn">{t("Keeping a 2FA secret next to the password turns two factors into one: anyone who can open this vault gets both. Use a separate authenticator for your most important accounts.")}</div>
            {error && <div className="pw-error">{error}</div>}
            <div className="pw-actions ga-foot">
              <button className="btn primary" disabled={busy || chosen.length === 0} onClick={() => void runImport()}>
                {busy ? t("Importing…") : chosen.length === 1 ? t("Import 1 account") : t("Import {n} accounts", { n: chosen.length })}
              </button>
              <button className="btn ghost" onClick={onClose}>{t("Cancel")}</button>
            </div>
          </>
        )}

        {stage === "done" && result && (
          <>
            <div className="ga-result">
              <strong>{t("Added 2FA to {logins}, created {created}.", { logins: logins(result.attached), created: result.created })}</strong>
            </div>
            <div className="pw-warn ga-delete">
              <IconWarning size={14} />{" "}
              {t("Now delete the photos: they hold every 2FA secret. Delete them from this computer, from your phone's gallery (and its recently deleted folder), and from any cloud photo backup such as Google Photos or iCloud.")}
            </div>
            <div className="pw-actions">
              <button className="btn primary" onClick={onClose}>{t("Done")}</button>
            </div>
          </>
        )}

        {stage !== "preview" && error && <div className="pw-error">{error}</div>}
      </div>
    </div>
  );
}

function PhotoList({ names, reports, exportCount }: { names: string[]; reports: Array<PhotoReport | undefined>; exportCount: number }) {
  return (
    <ul className="ga-photo-list">
      {names.map((name, i) => {
        const report = reports[i];
        return (
          <li key={`${i}-${name}`} className={report ? (photoProblem(report) ? "bad" : report.status.kind === "batch" && report.status.again ? "again" : "ok") : "waiting"}>
            <span className="ga-photo-name">{name}</span>
            <span className="ga-photo-status">{report ? photoText(report, exportCount) : t("Waiting")}</span>
          </li>
        );
      })}
    </ul>
  );
}
