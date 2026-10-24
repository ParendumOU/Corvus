import { useCallback, useEffect, useState } from "react";
import type { GrabbedLink, GrabbedPackage } from "../../shared/link-grabber";
import { errorMessage, internalApi } from "../common/api";
import { IconClose, IconDownload, IconTrash } from "../common/icons";
import { hostOf } from "../common/ui";

function kindLabel(link: GrabbedLink): string {
  if (link.part !== undefined) return `part ${link.part}`;
  return link.kind === "hoster" ? "file host page" : "file";
}

function PackageCard({ pkg, act }: { pkg: GrabbedPackage; act: (call: "grabber.download" | "grabber.remove", ids: string[]) => void }) {
  const source = pkg.source === "clipboard" || pkg.source === "pasted" ? `from ${pkg.source === "clipboard" ? "copied" : "pasted"} text` : `from ${hostOf(pkg.source)}`;
  return (
    <div className="card grab-package" data-package={pkg.name}>
      <div className="grab-head">
        <div className="grow">
          <div className="title">{pkg.name}</div>
          <div className="sub">
            {pkg.links.length === 1 ? "1 file" : `${pkg.links.length} files`} · {source}
            {pkg.passwords.map((pw) => (
              <span key={pw} className="pill grab-password" title="Archive password found next to the links">
                Password: {pw}
              </span>
            ))}
          </div>
        </div>
        <div className="actions">
          <button className="btn small" data-grab-download={pkg.name} onClick={() => act("grabber.download", [pkg.id])}>
            <IconDownload size={14} /> Download
          </button>
          <button className="icon-btn" title="Remove package" onClick={() => act("grabber.remove", [pkg.id])}>
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
            <button className="icon-btn" title="Remove link" onClick={() => act("grabber.remove", [l.id])}>
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

  const load = useCallback(() => void api.call("grabber.list").then(setPackages), [api]);
  useEffect(() => {
    load();
    return api.onEvent((e) => {
      if (e.type === "downloads-changed") load();
    });
  }, [api, load]);

  const act = (call: "grabber.download" | "grabber.remove", ids: string[]): void => {
    setError(null);
    api
      .call(call, ids)
      .then((started) => {
        if (call === "grabber.download") setNotice(started === 1 ? "1 download started." : `${started} downloads started.`);
        load();
      })
      .catch((e: unknown) => setError(errorMessage(e)));
  };

  const addText = (): void => {
    setError(null);
    api
      .call("grabber.addText", text)
      .then((added) => {
        setNotice(added > 0 ? `Added ${added} ${added === 1 ? "link" : "links"}.` : "No new download links in that text.");
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
          placeholder="Paste links, or a whole post with links and its password"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="inline">
          <button className="btn small" disabled={!text.trim()} data-grab-add onClick={addText}>
            Add links
          </button>
          <span className="muted small">
            Or right-click a tab and choose Grab download links. With "Offer copied download links" on in Settings, links you copy show up in
            the toolbar.
          </span>
        </div>
      </div>
      {notice && <div className="notice">{notice}</div>}
      {error && <div className="notice error">{error}</div>}
      {all.length > 0 && (
        <div className="inline grab-all">
          <button className="btn small" onClick={() => act("grabber.download", all.map((p) => p.id))}>
            <IconDownload size={14} /> Download all
          </button>
          <button className="btn small ghost" onClick={() => void api.call("grabber.clear").then(load)}>
            Clear
          </button>
        </div>
      )}
      {packages && all.length === 0 && (
        <div className="card">
          <div className="empty">No links waiting. Grab them from a page, paste them above, or copy them with the clipboard offer on.</div>
        </div>
      )}
      {all.map((pkg) => (
        <PackageCard key={pkg.id} pkg={pkg} act={act} />
      ))}
    </>
  );
}
