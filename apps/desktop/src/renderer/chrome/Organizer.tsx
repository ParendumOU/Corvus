import { useEffect, useState, type CSSProperties } from "react";
import type { GroupColor } from "@corvus/shared";
import { GROUP_COLOR_HEX } from "../../shared/ipc";
import { GROUP_COLORS } from "../../shared/tab-strip";
import type { GroupProposal, OrganizerProposal } from "../../shared/tab-organizer";
import { chromeApi, errorMessage } from "../common/api";
import { IconClose, IconSparkle } from "../common/icons";
import { Favicon } from "../common/ui";
import "./organizer.css";

interface EditableGroup extends GroupProposal {
  key: number;
  enabled: boolean;
}

const nf = new Intl.NumberFormat();

/** AI tab organizer preview: proposed groups (editable) and duplicate tabs, applied in one go. */
export function Organizer({ dark, tabCount, onClose }: { dark: boolean; tabCount: number; onClose: () => void }) {
  const api = chromeApi();
  const [proposal, setProposal] = useState<OrganizerProposal | null>(null);
  const [groups, setGroups] = useState<EditableGroup[]>([]);
  const [closeDupes, setCloseDupes] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    api
      .call("organizer.propose")
      .then((p) => {
        if (!live) return;
        setProposal(p);
        setGroups(p.groups.map((g, i) => ({ ...g, key: i, enabled: true })));
      })
      .catch((err: unknown) => live && setError(errorMessage(err)));
    return () => {
      live = false;
    };
  }, [api]);

  const tabsById = new Map(proposal?.tabs.map((t) => [t.id, t]) ?? []);
  const patch = (key: number, p: Partial<EditableGroup>): void => setGroups((gs) => gs.map((g) => (g.key === key ? { ...g, ...p } : g)));
  const color = (c: GroupColor): string => GROUP_COLOR_HEX[c][dark ? "dark" : "light"];
  const chosen = groups.filter((g) => g.enabled && g.tabIds.length > 0);
  const dupes = proposal?.duplicates ?? [];
  const willClose = closeDupes ? dupes.map((d) => d.tabId) : [];
  const nothing = chosen.length === 0 && willClose.length === 0;

  const apply = async (): Promise<void> => {
    setBusy(true);
    try {
      await api.call(
        "organizer.apply",
        chosen.map(({ name, color: c, tabIds }) => ({ name, color: c, tabIds: tabIds.filter((id) => !willClose.includes(id)) })),
        willClose,
      );
      onClose();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <div className="organizer" role="dialog" aria-label="Organize tabs" onMouseDown={(e) => e.stopPropagation()}>
      <header className="org-head">
        <span className="org-mark">
          <IconSparkle size={16} />
        </span>
        <div className="grow">
          <h2>Organize tabs</h2>
          <p>
            {!proposal
              ? `Reading ${tabCount} tab titles…`
              : proposal.source === "ai"
                ? "Grouped by topic. Rename, recolor or drop anything before you apply."
                : "Grouped by site."}
          </p>
        </div>
        <button className="icon-btn" title="Close" onClick={onClose}>
          <IconClose size={14} />
        </button>
      </header>

      {!proposal && !error && (
        <div className="org-loading" aria-label="Loading">
          {[0, 1, 2].map((i) => (
            <div key={i} className="org-skeleton" style={{ animationDelay: `${i * 120}ms` }} />
          ))}
        </div>
      )}
      {error && <p className="org-error">{error}</p>}

      {proposal && (
        <div className="org-body">
          {proposal.note && <p className="org-note">{proposal.note}</p>}
          {groups.length === 0 && dupes.length === 0 && <p className="org-empty">Nothing to tidy up: no topics or duplicate tabs found.</p>}
          {groups.map((g) => (
            <section key={g.key} className={`org-group ${g.enabled ? "" : "off"}`} style={{ "--g": color(g.color) } as CSSProperties}>
              <div className="org-group-head">
                <input
                  type="checkbox"
                  checked={g.enabled}
                  aria-label={`Create group ${g.name}`}
                  onChange={(e) => patch(g.key, { enabled: e.target.checked })}
                />
                <input className="org-name" value={g.name} maxLength={40} onChange={(e) => patch(g.key, { name: e.target.value })} aria-label="Group name" />
                <div className="org-colors" role="radiogroup" aria-label="Group color">
                  {GROUP_COLORS.map((c) => (
                    <button
                      key={c}
                      role="radio"
                      aria-checked={g.color === c}
                      title={c}
                      className={`org-color ${g.color === c ? "on" : ""}`}
                      style={{ "--c": color(c) } as CSSProperties}
                      onClick={() => patch(g.key, { color: c })}
                    />
                  ))}
                </div>
              </div>
              <ul className="org-tabs">
                {g.tabIds.map((id) => {
                  const t = tabsById.get(id);
                  if (!t) return null;
                  return (
                    <li key={id}>
                      <Favicon url={t.url} {...(t.faviconUrl ? { src: t.faviconUrl } : {})} size={14} />
                      <span className="org-tab-title">{t.title || t.url}</span>
                      <button className="org-x" title="Leave out of this group" onClick={() => patch(g.key, { tabIds: g.tabIds.filter((x) => x !== id) })}>
                        <IconClose size={11} />
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}

          {dupes.length > 0 && (
            <section className="org-dupes">
              <label className="org-dupes-head">
                <input type="checkbox" checked={closeDupes} onChange={(e) => setCloseDupes(e.target.checked)} />
                <span>
                  Close {dupes.length} duplicate {dupes.length === 1 ? "tab" : "tabs"}
                </span>
              </label>
              <ul className="org-tabs">
                {dupes.map((d) => (
                  <li key={d.tabId}>
                    <Favicon url={d.url} size={14} />
                    <span className="org-tab-title">{d.title || d.url}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}

      <footer className="org-foot">
        <span className="org-usage">
          {proposal?.usage
            ? proposal.usage.cached
              ? "From cache, no tokens used"
              : `${nf.format(proposal.usage.inputTokens)} tokens in, ${nf.format(proposal.usage.outputTokens)} out`
            : proposal
              ? "No AI tokens used"
              : ""}
        </span>
        <button className="btn small" onClick={onClose}>
          Cancel
        </button>
        <button className="btn small primary" disabled={!proposal || nothing || busy} onClick={() => void apply()}>
          {chosen.length > 0 ? `Create ${chosen.length} ${chosen.length === 1 ? "group" : "groups"}` : willClose.length > 0 ? "Close duplicates" : "Apply"}
        </button>
      </footer>
    </div>
  );
}
