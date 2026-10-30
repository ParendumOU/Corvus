import { useState } from "react";
import type { TrustScope } from "../../shared/download-trust";
import type { DownloadWarning } from "../../shared/downloads";
import { t } from "./i18n";
import "./download-warning.css";

/**
 * A program the person downloaded, waiting in the bubble and on the downloads page: Keep or Discard,
 * and "Always keep .<type> files" from its site or any site. Corvus ticks that box itself once the
 * person kept the type twice, but only their Keep confirms it.
 */
export function ProgramWarning({ warning, onKeep, onDiscard }: { warning: DownloadWarning; onKeep: (always: TrustScope | null) => void; onDiscard: () => void }) {
  const [always, setAlways] = useState(warning.ticked);
  const [scope, setScope] = useState<TrustScope>(warning.site ? warning.scope : "any");
  return (
    <div className="dl-warning" data-download-warning={warning.ext}>
      <div className="dl-warning-text">
        {warning.site
          ? t("Programs can harm your computer. Keep it only if you trust {site}.", { site: warning.site })
          : t("Programs can harm your computer. Keep it only if you trust where it comes from.")}
      </div>
      {warning.canRemember && (
        <div className="dl-always">
          <label>
            <input type="checkbox" checked={always} data-download-always onChange={(e) => setAlways(e.target.checked)} />
            {t("Always keep .{ext} files", { ext: warning.ext })}
          </label>
          {warning.site ? (
            <select className="dl-scope" value={scope} disabled={!always} data-download-scope aria-label={t("Where from")} onChange={(e) => setScope(e.target.value === "any" ? "any" : "site")}>
              <option value="site">{t("from {site}", { site: warning.site })}</option>
              <option value="any">{t("from any site")}</option>
            </select>
          ) : (
            <span>{t("from any site")}</span>
          )}
        </div>
      )}
      <div className="dl-warning-actions">
        <button className="btn small danger" data-download-discard onClick={onDiscard}>{t("Discard")}</button>
        <button className="btn small" data-download-keep onClick={() => onKeep(warning.canRemember && always ? scope : null)}>{t("Keep")}</button>
      </div>
    </div>
  );
}
