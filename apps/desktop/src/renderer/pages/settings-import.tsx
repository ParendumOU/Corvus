import { useEffect, useState } from "react";
import {
  passwordExportPage,
  type ImportExtension,
  type ImportKind,
  type ImportProfile,
  type ImportResult,
  type ImportScan,
  type ImportSource,
  type PasswordImportSummary,
  type PasswordNoteReason,
} from "../../shared/browser-import";
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
  if (typeof counts.passwords === "number" && counts.passwords > 0) parts.push(counts.passwords === 1 ? t("1 saved password") : t("{n} saved passwords", { n: n(counts.passwords) }));
  if (extensions > 0) parts.push(extensions === 1 ? t("1 extension") : t("{n} extensions", { n: n(extensions) }));
  return parts.join(" · ") || t("Nothing to import");
}

/** The counts of a password import, as one sentence (only the parts that happened). */
function passwordCounts(s: PasswordImportSummary): string {
  const parts = [
    s.added > 0 ? t("{n} new", { n: n(s.added) }) : "",
    s.updated > 0 ? t("{n} updated", { n: n(s.updated) }) : "",
    s.alreadySaved > 0 ? t("{n} already saved", { n: n(s.alreadySaved) }) : "",
    s.olderLeftAlone > 0 ? t("{n} older left alone", { n: n(s.olderLeftAlone) }) : "",
    s.deletedLeftOut > 0 ? t("{n} deleted in Corvus left out", { n: n(s.deletedLeftOut) }) : "",
    s.review.length > 0 ? t("{n} to review", { n: n(s.review.length) }) : "",
    s.protected > 0 ? t("{n} protected by the browser", { n: n(s.protected) }) : "",
    s.skipped > 0 ? t("{n} skipped", { n: n(s.skipped) }) : "",
  ].filter(Boolean);
  return parts.length > 0 ? t("Passwords: {what}.", { what: parts.join(", ") }) : t("No saved passwords were found.");
}

/** What each reason means, for the person. */
function reasonText(reason: PasswordNoteReason): string {
  switch (reason) {
    case "app-bound":
      return t("Protected by the browser: only its own export can bring these.");
    case "keyring":
      return t("The system did not hand over the browser's key: use the browser's own export.");
    case "primary-password":
      return t("Firefox keeps these behind its primary password: use Firefox's own export.");
    case "never-save":
      return t("Sites where you chose never to save a password.");
    case "android":
      return t("Logins of Android apps, not of websites.");
    case "federated":
      return t("Sign in through another account, with no password of their own.");
    case "no-password":
      return t("Saved without a password.");
    case "not-web":
      return t("Not a website.");
    case "unreadable":
      return t("Could not be read.");
    case "older":
      return t("An older password than the one in Corvus: Corvus kept its own and remembers this one.");
    case "deleted":
      return t("You deleted these in Corvus: they stay deleted.");
    case "review":
      return t("Different from Corvus, with no date to tell which is newer: not changed until you choose.");
  }
}

const REASON_ORDER: PasswordNoteReason[] = ["review", "app-bound", "keyring", "primary-password", "older", "deleted", "never-save", "android", "federated", "no-password", "not-web", "unreadable"];

/** The result of a password import: counts, the logins to review, the reasons, and the reminder. */
function PasswordResult({ summary }: { summary: PasswordImportSummary }) {
  const [updated, setUpdated] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const apply = (which: number[] | "all"): void => {
    if (!summary.reviewToken) return;
    internalApi()
      .call("import.passwordReview", summary.reviewToken, which)
      .then(() => setUpdated(new Set([...updated, ...(which === "all" ? summary.review.map((_, i) => i) : which)])))
      .catch((e: unknown) => setError(errorMessage(e)));
  };
  const groups = REASON_ORDER.map((reason) => ({ reason, notes: summary.notes.filter((note) => note.reason === reason && reason !== "review") })).filter((g) => g.notes.length > 0);
  const pending = summary.review.filter((_, i) => !updated.has(i)).length;
  return (
    <div className="import-password-result" data-import-password-result>
      <div className="notice ok" data-import-password-counts>
        {passwordCounts(summary)}
        {summary.browser && summary.added + summary.updated > 0 ? ` ${t("{browser} still keeps its own copy of these passwords.", { browser: summary.browser })}` : ""}
      </div>
      {summary.review.length > 0 && (
        <div className="import-review" data-import-review>
          <div className="sub">
            {pending > 0
              ? t("These passwords differ from the ones in Corvus and nothing says which is newer, so Corvus left its own. Update the ones you want.")
              : t("Updated. The previous passwords stay in each login's history.")}
          </div>
          <ul>
            {summary.review.map((r, i) => (
              <li key={`${r.site}\n${r.username}`} data-import-review-row={i}>
                <span className="grow">
                  {r.site}
                  {r.username ? <span className="muted">{` · ${r.username}`}</span> : null}
                </span>
                {updated.has(i) ? <span className="pill">{t("Updated")}</span> : <button className="btn small" onClick={() => apply([i])}>{t("Update")}</button>}
              </li>
            ))}
          </ul>
          {pending > 1 && (
            <button className="btn small" data-import-review-all onClick={() => apply("all")}>
              {t("Update all")}
            </button>
          )}
        </div>
      )}
      {groups.length > 0 && (
        <details className="import-reasons" data-import-reasons>
          <summary>{t("Why some logins were not added or changed")}</summary>
          {groups.map((g) => (
            <div key={g.reason} className="import-reason" data-import-reason={g.reason}>
              <div className="sub">{reasonText(g.reason)}</div>
              <ul>
                {g.notes.map((note, i) => (
                  <li key={i}>
                    {note.site}
                    {note.username ? <span className="muted">{` · ${note.username}`}</span> : null}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </details>
      )}
      {error && <div className="notice error">{error}</div>}
    </div>
  );
}

/** A checkbox, on by default, to delete an exported CSV for good once imported. */
function DeleteCsvChoice({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="check import-delete-csv">
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} data-import-delete-csv />
      {t("Delete the exported file for good once imported (it holds your passwords in plain text)")}
    </label>
  );
}

/**
 * Passwords a browser protects itself come through its own export, from the same click: Corvus opens
 * the browser's password page, then waits a few minutes for the file it saves in Downloads.
 */
function GuidedExport({ source, count }: { source: ImportSource; count: number }) {
  const [deleteAfter, setDeleteAfter] = useState(true);
  const [waiting, setWaiting] = useState(false);
  const [opened, setOpened] = useState<boolean | null>(null);
  const [result, setResult] = useState<PasswordImportSummary | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const page = passwordExportPage(source.id);
  const firefox = source.family === "firefox";
  const start = (): void => {
    setWaiting(true);
    setResult(null);
    setMessage(null);
    setOpened(null);
    internalApi()
      .call("import.passwordExport", source.id, deleteAfter)
      .then((r) => {
        setOpened(r.opened);
        if (r.status === "imported" && r.summary) {
          setResult(r.summary);
          setMessage(r.deleted ? t("{file} was imported and deleted.", { file: r.file ?? "" }) : t("{file} was imported. Delete it when you are done: it holds your passwords in plain text.", { file: r.file ?? "" }));
        } else if (r.status === "timeout") setMessage(t("No export appeared in Downloads. Try again, or pick the file below."));
      })
      .catch((e: unknown) => setMessage(errorMessage(e)))
      .finally(() => setWaiting(false));
  };
  const how = firefox
    ? t("In Firefox, open {page} in the address bar, open the menu with three dots, choose Export passwords and save the file in your Downloads folder.", { page })
    : t("In {browser}, open {page} in the address bar, choose Export passwords and save the file in your Downloads folder.", { browser: source.name, page });
  return (
    <div className="import-guided" data-import-guided={source.id}>
      <div className="sub">
        {count > 0
          ? count === 1
            ? t("{browser} protects 1 saved password; Corvus can import it from {browser}'s own export.", { browser: source.name })
            : t("{browser} protects {n} saved passwords; Corvus can import them from {browser}'s own export.", { browser: source.name, n: n(count) })
          : t("Some passwords stayed protected; Corvus can import them from {browser}'s own export.", { browser: source.name })}
      </div>
      <div className="import-guided-actions">
        {waiting ? (
          <button className="btn small" data-import-export-cancel onClick={() => void internalApi().call("import.passwordExportCancel")}>
            {t("Stop waiting")}
          </button>
        ) : (
          <button className="btn small" data-import-export onClick={start}>
            {t("Open {browser}'s export", { browser: source.name })}
          </button>
        )}
        <DeleteCsvChoice value={deleteAfter} onChange={setDeleteAfter} />
      </div>
      {(waiting || opened === false) && (
        <div className="sub" data-import-export-waiting>
          {waiting ? `${t("Waiting for the export in your Downloads folder (a few minutes at most).")} ` : ""}
          {how}
        </div>
      )}
      {message && <div className="notice">{message}</div>}
      {result && <PasswordResult summary={result} />}
    </div>
  );
}

function resultLine(result: ImportResult): string {
  const parts: string[] = [];
  const existing = result.bookmarks?.existing ?? 0;
  if (result.bookmarks && (result.bookmarks.imported > 0 || existing === 0)) {
    parts.push(t("{n} bookmarks in {folders} folders", { n: n(result.bookmarks.imported), folders: n(result.bookmarks.folders) }));
  }
  if (result.history) parts.push(t("{n} pages of history", { n: n(result.history.imported) }));
  if (result.search) parts.push(t("{n} search shortcuts", { n: n(result.search.imported) }));
  if (result.tabs) parts.push(t("{n} open tabs saved as {windows} workspaces", { n: n(result.tabs.tabs), windows: n(result.tabs.windows) }));
  const imported = parts.length > 0 ? t("Imported {what}.", { what: parts.join(t(" and ")) }) : "";
  // Bookmarks already in Corvus (an earlier import) are not added twice: say so instead of "0 bookmarks".
  const kept = existing > 0 ? (existing === 1 ? t("1 bookmark was already in Corvus.") : t("{n} bookmarks were already in Corvus.", { n: n(existing) })) : "";
  return [imported, kept].filter(Boolean).join(" ");
}

function ProfileRow({ source, profile }: { source: ImportSource; profile: ImportProfile }) {
  const available = (kind: ImportKind): boolean => (profile.counts[kind] ?? 1) !== 0;
  const [kinds, setKinds] = useState<Record<ImportKind, boolean>>({
    bookmarks: available("bookmarks"),
    history: available("history"),
    tabs: available("tabs"),
    search: available("search"),
    passwords: available("passwords"),
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
  const label: Record<ImportKind, string> = { bookmarks: t("Bookmarks"), history: t("History"), tabs: t("Open tabs"), search: t("Search shortcuts"), passwords: t("Passwords") };
  const stillProtected = Math.max(profile.protectedPasswords ?? 0, result?.passwords?.protected ?? 0);
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
          <label key={kind} className="check" data-import-kind={kind}>
            <input type="checkbox" checked={kinds[kind]} disabled={!available(kind)} onChange={(e) => setKinds({ ...kinds, [kind]: e.target.checked })} />
            {label[kind]}
          </label>
        ))}
      </div>
      {kinds.passwords && available("passwords") && (
        <div className="sub import-passwords-note" data-import-passwords-note>
          {t("Corvus reads the passwords saved in {browser} on this computer once, now, into its encrypted vault.", { browser: source.name })}
        </div>
      )}
      {result && resultLine(result) && <div className="notice ok" data-import-result>{resultLine(result)}</div>}
      {result?.passwords && <PasswordResult summary={result.passwords} />}
      {stillProtected > 0 && <GuidedExport source={source} count={stillProtected} />}
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
 * which kinds to bring over. Bookmarks go into Corvus's bookmarks bar and Other bookmarks; history
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
  const [deleteAfter, setDeleteAfter] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const run = (): void => {
    setBusy(true);
    setError(null);
    setResult(null);
    internalApi()
      .call("import.passwordCsv", deleteAfter)
      .then(setResult)
      .catch((e: unknown) => setError(errorMessage(e)))
      .finally(() => setBusy(false));
  };
  return (
    <div className="import-passwords">
      <div className="import-passwords-head">
        <div className="grow">
          <div className="title">{t("Passwords from a file")}</div>
          <div className="sub">
            {t("Another browser or password manager can export its logins to a CSV (its password settings have an Export passwords option). Pick the file here: it goes through the same checks, so nothing older overwrites Corvus.")}
          </div>
        </div>
        <button className="btn small" disabled={busy} data-import-passwords onClick={run}>
          {busy ? t("Importing…") : t("Import a CSV…")}
        </button>
      </div>
      <DeleteCsvChoice value={deleteAfter} onChange={setDeleteAfter} />
      {result && !result.canceled && result.summary && (
        <div data-import-passwords-result>
          {result.file && (
            <div className="sub">
              {result.deleted ? t("{file} was imported and deleted.", { file: result.file }) : t("{file} was imported. Delete it when you are done: it holds your passwords in plain text.", { file: result.file })}
            </div>
          )}
          <PasswordResult summary={result.summary} />
        </div>
      )}
      {error && <div className="notice error">{error}</div>}
    </div>
  );
}
