import { useCallback, useEffect, useState } from "react";
import { formatBytes, type QueueAction, type QueueItem, type QueuePackageView, type QueueView } from "../../shared/download-queue";
import { errorMessage, internalApi } from "../common/api";
import { IconChevronDown, IconChevronUp, IconPause, IconPlay, IconReload, IconTrash } from "../common/icons";

import { t } from "../common/i18n";
function duration(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return t("{minutes} min", { minutes });
  return t("{h} h {min} min", { h: Math.floor(minutes / 60), min: minutes % 60 });
}

function itemStatus(item: QueueItem, speed: number | undefined): string {
  switch (item.state) {
    case "queued":
      return item.receivedBytes > 0 ? t("Queued · {receivedBytes} so far", { receivedBytes: formatBytes(item.receivedBytes) }) : t("Queued");
    case "running": {
      const pct = item.totalBytes ? `${Math.floor((item.receivedBytes / item.totalBytes) * 100)}% · ` : "";
      const connections = item.segments && item.segments.length > 1 ? t(" · {length} connections", { length: item.segments.length }) : "";
      return `${pct}${formatBytes(item.receivedBytes)}${item.totalBytes ? t(" of {total}", { total: formatBytes(item.totalBytes) }) : ""}${speed ? ` · ${formatBytes(speed)}/s` : ""}${connections}`;
    }
    case "paused":
      return item.error ? t("Retrying soon ({error})", { error: item.error }) : item.receivedBytes > 0 ? t("Paused · {size}", { size: formatBytes(item.receivedBytes) }) : t("Paused");
    case "failed":
      return t("Failed: {error}", { error: item.error ?? t("unknown error") });
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
  if (p.failed > 0) parts.push(t("{failed} failed", { failed: p.failed }));
  if (pkg.addedBy) parts.push(`added by ${pkg.addedBy === "Corvus" ? t("Corvus's agent") : pkg.addedBy}`);
  return parts.join(" · ");
}

function ItemRow({ item, speed, act }: { item: QueueItem; speed: number | undefined; act: (id: string, a: QueueAction) => void }) {
  const pct = item.totalBytes ? Math.min(100, (item.receivedBytes / item.totalBytes) * 100) : item.state === "done" ? 100 : 0;
  return (
    <div className={`list-row queue-item ${item.state}`} data-queue-item={item.filename}>
      <div className="grow">
        <span className="title">{item.filename}</span>
        <div className="sub">{itemStatus(item, speed)}</div>
        {(item.state === "running" || item.state === "paused" || item.state === "queued") && item.receivedBytes > 0 && (
          <div className="download-bar">
            <span style={{ width: `${pct}%` }} />
          </div>
        )}
      </div>
      <div className="actions">
        {(item.state === "running" || item.state === "queued") && (
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

/** Corvus's download queue: packages downloading a few files at a time, with progress and time left. */
export function QueueSection() {
  const api = internalApi();
  const [view, setView] = useState<QueueView | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  const act = (id: string, a: QueueAction): void => {
    setError(null);
    api
      .call("queue.act", id, a)
      .then(load)
      .catch((e: unknown) => setError(errorMessage(e)));
  };
  const move = (id: string, delta: -1 | 1): void => void api.call("queue.move", id, delta).then(load);
  const extract = (id: string, password?: string): void => {
    setError(null);
    api
      .call("queue.extract", id, password)
      .then(load)
      .catch((e: unknown) => setError(errorMessage(e)));
  };

  const packages = view?.packages ?? [];
  if (packages.length === 0) return null;
  const anyDone = packages.some((p) => p.items.every((i) => i.state === "done"));
  return (
    <div className="queue-section">
      <div className="inline queue-head">
        <strong>{t("Queue")}</strong>
        {anyDone && (
          <button className="btn small ghost" onClick={() => void api.call("queue.clearDone").then(load)}>{t("Clear finished")}</button>
        )}
      </div>
      {error && <div className="notice error">{error}</div>}
      {packages.map((pkg, index) => {
        const p = pkg.progress;
        const active = pkg.items.some((i) => i.state === "running" || i.state === "queued");
        const paused = pkg.items.some((i) => i.state === "paused");
        return (
          <div key={pkg.id} className="card queue-package" data-queue-package={pkg.name}>
            <div className="grab-head">
              <div className="grow">
                <div className="title">{pkg.name}</div>
                <div className="sub" data-queue-status>
                  {packageStatus(pkg)}
                </div>
                {p.total !== null && p.total > 0 && p.done < p.count && (
                  <div className="download-bar">
                    <span style={{ width: `${Math.min(100, (p.received / p.total) * 100)}%` }} />
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
            <div className="list">
              {pkg.items.map((item) => (
                <ItemRow key={item.id} item={item} speed={view?.speeds[item.id]} act={act} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
