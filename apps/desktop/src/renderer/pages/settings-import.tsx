import { useEffect, useState } from "react";
import type { ImportExtension, ImportKind, ImportProfile, ImportResult, ImportScan, ImportSource } from "../../shared/browser-import";
import type { PasswordImportResult } from "../../shared/ipc";
import { errorMessage, internalApi } from "../common/api";
import { t } from "../common/i18n";
import "./settings-import.css";

const n = (value: number): string => value.toLocaleString();

function countsLine(counts: ImportProfile["counts"], extensions: number): string {
  const parts: string[] = [];
  if (typeof counts.bookmarks === "number") parts.push(counts.bookmarks === 1 ? t("1 bookmark") : t("{n} bookmarks", { n: n(counts.bookmarks) }));
  if (typeof counts.history === "number") parts.push(counts.history === 1 ? t("1 page in history") : t("{n} pages in history", { n: n(counts.history) }));
  if (typeof counts.tabs === "number") parts.push(counts.tabs === 1 ? t("1 open tab") : t("{n} open tabs", { n: n(counts.tabs) }));
  if (typeof counts.search === "number" && counts.search > 0) parts.push(counts.search === 1 ? t("1 search shortcut") : t("{n} search shortcuts", { n: n(counts.search) }));
  if (extensions > 0) parts.push(extensions === 1 ? t("1 extension") : t("{n} extensions", { n: n(extensions) }));
  return parts.join(" · ") || t("Nothing to import");
}

function resultLine(result: ImportResult): string {
  const parts: string[] = [];
  if (result.bookmarks) parts.push(t("{n} bookmarks in {folders} folders", { n: n(result.bookmarks.imported), folders: n(result.bookmarks.folders) }));
  if (result.history) parts.push(t("{n} pages of history", { n: n(result.history.imported) }));
  if (result.search) parts.push(t("{n} search shortcuts", { n: n(result.search.imported) }));
  if (result.tabs) parts.push(t("{n} open tabs saved as {windows} workspaces", { n: n(result.tabs.tabs), windows: n(result.tabs.windows) }));
  return parts.length > 0 ? t("Imported {what}.", { what: parts.join(t(" and ")) }) : "";
}

function ProfileRow({ source, profile }: { source: ImportSource; profile: ImportProfile }) {
  const available = (kind: ImportKind): boolean => (profile.counts[kind] ?? 1) !== 0;
  const [kinds, setKinds] = useState<Record<ImportKind, boolean>>({
    bookmarks: available("bookmarks"),
    history: available("history"),
    tabs: available("tabs"),
    search: available("search"),
  });
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
  const label: Record<ImportKind, string> = { bookmarks: t("Bookmarks"), history: t("History"), tabs: t("Open tabs"), search: t("Search shortcuts") };
  return (
    <div className="import-profile" data-import-profile={profile.dir}>
      <div className="import-profile-head">
        <div className="grow">
          <div className="title">
            {source.profiles.length > 1 ? profile.name : source.name}
            {source.profiles.length > 1 && profile.isDefault && <span className="pill">{t("default")}</span>}
          </div>
          <div className="sub">{countsLine(profile.counts, profile.extensions.length)}</div>
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
      {profile.extensions.length > 0 && <ExtensionList source={source} extensions={profile.extensions} />}
    </div>
  );
}

/**
 * The extensions of a profile, added one at a time: a Chromium browser's come from the Chrome Web
 * Store (Corvus asks before each install, with its permissions); Firefox's add-ons are looked up
 * there by name.
 */
function ExtensionList({ source, extensions }: { source: ImportSource; extensions: ImportExtension[] }) {
  const [state, setState] = useState<Record<string, "busy" | "added" | { error: string }>>({});
  const add = (id: string): void => {
    setState((s) => ({ ...s, [id]: "busy" }));
    internalApi()
      .call("import.installExtension", id)
      .then((info) =>
        setState((s) => {
          const next = { ...s };
          if (info) next[id] = "added";
          else delete next[id];
          return next;
        }),
      )
      .catch((e: unknown) => setState((s) => ({ ...s, [id]: { error: errorMessage(e) } })));
  };
  const firefox = source.family === "firefox";
  return (
    <details className="import-extensions" data-import-extensions>
      <summary>{extensions.length === 1 ? t("1 extension") : t("{n} extensions", { n: n(extensions.length) })}</summary>
      <div className="sub">
        {firefox
          ? t("Firefox add-ons come from Firefox's own store. Many are in the Chrome Web Store too: look each one up there.")
          : t("Add the ones you want from the Chrome Web Store. Corvus shows what each one may do before it installs.")}
      </div>
      <ul>
        {extensions.map((e) => {
          const s = e.id ? state[e.id] : undefined;
          return (
            <li key={e.id ?? e.name} data-import-extension={e.id ?? e.name}>
              <span className="grow">{e.name}</span>
              {e.id === null ? (
                <a className="btn small" href={`https://chromewebstore.google.com/search/${encodeURIComponent(e.name)}`} target="_blank" rel="noreferrer">
                  {t("Find in the Web Store")}
                </a>
              ) : e.installed || s === "added" ? (
                <span className="pill">{t("In Corvus")}</span>
              ) : (
                <button className="btn small" disabled={s === "busy"} onClick={() => add(e.id!)}>
                  {s === "busy" ? t("Adding…") : t("Add to Corvus")}
                </button>
              )}
              {typeof s === "object" && <div className="notice error">{s.error}</div>}
            </li>
          );
        })}
      </ul>
    </details>
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
