/**
 * The "Learned" view of one site's memory, shared by the Workflows side panel and corvus://flows:
 * what Corvus learned (obstacles, element targets by intent, URL shapes, usual step order), with a
 * remove button per hint, "Forget this site", and the with/without-hints comparison.
 */
import type { MemoryStats, MemoryHintKind, MemoryIntent, SiteMemoryEntry } from "../../shared/site-memory";
import { hintKey } from "../../shared/site-memory";
import { IconClose } from "./icons";
import { ago } from "./workflows";
import "./site-memory.css";

import { t as tx } from "./i18n";
const INTENT_LABEL: Record<MemoryIntent, string> = {
  accept_cookies: tx("Accept cookies"),
  close_dialog: tx("Close popup"),
  search: tx("Search"),
  add_to_cart: tx("Add to cart"),
  checkout: tx("Checkout"),
  login: tx("Sign in"),
  next_page: tx("Next page"),
  submit: tx("Submit"),
  other: tx("Other"),
};

export function intentLabel(intent: MemoryIntent): string {
  return INTENT_LABEL[intent] ?? intent;
}

/** "Runs with hints: 2, avg 4 steps. Without: 3, avg 7 steps." or null when there is nothing to compare. */
export function StatsLine({ stats }: { stats: MemoryStats }) {
  const w = stats.withHints;
  const o = stats.without;
  if (w.runs === 0 && o.runs === 0) return null;
  const part = (label: string, b: MemoryStats["withHints"]): string =>
    b.runs === 0 ? tx("{label}: no runs yet", { label }) : tx("{label}: runs: {runs}, avg {steps} steps, {tokens} tokens", { label, runs: b.runs, steps: b.avgSteps, tokens: b.avgTokens.toLocaleString() });
  const saved = w.runs > 0 && o.runs > 0 && o.avgSteps > w.avgSteps ? tx(" (about {n} steps saved per run)", { n: Math.round((o.avgSteps - w.avgSteps) * 10) / 10 }) : "";
  return (
    <p className="mem-stats">
      {part(tx("With hints"), w)}. {part(tx("Without"), o)}.{saved}
    </p>
  );
}

export function LearnedSite({
  entry,
  onRemove,
  onForget,
  compact,
}: {
  entry: SiteMemoryEntry;
  onRemove: (kind: MemoryHintKind, key: string) => void;
  onForget: () => void;
  compact?: boolean;
}) {
  const Remove = ({ kind, k }: { kind: MemoryHintKind; k: string }) => (
    <button className="mem-x" title={tx("Forget this hint")} aria-label={tx("Forget this hint")} onClick={() => onRemove(kind, k)}>
      <IconClose size={12} />
    </button>
  );
  const empty = entry.targets.length + entry.urls.length + entry.obstacles.length + entry.sequences.length === 0;
  return (
    <div className={`mem-site ${compact ? "compact" : ""}`}>
      <div className="mem-meta">{entry.runs === 1 ? tx("Learned from 1 successful run") : tx("Learned from {runs} successful runs", { runs: entry.runs })}
        {entry.fails ? tx(", {fails} failed", { fails: entry.fails }) : ""}{" "}{tx("· last {ago}", { ago: ago(entry.lastSeen) })}</div>
      {empty && <p className="mem-empty">{tx("Nothing left to show for this site.")}</p>}

      {entry.obstacles.length > 0 && (
        <div className="mem-group">
          <div className="mem-group-head">{tx("Obstacles")}</div>
          <ul>
            {entry.obstacles.map((o) => (
              <li key={hintKey("obstacle", o)}>
                <span className="mem-chip warn">{o.kind}</span>
                <span className="mem-text">{o.how}</span>
                <Remove kind="obstacle" k={hintKey("obstacle", o)} />
              </li>
            ))}
          </ul>
        </div>
      )}

      {entry.targets.length > 0 && (
        <div className="mem-group">
          <div className="mem-group-head">{tx("Elements that worked")}</div>
          <ul>
            {entry.targets.map((t) => (
              <li key={hintKey("target", t)} className={t.fail > 0 ? "shaky" : ""}>
                <span className={`mem-chip ${t.intent === "other" ? "" : "intent"}`}>{intentLabel(t.intent)}</span>
                <span className="mem-text">
                  {t.act === "type" ? tx("type into") : tx("click")} {t.role} <q>{t.name}</q>
                </span>
                <span className="mem-count" title={tx("{ok} worked, {fail} failed", { ok: t.ok, fail: t.fail })}>
                  {t.ok}
                  {t.fail ? `/${t.fail}` : ""}
                </span>
                <Remove kind="target" k={hintKey("target", t)} />
              </li>
            ))}
          </ul>
        </div>
      )}

      {entry.urls.length > 0 && (
        <div className="mem-group">
          <div className="mem-group-head">{tx("URL shapes")}</div>
          <ul>
            {entry.urls.map((u) => (
              <li key={hintKey("url", u)}>
                <span className="mem-chip">{u.label}</span>
                <code className="mem-text">{u.pattern}</code>
                <Remove kind="url" k={hintKey("url", u)} />
              </li>
            ))}
          </ul>
        </div>
      )}

      {entry.sequences.length > 0 && (
        <div className="mem-group">
          <div className="mem-group-head">{tx("Usual order")}</div>
          <ul>
            {entry.sequences.map((q) => (
              <li key={hintKey("sequence", q)}>
                <span className="mem-text">{q.steps.map(intentLabel).join(" → ")}</span>
                <span className="mem-count">{q.ok}</span>
                <Remove kind="sequence" k={hintKey("sequence", q)} />
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mem-actions">
        <button className="btn small ghost danger mem-forget" onClick={onForget}>{tx("Forget this site")}</button>
      </div>
    </div>
  );
}
