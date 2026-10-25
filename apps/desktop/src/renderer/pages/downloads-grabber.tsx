import { useCallback, useEffect, useState } from "react";
import { hosterFor } from "../../shared/hosters";
import type { GrabbedLink, GrabbedPackage } from "../../shared/link-grabber";
import { errorMessage, internalApi } from "../common/api";
import { IconAgent, IconClose, IconDownload, IconTrash } from "../common/icons";
import { hostOf } from "../common/ui";

import { t } from "../common/i18n";
type GrabberCall = "grabber.download" | "grabber.downloadWithAi" | "grabber.remove";

function kindLabel(link: GrabbedLink): string {
  if (link.part !== undefined) return t("part {part}", { part: link.part });
  if (link.kind !== "hoster") return t("file");
  return hosterFor(link.url)?.name ?? t("page");
}

function PackageCard({ pkg, act }: { pkg: GrabbedPackage; act: (call: GrabberCall, ids: string[]) => void }) {
  const source = pkg.source === "clipboard" || pkg.source === "pasted" ? `from ${pkg.source === "clipboard" ? "copied" : "pasted"} text` : `from ${hostOf(pkg.source)}`;
  return (
    <div className="card grab-package" data-package={pkg.name}>
      <div className="grab-head">
        <div className="grow">
          <div className="title">{pkg.name}</div>
          <div className="sub">
            {pkg.links.length === 1 ? t("1 file") : t("{length} files", { length: pkg.links.length })} · {source}
            {pkg.passwords.map((pw) => (
              <span key={pw} className="pill grab-password" title={t("Archive password found next to the links")}>{t("Password: {pw}", { pw })}</span>
            ))}
          </div>
        </div>
        <div className="actions">
          <button className="btn small" data-grab-download={pkg.name} onClick={() => act("grabber.download", [pkg.id])}>
            <IconDownload size={14} />{" "}{t("Download")}</button>
          <button
            className="btn small"
            data-grab-ai={pkg.name}
            title={t("Corvus's agent goes through the file-host pages and mirrors, finds the real files and queues them once you approve")}
            onClick={() => act("grabber.downloadWithAi", [pkg.id])}
          >
            <IconAgent size={14} />{" "}{t("With AI")}</button>
          <button className="icon-btn" title={t("Remove package")} onClick={() => act("grabber.remove", [pkg.id])}>
            <IconTrash size={15} />
          </button>
        </div>
      </div>
      <div className="list">
        {pkg.links.map((l) => (
          <div key={l.id} className="list-row grab-link">
            <div className="grow">
              <span className="title">{l.filename || l.url}</span>
              <div className="sub">
                <a href={l.url} title={l.url}>
                  {l.host}
                </a>{" "}
                · {kindLabel(l)}
              </div>
            </div>
            <button className="icon-btn" title={t("Remove link")} onClick={() => act("grabber.remove", [l.id])}>
              <IconClose size={14} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

/** The link grabber: download links collected from pages and copied text, grouped into packages. */
export function GrabberView() {
  const api = internalApi();
  const [packages, setPackages] = useState<GrabbedPackage[] | null>(null);
  const [text, setText] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [watching, setWatching] = useState<boolean | null>(null);
  useEffect(() => void api.call("grabber.watchClipboard").then(setWatching), [api]);
  const toggleWatch = (on: boolean): void => void api.call("grabber.watchClipboard", on).then(setWatching);

  const load = useCallback(() => void api.call("grabber.list").then(setPackages), [api]);
  useEffect(() => {
    load();
    return api.onEvent((e) => {
      if (e.type === "downloads-changed") load();
    });
  }, [api, load]);

  const act = (call: GrabberCall, ids: string[]): void => {
    setError(null);
    api
      .call(call, ids)
      .then((started) => {
        if (call === "grabber.download") setNotice(started === 1 ? t("1 download started.") : t("{started} downloads started.", { started: String(started) }));
        if (call === "grabber.downloadWithAi" && started) setNotice(t("Corvus's agent is looking for the files. Approve the list in the Command Bar to start them."));
        load();
      })
      .catch((e: unknown) => setError(errorMessage(e)));
  };

  const addText = (): void => {
    setError(null);
    api
      .call("grabber.addText", text)
      .then((added) => {
        setNotice(added > 0 ? added === 1 ? t("Added 1 link.") : t("Added {added} links.", { added }) : t("No new download links in that text."));
        if (added > 0) setText("");
        load();
      })
      .catch((e: unknown) => setError(errorMessage(e)));
  };

  const all = packages ?? [];
  return (
    <>
      <div className="card grab-add">
        <textarea
          className="input"
          data-grab-text
          rows={3}
          placeholder={t("Paste links, or a whole post with links and its password")}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="inline">
          <button className="btn small" disabled={!text.trim()} data-grab-add onClick={addText}>{t("Add links")}</button>
          <span className="muted small grow">{t("Or right-click a link (Add link to download queue), a selection or a tab (Grab download links).")}</span>
          {watching !== null && (
            <label className="inline small grab-watch" title={t("Corvus looks at what you copy for download links (file hosts, archives) and offers them in the toolbar. Nothing else is kept.")}>
              <input type="checkbox" data-grab-watch checked={watching} onChange={(e) => toggleWatch(e.target.checked)} />
              {t("Detect links I copy")}
            </label>
          )}
        </div>
      </div>
      {notice && <div className="notice">{notice}</div>}
      {error && <div className="notice error">{error}</div>}
      {all.length > 0 && (
        <div className="inline grab-all">
          <button className="btn small" onClick={() => act("grabber.download", all.map((p) => p.id))}>
            <IconDownload size={14} />{" "}{t("Download all")}</button>
          <button className="btn small ghost" onClick={() => void api.call("grabber.clear").then(load)}>{t("Clear")}</button>
        </div>
      )}
      {packages && all.length === 0 && (
        <div className="card">
          <div className="empty">{t("No links waiting. Grab them from a page, paste them above, or copy them with “Detect links I copy” on.")}</div>
        </div>
      )}
      {all.map((pkg) => (
        <PackageCard key={pkg.id} pkg={pkg} act={act} />
      ))}
    </>
  );
}
