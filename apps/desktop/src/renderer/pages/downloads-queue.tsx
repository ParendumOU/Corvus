import { useCallback, useEffect, useState } from "react";
import { formatBytes, type QueueAction, type QueueItem, type QueuePackageView, type QueueView } from "../../shared/download-queue";
import { errorMessage, internalApi } from "../common/api";
import { IconChevronDown, IconChevronUp, IconPause, IconPlay, IconReload, IconTrash } from "../common/icons";

function duration(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

function itemStatus(item: QueueItem, speed: number | undefined): string {
  switch (item.state) {
    case "queued":
      return item.receivedBytes > 0 ? `Queued · ${formatBytes(item.receivedBytes)} so far` : "Queued";
    case "running": {
      const pct = item.totalBytes ? `${Math.floor((item.receivedBytes / item.totalBytes) * 100)}% · ` : "";
      const connections = item.segments && item.segments.length > 1 ? ` · ${item.segments.length} connections` : "";
      return `${pct}${formatBytes(item.receivedBytes)}${item.totalBytes ? ` of ${formatBytes(item.totalBytes)}` : ""}${speed ? ` · ${formatBytes(speed)}/s` : ""}${connections}`;
    }
    case "paused":
      return item.error ? `Retrying soon (${item.error})` : `Paused${item.receivedBytes > 0 ? ` · ${formatBytes(item.receivedBytes)}` : ""}`;
    case "failed":
      return `Failed: ${item.error ?? "unknown error"}`;
    case "done":
      return `Done · ${formatBytes(item.receivedBytes)}${item.checked === "ok" ? " · checksum OK" : ""}`;
  }
}

function packageStatus(pkg: QueuePackageView): string {
  const p = pkg.progress;
  const size = p.total !== null ? `${formatBytes(p.received)} of ${formatBytes(p.total)}` : formatBytes(p.received);
  const parts = [`${p.done} of ${p.count} files`, size];
  if (pkg.speed > 0) parts.push(`${formatBytes(pkg.speed)}/s`);
  if (pkg.eta !== null) parts.push(`${duration(pkg.eta)} left`);
  if (p.failed > 0) parts.push(`${p.failed} failed`);
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
          <button className="icon-btn" title="Pause" onClick={() => act(item.id, "pause")}>
            <IconPause size={14} />
          </button>
        )}
        {item.state === "paused" && (
          <button className="icon-btn" title="Resume" onClick={() => act(item.id, "resume")}>
            <IconPlay size={14} />
          </button>
        )}
        {item.state === "failed" && (
          <button className="icon-btn" title="Retry" onClick={() => act(item.id, "retry")}>
            <IconReload size={14} />
          </button>
        )}
        <button className="icon-btn" title="Remove" onClick={() => act(item.id, "remove")}>
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
  const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;
  let text: string;
  if (!x) text = `${plural(pkg.archives, "archive")} to extract`;
  else if (x.state === "running") text = `Extracting… ${x.archives.length} of ${pkg.archives}`;
  else if (x.state === "done") {
    const files = x.archives.reduce((n, a) => n + (a.files ?? 0), 0);
    text = [`Extracted ${plural(files, "file")}`, ...(x.password ? [`password ${x.password}`] : []), ...(x.archives.some((a) => a.deleted) ? ["archives deleted"] : [])].join(" · ");
  } else if (x.state === "password") text = "The archive needs a password";
  else text = `Extraction failed: ${x.error ?? x.archives.find((a) => a.state === "failed")?.error ?? "unknown error"}`;
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
          placeholder="Password"
          value={password}
          spellCheck={false}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && password && submit()}
        />
      )}
      {(!x || x.state === "password" || x.state === "failed") && (
        <button className="btn small" disabled={x?.state === "password" && !password} onClick={submit}>
          {x ? "Extract again" : "Extract"}
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
        <strong>Queue</strong>
        {anyDone && (
          <button className="btn small ghost" onClick={() => void api.call("queue.clearDone").then(load)}>
            Clear finished
          </button>
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
                  <button className="icon-btn" title="Pause package" data-queue-pause={pkg.name} onClick={() => act(pkg.id, "pause")}>
                    <IconPause size={15} />
                  </button>
                )}
                {paused && !active && (
                  <button className="icon-btn" title="Resume package" data-queue-resume={pkg.name} onClick={() => act(pkg.id, "resume")}>
                    <IconPlay size={15} />
                  </button>
                )}
                {p.failed > 0 && (
                  <button className="icon-btn" title="Retry failed files" onClick={() => act(pkg.id, "retry")}>
                    <IconReload size={15} />
                  </button>
                )}
                <button className="icon-btn" title="Move up" disabled={index === 0} onClick={() => move(pkg.id, -1)}>
                  <IconChevronUp size={15} />
                </button>
                <button className="icon-btn" title="Move down" disabled={index === packages.length - 1} onClick={() => move(pkg.id, 1)}>
                  <IconChevronDown size={15} />
                </button>
                <button className="icon-btn" title="Remove package" onClick={() => act(pkg.id, "remove")}>
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
