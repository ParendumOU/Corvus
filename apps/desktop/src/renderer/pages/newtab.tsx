import { useEffect, useState, type FormEvent } from "react";
import type { HistoryRecord } from "../../shared/history-ops";
import { classifyOmnibox, intentToUrl } from "../../shared/omnibox";
import { internalApi } from "../common/api";
import { CorvusMark, IconAgent, IconSearch, IconSparkle } from "../common/icons";
import { Favicon, hostOf } from "../common/ui";
import { mount } from "./shell";
import "./newtab.css";

function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return "Good night";
  if (h < 12) return "Good morning";
  if (h < 19) return "Good afternoon";
  return "Good evening";
}

function NewTab() {
  const [query, setQuery] = useState("");
  const [sites, setSites] = useState<HistoryRecord[]>([]);
  const [profileName, setProfileName] = useState("");
  const [mcpRunning, setMcpRunning] = useState(false);

  useEffect(() => {
    void internalApi()
      .call("newtab.data")
      .then((d) => {
        setSites(d.topSites);
        setProfileName(d.profileName);
        setMcpRunning(d.mcpRunning);
      });
  }, []);

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    if (!query.trim()) return;
    location.href = intentToUrl(classifyOmnibox(query));
  };

  return (
    <div className="newtab">
      <div className="nt-hero">
        <CorvusMark size={64} />
        <h1>
          {greeting()}
          {profileName ? <span className="muted">, {profileName}</span> : null}
        </h1>
      </div>
      <form className="nt-search" onSubmit={submit}>
        <IconSearch size={20} />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Ask anything or type a URL" spellCheck={false} />
        <button type="submit" className="nt-ask" disabled={!query.trim()}>
          <IconSparkle size={16} />
          Ask
        </button>
      </form>
      <p className="nt-hint">Answers are grounded in live search results and cite their sources. Results load instantly; the AI answer streams on top.</p>

      {sites.length > 0 && (
        <div className="nt-sites">
          {sites.map((s) => (
            <a key={s.id} className="nt-site" href={s.url} title={s.title || s.url}>
              <span className="nt-site-icon">
                <Favicon url={s.url} src={s.faviconUrl} size={24} />
              </span>
              <span className="nt-site-name">{s.title || hostOf(s.url)}</span>
            </a>
          ))}
        </div>
      )}

      {mcpRunning && (
        <a className="nt-agent" href="corvus://settings/#agents">
          <IconAgent size={14} /> AI agents can connect to this browser via MCP
        </a>
      )}
    </div>
  );
}

mount(<NewTab />);
