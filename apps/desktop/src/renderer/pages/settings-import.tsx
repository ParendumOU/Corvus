import { useEffect, useState } from "react";
import type { ImportKind, ImportProfile, ImportResult, ImportScan, ImportSource } from "../../shared/browser-import";
import type { PasswordImportResult } from "../../shared/ipc";
import { errorMessage, internalApi } from "../common/api";
import { t } from "../common/i18n";
import "./settings-import.css";

const n = (value: number): string => value.toLocaleString();

function countsLine(counts: ImportProfile["counts"]): string {
  const parts: string[] = [];
  if (typeof counts.bookmarks === "number") parts.push(counts.bookmarks === 1 ? t("1 bookmark") : t("{n} bookmarks", { n: n(counts.bookmarks) }));
  if (typeof counts.history === "number") parts.push(counts.history === 1 ? t("1 page in history") : t("{n} pages in history", { n: n(counts.history) }));
  if (typeof counts.tabs === "number") parts.push(counts.tabs === 1 ? t("1 open tab") : t("{n} open tabs", { n: n(counts.tabs) }));
  return parts.join(" · ") || t("Nothing to import");
}

function resultLine(result: ImportResult): string {
  const parts: string[] = [];
  if (result.bookmarks) parts.push(t("{n} bookmarks in {folders} folders", { n: n(result.bookmarks.imported), folders: n(result.bookmarks.folders) }));
  if (result.history) parts.push(t("{n} pages of history", { n: n(result.history.imported) }));
  if (result.tabs) parts.push(t("{n} open tabs saved as {windows} workspaces", { n: n(result.tabs.tabs), windows: n(result.tabs.windows) }));
  return parts.length > 0 ? t("Imported {what}.", { what: parts.join(t(" and ")) }) : "";
}

function ProfileRow({ source, profile }: { source: ImportSource; profile: ImportProfile }) {
  const available = (kind: ImportKind): boolean => (profile.counts[kind] ?? 1) !== 0;
  const [kinds, setKinds] = useState<Record<ImportKind, boolean>>({ bookmarks: available("bookmarks"), history: available("history"), tabs: available("tabs") });
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const chosen = (Object.keys(kinds) as ImportKind[]).filter((k) => kinds[k]);
  const run = (): void => {
    setBusy(true);
    setError(null);
    setResult(null);
    internalApi()
      .call("import.run", source.id, profile.dir, chosen)
      .then(setResult)
      .catch((e: unknown) => setError(errorMessage(e)))
      .finally(() => setBusy(false));
  };
  const label: Record<ImportKind, string> = { bookmarks: t("Bookmarks"), history: t("History"), tabs: t("Open tabs") };
  return (
    <div className="import-profile" data-import-profile={profile.dir}>
      <div className="import-profile-head">
        <div className="grow">
          <div className="title">
            {source.profiles.length > 1 ? profile.name : source.name}
            {source.profiles.length > 1 && profile.isDefault && <span className="pill">{t("default")}</span>}
          </div>
          <div className="sub">{countsLine(profile.counts)}</div>
        </div>
        <button className="btn small primary" disabled={busy || chosen.length === 0} data-import-run onClick={run}>
          {busy ? t("Importing…") : t("Import")}
        </button>
      </div>
      <div className="import-kinds">
        {(Object.keys(kinds) as ImportKind[]).map((kind) => (
          <label key={kind} className="check">
            <input type="checkbox" checked={kinds[kind]} disabled={!available(kind)} onChange={(e) => setKinds({ ...kinds, [kind]: e.target.checked })} />
            {label[kind]}
          </label>
        ))}
      </div>
      {result && resultLine(result) && <div className="notice ok" data-import-result>{resultLine(result)}</div>}
      {result &&
        Object.entries(result.errors).map(([kind, message]) => (
          <div key={kind} className="notice error">
            {label[kind as ImportKind]}: {message}
          </div>
        ))}
      {error && <div className="notice error">{error}</div>}
    </div>
  );
}

/**
 * Import from the other browsers installed here: each browser and profile with what it holds, and
 * which kinds to bring over. Bookmarks land in a folder of their own under Other bookmarks; history
 * merges with Corvus's.
 */
export function BrowserImportPanel() {
  const [scan, setScan] = useState<ImportScan | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    internalApi()
      .call("import.scan")
      .then(setScan)
      .catch((e: unknown) => setError(errorMessage(e)));
  }, []);
  return (
    <div>
      {error ? (
        <div className="notice error import-pad">{error}</div>
      ) : !scan ? (
        <div className="empty small">{t("Looking for other browsers…")}</div>
      ) : scan.sources.length === 0 ? (
        <div className="empty small">{t("No other browsers found for this user.")}</div>
      ) : (
        <div className="import-sources">
          {scan.sources.map((source) => (
            <div key={source.id} className="import-source" data-import-source={source.id}>
              {source.profiles.length > 1 && <div className="import-source-name">{source.name}</div>}
              {source.profiles.map((profile) => (
                <ProfileRow key={profile.dir} source={source} profile={profile} />
              ))}
            </div>
          ))}
        </div>
      )}
      <PasswordCsvImport />
    </div>
  );
}

/** Import logins from a CSV the person exported from another browser's password manager. */
function PasswordCsvImport() {
  const [result, setResult] = useState<PasswordImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = (): void => {
    setBusy(true);
    setError(null);
    internalApi()
      .call("import.passwordCsv")
      .then(setResult)
      .catch((e: unknown) => setError(errorMessage(e)))
      .finally(() => setBusy(false));
  };
  const extra = result && !result.canceled ? [result.duplicates > 0 ? t("{n} already saved.", { n: n(result.duplicates) }) : "", result.skipped > 0 ? t("{n} rows skipped.", { n: n(result.skipped) }) : ""].filter(Boolean).join(" ") : "";
  return (
    <div className="import-passwords">
      <div className="import-passwords-head">
        <div className="grow">
          <div className="title">{t("Passwords")}</div>
          <div className="sub">
            {t("Export your logins to a CSV in the other browser (its password settings have an Export passwords option), then pick the file here. The file holds your passwords in plain text — delete it when you are done.")}
          </div>
        </div>
        <button className="btn small" disabled={busy} data-import-passwords onClick={run}>
          {busy ? t("Importing…") : t("Import a CSV…")}
        </button>
      </div>
      {result && !result.canceled && (
        <div className="notice ok" data-import-passwords-result>
          {result.imported > 0 ? t("Imported {n} logins.", { n: n(result.imported) }) : t("No new logins imported.")}
          {extra ? ` ${extra}` : ""}
        </div>
      )}
      {error && <div className="notice error">{error}</div>}
    </div>
  );
}
