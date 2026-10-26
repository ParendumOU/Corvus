import { useCallback, useEffect, useState } from "react";
import { formatBytes, type QueueAction, type QueueItem, type QueuePackageView, type QueueView } from "../../shared/download-queue";
import type { HosterReason } from "../../shared/hosters";
import { errorMessage, internalApi } from "../common/api";
import { IconChevronDown, IconChevronRight, IconChevronUp, IconEdit, IconFolder, IconGlobe, IconPause, IconPlay, IconReload, IconTrash } from "../common/icons";

import { t } from "../common/i18n";
function duration(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return t("{minutes} min", { minutes });
  return t("{h} h {min} min", { h: Math.floor(minutes / 60), min: minutes % 60 });
}

/** Why a file host made a file wait, needs you, or failed. */
export function reasonText(reason: HosterReason | undefined): string {
  switch (reason) {
    case "captcha":
      return t("The free download needs a CAPTCHA");
    case "challenge":
      return t("The site checks that you're a person");
    case "login":
      return t("The file host asks you to sign in");
    case "premium":
      return t("Only premium accounts can download this file");
    case "password":
      return t("The file has a password");
    case "protector":
      return t("The links are behind a link protector");
    case "expired":
      return t("The download from the page stopped");
    case "limit":
      return t("Free download limit reached");
    case "quota":
      return t("The host's transfer quota is used up for now");
    case "countdown":
      return t("The host makes free downloads wait");
    case "busy":
      return t("The host is busy");
    case "offline":
      return t("The file is no longer on the host");
    case "page":
    case undefined:
      return t("Corvus didn't find the file on the page");
  }
}

function itemStatus(item: QueueItem, speed: number | undefined): string {
  const host = item.hoster ?? item.host;
  switch (item.state) {
    case "waiting":
      return t("Waiting {time} · {reason}", { time: duration(Math.max(1, Math.ceil(((item.retryAt ?? Date.now()) - Date.now()) / 1000))), reason: reasonText(item.reason) });
    case "attention":
      return t("Needs you: {reason}. Open its page, then download it there.", { reason: reasonText(item.reason) });
    case "queued":
      return item.receivedBytes > 0 ? t("Queued · {receivedBytes} so far", { receivedBytes: formatBytes(item.receivedBytes) }) : t("Queued");
    case "running": {
      if (item.resolving) return t("Looking for the file on {host}…", { host });
      const pct = item.totalBytes ? `${Math.floor((item.receivedBytes / item.totalBytes) * 100)}% · ` : "";
      const connections = item.segments && item.segments.length > 1 ? t(" · {length} connections", { length: item.segments.length }) : "";
      return `${pct}${formatBytes(item.receivedBytes)}${item.totalBytes ? t(" of {total}", { total: formatBytes(item.totalBytes) }) : ""}${speed ? ` · ${formatBytes(speed)}/s` : ""}${connections}`;
    }
    case "paused":
      return item.error ? t("Retrying soon ({error})", { error: item.error }) : item.receivedBytes > 0 ? t("Paused · {size}", { size: formatBytes(item.receivedBytes) }) : t("Paused");
    case "failed":
      return t("Failed: {error}", { error: item.reason ? reasonText(item.reason) : (item.error ?? t("unknown error")) });
    case "done":
      return t("Done · {size}", { size: formatBytes(item.receivedBytes) }) + (item.checked === "ok" ? t(" · checksum OK") : "");
  }
}

function packageStatus(pkg: QueuePackageView): string {
  const p = pkg.progress;
  const size = p.total !== null ? `${formatBytes(p.received)} of ${formatBytes(p.total)}` : formatBytes(p.received);
  const parts = [t("{done} of {count} files", { done: p.done, count: p.count }), size];
  if (pkg.speed > 0) parts.push(`${formatBytes(pkg.speed)}/s`);
  if (pkg.eta !== null) parts.push(t("{eta} left", { eta: duration(pkg.eta) }));
  if (p.attention > 0) parts.push(p.attention === 1 ? t("1 needs you") : t("{n} need you", { n: p.attention }));
  if (p.waiting > 0) parts.push(t("{n} waiting", { n: p.waiting }));
  if (p.failed > 0) parts.push(t("{failed} failed", { failed: p.failed }));
  if (pkg.addedBy) parts.push(`added by ${pkg.addedBy === "Corvus" ? t("Corvus's agent") : pkg.addedBy}`);
  return parts.join(" · ");
}

function ItemRow({ item, speed, act, openPage }: { item: QueueItem; speed: number | undefined; act: (id: string, a: QueueAction) => void; openPage: (id: string) => void }) {
  const pct = item.totalBytes ? Math.min(100, (item.receivedBytes / item.totalBytes) * 100) : item.state === "done" ? 100 : 0;
  return (
    <div className={`list-row queue-item ${item.state}`} data-queue-item={item.filename}>
      <div className="grow">
        <span className="title">{item.filename}</span>
        {item.hoster && <span className="pill queue-hoster">{item.hoster}</span>}
        <div className="sub">{itemStatus(item, speed)}</div>
        {(item.state === "running" || item.state === "paused" || item.state === "queued") && item.receivedBytes > 0 && (
          <div className="download-bar">
            <span style={{ width: `${pct}%` }} />
          </div>
        )}
      </div>
      <div className="actions">
        {item.state === "attention" && (
          <button className="btn small" data-queue-open-page={item.filename} title={item.url} onClick={() => openPage(item.id)}>
            <IconGlobe size={13} />{" "}{t("Open page")}</button>
        )}
        {(item.state === "attention" || item.state === "waiting") && (
          <button className="icon-btn" title={item.state === "waiting" ? t("Try now") : t("Look for the file again")} onClick={() => act(item.id, "retry")}>
            <IconReload size={14} />
          </button>
        )}
        {(item.state === "running" || item.state === "queued" || item.state === "waiting") && (
          <button className="icon-btn" title={t("Pause")} onClick={() => act(item.id, "pause")}>
            <IconPause size={14} />
          </button>
        )}
        {item.state === "paused" && (
          <button className="icon-btn" title={t("Resume")} onClick={() => act(item.id, "resume")}>
            <IconPlay size={14} />
          </button>
        )}
        {item.state === "failed" && (
          <button className="icon-btn" title={t("Retry")} onClick={() => act(item.id, "retry")}>
            <IconReload size={14} />
          </button>
        )}
        <button className="icon-btn" title={t("Remove")} onClick={() => act(item.id, "remove")}>
          <IconTrash size={14} />
        </button>
      </div>
    </div>
  );
}

/** Extracting a finished package's archives: progress, the result, and a password box when it needs one. */
function ExtractionRow({ pkg, extract }: { pkg: QueuePackageView; extract: (password?: string) => void }) {
  const [password, setPassword] = useState("");
  const x = pkg.extraction;
  const complete = pkg.progress.count > 0 && pkg.progress.done === pkg.progress.count;
  if (pkg.archives === 0 || (!x && !complete)) return null;
  let text: string;
  if (!x) text = pkg.archives === 1 ? t("1 archive to extract") : t("{n} archives to extract", { n: pkg.archives });
  else if (x.state === "running") text = t("Extracting… {length} of {archives}", { length: x.archives.length, archives: pkg.archives });
  else if (x.state === "done") {
    const files = x.archives.reduce((n, a) => n + (a.files ?? 0), 0);
    text = [(files === 1 ? t("Extracted 1 file") : t("Extracted {n} files", { n: files })), ...(x.password ? [t("password {password}", { password: x.password })] : []), ...(x.archives.some((a) => a.deleted) ? [t("archives deleted")] : [])].join(" · ");
  } else if (x.state === "password") text = t("The archive needs a password");
  else text = t("Extraction failed: {error}", { error: x.error ?? x.archives.find((a) => a.state === "failed")?.error ?? t("unknown error") });
  const submit = (): void => {
    extract(password || undefined);
    setPassword("");
  };
  return (
    <div className={`queue-extraction ${x?.state ?? "ready"}`} data-queue-extraction={x?.state ?? "ready"}>
      <span className="grow">{text}</span>
      {x?.state === "password" && (
        <input
          className="input"
          type="text"
          placeholder={t("Password")}
          value={password}
          spellCheck={false}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && password && submit()}
        />
      )}
      {(!x || x.state === "password" || x.state === "failed") && (
        <button className="btn small" disabled={x?.state === "password" && !password} onClick={submit}>
          {x ? t("Extract again") : t("Extract")}
        </button>
      )}
    </div>
  );
}

/** A package's name that turns into a field with the pencil (Enter saves, Escape cancels). */
export function EditableName({ name, onSave, title }: { name: string; onSave: (name: string) => void; title: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  if (draft === null) {
    return (
      <span className="pkg-name">
        <span className="title">{name}</span>
        <button className="icon-btn pkg-rename" title={title} aria-label={title} data-pkg-rename={name} onClick={() => setDraft(name)}>
          <IconEdit size={13} />
        </button>
      </span>
    );
  }
  const save = (): void => {
    const value = draft.trim();
    setDraft(null);
    if (value && value !== name) onSave(value);
  };
  return (
    <input
      className="input pkg-name-input"
      autoFocus
      value={draft}
      maxLength={120}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === "Enter") save();
        if (e.key === "Escape") setDraft(null);
      }}
    />
  );
}

const ITEMS_SHOWN = 25;
const PACKAGES_SHOWN = 10;

/**
 * Corvus's download queue: packages downloading a few files at a time, with progress and time left.
 * A package folds to its header (finished ones start folded), can be renamed (its folder moves
 * along) and shows its folder; long lists show a page at a time.
 */
export function QueueSection() {
  const api = internalApi();
  const [view, setView] = useState<QueueView | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Packages the person folded or unfolded; the others follow their state (finished = folded).
  const [folded, setFolded] = useState<Record<string, boolean>>({});
  const [itemLimit, setItemLimit] = useState<Record<string, number>>({});
  const [packageLimit, setPackageLimit] = useState(PACKAGES_SHOWN);

  const load = useCallback(() => void api.call("queue.list").then(setView), [api]);
  useEffect(() => {
    load();
    const off = api.onEvent((e) => {
      if (e.type === "downloads-changed") load();
    });
    // Speeds and time left keep moving between events.
    const timer = setInterval(load, 1000);
    return () => {
      off();
      clearInterval(timer);
    };
  }, [api, load]);

  const call = (p: Promise<unknown>): void => {
    setError(null);
    p.then(load).catch((e: unknown) => setError(errorMessage(e)));
  };
  const act = (id: string, a: QueueAction): void => call(api.call("queue.act", id, a));
  const move = (id: string, delta: -1 | 1): void => call(api.call("queue.move", id, delta));
  const openPage = (id: string): void => call(api.call("queue.openPage", id));
  const extract = (id: string, password?: string): void => call(api.call("queue.extract", id, password));

  const packages = view?.packages ?? [];
  if (packages.length === 0) return null;
  const anyDone = packages.some((p) => p.items.every((i) => i.state === "done"));
  const shownPackages = packages.slice(0, packageLimit);
  return (
    <div className="queue-section">
      <div className="inline queue-head">
        <strong>{t("Queue")}</strong>
        <span className="muted small">{packages.length === 1 ? t("1 package") : t("{n} packages", { n: packages.length })}</span>
        <span className="grow" />
        {anyDone && (
          <button className="btn small ghost" onClick={() => call(api.call("queue.clearDone"))}>
            {t("Clear finished")}
          </button>
        )}
      </div>
      {error && <div className="notice error">{error}</div>}
      {shownPackages.map((pkg, index) => {
        const p = pkg.progress;
        const active = pkg.items.some((i) => i.state === "running" || i.state === "queued" || i.state === "waiting");
        const paused = pkg.items.some((i) => i.state === "paused");
        const finished = p.count > 0 && p.done === p.count;
        const isFolded = folded[pkg.id] ?? finished;
        const limit = itemLimit[pkg.id] ?? ITEMS_SHOWN;
        const pct = p.total ? Math.min(100, (p.received / p.total) * 100) : finished ? 100 : 0;
        return (
          <div key={pkg.id} className={`card queue-package ${isFolded ? "folded" : ""} ${finished ? "finished" : ""}`} data-queue-package={pkg.name}>
            <div className="pkg-head">
              <button
                className="icon-btn pkg-fold"
                aria-expanded={!isFolded}
                title={isFolded ? t("Show files") : t("Hide files")}
                onClick={() => setFolded((f) => ({ ...f, [pkg.id]: !isFolded }))}
              >
                {isFolded ? <IconChevronRight size={15} /> : <IconChevronDown size={15} />}
              </button>
              <div className="grow pkg-info">
                <EditableName name={pkg.name} title={t("Rename (and its folder)")} onSave={(name) => call(api.call("queue.rename", pkg.id, name))} />
                <div className="sub" data-queue-status>
                  {packageStatus(pkg)}
                </div>
                {(p.done < p.count || p.received > 0) && (
                  <div className={`download-bar pkg-bar ${finished ? "done" : ""}`}>
                    <span style={{ width: `${pct}%` }} />
                  </div>
                )}
              </div>
              <div className="actions">
                {active && (
                  <button className="icon-btn" title={t("Pause package")} data-queue-pause={pkg.name} onClick={() => act(pkg.id, "pause")}>
                    <IconPause size={15} />
                  </button>
                )}
                {paused && !active && (
                  <button className="icon-btn" title={t("Resume package")} data-queue-resume={pkg.name} onClick={() => act(pkg.id, "resume")}>
                    <IconPlay size={15} />
                  </button>
                )}
                {p.failed > 0 && (
                  <button className="icon-btn" title={t("Retry failed files")} onClick={() => act(pkg.id, "retry")}>
                    <IconReload size={15} />
                  </button>
                )}
                <button className="icon-btn" title={t("Show the folder")} data-queue-folder={pkg.name} onClick={() => call(api.call("queue.openFolder", pkg.id))}>
                  <IconFolder size={15} />
                </button>
                <button className="icon-btn" title={t("Move up")} disabled={index === 0} onClick={() => move(pkg.id, -1)}>
                  <IconChevronUp size={15} />
                </button>
                <button className="icon-btn" title={t("Move down")} disabled={index === packages.length - 1} onClick={() => move(pkg.id, 1)}>
                  <IconChevronDown size={15} />
                </button>
                <button className="icon-btn" title={t("Remove package")} onClick={() => act(pkg.id, "remove")}>
                  <IconTrash size={15} />
                </button>
              </div>
            </div>
            <ExtractionRow pkg={pkg} extract={(password) => extract(pkg.id, password)} />
            {!isFolded && (
              <div className="list pkg-items">
                {pkg.items.slice(0, limit).map((item) => (
                  <ItemRow key={item.id} item={item} speed={view?.speeds[item.id]} act={act} openPage={openPage} />
                ))}
                {pkg.items.length > limit && (
                  <button className="pkg-more" onClick={() => setItemLimit((l) => ({ ...l, [pkg.id]: limit + ITEMS_SHOWN }))}>
                    {t("Show {n} more files", { n: Math.min(ITEMS_SHOWN, pkg.items.length - limit) })}
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })}
      {packages.length > packageLimit && (
        <button className="btn small" style={{ alignSelf: "center" }} onClick={() => setPackageLimit((n) => n + PACKAGES_SHOWN)}>
          {t("Show {n} more packages", { n: Math.min(PACKAGES_SHOWN, packages.length - packageLimit) })}
        </button>
      )}
    </div>
  );
}
