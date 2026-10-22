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

const INTENT_LABEL: Record<MemoryIntent, string> = {
  accept_cookies: "Accept cookies",
  close_dialog: "Close popup",
  search: "Search",
  add_to_cart: "Add to cart",
  checkout: "Checkout",
  login: "Sign in",
  next_page: "Next page",
  submit: "Submit",
  other: "Other",
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
    b.runs === 0 ? `${label}: no runs yet` : `${label}: ${b.runs} run${b.runs === 1 ? "" : "s"}, avg ${b.avgSteps} steps, ${b.avgTokens.toLocaleString()} tokens`;
  const saved = w.runs > 0 && o.runs > 0 && o.avgSteps > w.avgSteps ? ` (about ${Math.round((o.avgSteps - w.avgSteps) * 10) / 10} steps saved per run)` : "";
  return (
    <p className="mem-stats">
      {part("With hints", w)}. {part("Without", o)}.{saved}
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
    <button className="mem-x" title="Forget this hint" aria-label="Forget this hint" onClick={() => onRemove(kind, k)}>
      <IconClose size={12} />
    </button>
  );
  const empty = entry.targets.length + entry.urls.length + entry.obstacles.length + entry.sequences.length === 0;
  return (
    <div className={`mem-site ${compact ? "compact" : ""}`}>
      <div className="mem-meta">
        Learned from {entry.runs} successful run{entry.runs === 1 ? "" : "s"}
        {entry.fails ? `, ${entry.fails} failed` : ""} · last {ago(entry.lastSeen)}
      </div>
      {empty && <p className="mem-empty">Nothing left to show for this site.</p>}

      {entry.obstacles.length > 0 && (
        <div className="mem-group">
          <div className="mem-group-head">Obstacles</div>
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
          <div className="mem-group-head">Elements that worked</div>
          <ul>
            {entry.targets.map((t) => (
              <li key={hintKey("target", t)} className={t.fail > 0 ? "shaky" : ""}>
                <span className={`mem-chip ${t.intent === "other" ? "" : "intent"}`}>{intentLabel(t.intent)}</span>
                <span className="mem-text">
                  {t.act === "type" ? "type into" : "click"} {t.role} <q>{t.name}</q>
                </span>
                <span className="mem-count" title={`${t.ok} worked, ${t.fail} failed`}>
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
          <div className="mem-group-head">URL shapes</div>
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
          <div className="mem-group-head">Usual order</div>
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
        <button className="btn small ghost danger mem-forget" onClick={onForget}>
          Forget this site
        </button>
      </div>
    </div>
  );
}
