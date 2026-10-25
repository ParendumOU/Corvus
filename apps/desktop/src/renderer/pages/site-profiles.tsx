import { useCallback, useEffect, useState } from "react";
import type { AccessLevel, AIProviderKind } from "@corvus/shared";
import type { SiteProfileInput, SiteProfileMatch } from "../../shared/site-profile-ipc";
import { isValidPattern, type PromptPosition, type SiteProfile } from "../../shared/site-profiles";
import { errorMessage, internalApi } from "../common/api";
import { IconGlobe, IconPlus, IconTrash } from "../common/icons";
import "./site-profiles.css";
import { PageShell, mount } from "./shell";

import { t } from "../common/i18n";
type Api = ReturnType<typeof internalApi>;

const ACCESS_OPTIONS: Array<[string, string]> = [
  ["", t("No cap (use global access)")],
  ["read", t("Read-only (observe, no click/type)")],
  ["standard", t("Standard (allow interaction)")],
  ["full", t("Full")],
];

const PROVIDER_OPTIONS: Array<[string, string]> = [
  ["", t("Use global provider")],
  ["anthropic-api", t("Anthropic API")],
  ["claude-code-cli", t("Claude Code CLI")],
  ["local", t("Local model")],
];

interface Draft {
  pattern: string;
  label: string;
  enabled: boolean;
  promptAddendum: string;
  promptPosition: PromptPosition;
  accessCap: AccessLevel | "";
  provider: AIProviderKind | "";
  model: string;
}

function blankDraft(): Draft {
  return { pattern: "", label: "", enabled: true, promptAddendum: "", promptPosition: "append", accessCap: "", provider: "", model: "" };
}

function draftFrom(p: SiteProfile): Draft {
  return {
    pattern: p.pattern,
    label: p.label,
    enabled: p.enabled,
    promptAddendum: p.promptAddendum,
    promptPosition: p.promptPosition,
    accessCap: p.accessCap ?? "",
    provider: p.provider ?? "",
    model: p.model ?? "",
  };
}

function toInput(d: Draft): SiteProfileInput {
  return {
    pattern: d.pattern.trim(),
    label: d.label.trim(),
    enabled: d.enabled,
    promptAddendum: d.promptAddendum,
    promptPosition: d.promptPosition,
    accessCap: d.accessCap || null,
    provider: d.provider || null,
    model: d.model.trim() || null,
  };
}

function accessLabel(cap: AccessLevel | null): string {
  if (!cap) return t("No cap");
  if (cap === "read") return t("Read-only");
  if (cap === "standard") return t("Standard");
  return t("Full");
}

function SiteProfilesPage() {
  const api = internalApi();
  const [list, setList] = useState<SiteProfile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<{ id: string | null; draft: Draft } | null>(null);

  const load = useCallback(() => {
    void api.call("siteProfile.list").then(setList);
  }, [api]);
  useEffect(() => {
    load();
    return api.onEvent((e) => {
      if (e.type === "site-profiles-changed") load();
    });
  }, [api, load]);

  const run = (p: Promise<SiteProfile[]>): void => {
    setError(null);
    p.then(setList).catch((e: unknown) => setError(errorMessage(e)));
  };

  const save = (): void => {
    if (!editor) return;
    const input = toInput(editor.draft);
    if (!isValidPattern(input.pattern)) {
      setError(t("Enter a domain pattern like example.com, *.example.com or docs.example.com/api."));
      return;
    }
    const call = editor.id ? api.call("siteProfile.update", editor.id, input) : api.call("siteProfile.add", input);
    run(call.then((l) => (setEditor(null), l)));
  };

  const profiles = list ?? [];

  return (
    <PageShell
      title={t("Site AI profiles")}
      active="site-profiles"
      toolbar={
        <button className="btn small primary" onClick={() => setEditor({ id: null, draft: blankDraft() })}>
          <IconPlus size={14} />{" "}{t("New profile")}</button>
      }
    >
      {error && <div className="notice error">{error}</div>}

      {!editor && (
        <div className="card">
          <div className="card-head">
            <h2>{t("Customize the AI per website")}</h2>
            <p className="muted">{t("A profile matches a domain and narrows the AI for runs on that site: add a system-prompt note, cap the agent to read-only, or pick a different model. Caps only ever remove abilities — they never grant more than your global access. No profile means today's behavior is unchanged.")}</p>
          </div>
        </div>
      )}

      {editor && <Editor draft={editor.draft} isEdit={editor.id !== null} onChange={(draft) => setEditor({ ...editor, draft })} onSave={save} onCancel={() => (setError(null), setEditor(null))} />}

      <Tester api={api} />

      {list && profiles.length === 0 && !editor ? (
        <div className="card">
          <div className="empty">
            <IconGlobe size={26} />
            <p>{t("No site profiles yet. Create one to tailor the AI for a specific website.")}</p>
          </div>
        </div>
      ) : (
        profiles.length > 0 && (
          <div className="card">
            <div className="list">
              {profiles.map((p) => (
                <ProfileRow key={p.id} p={p} api={api} run={run} onEdit={() => setEditor({ id: p.id, draft: draftFrom(p) })} />
              ))}
            </div>
          </div>
        )
      )}
    </PageShell>
  );
}

function Editor({ draft, isEdit, onChange, onSave, onCancel }: { draft: Draft; isEdit: boolean; onChange: (d: Draft) => void; onSave: () => void; onCancel: () => void }) {
  const set = <K extends keyof Draft>(key: K, value: Draft[K]): void => onChange({ ...draft, [key]: value });
  const patternOk = !draft.pattern.trim() || isValidPattern(draft.pattern.trim());
  return (
    <div className="card">
      <div className="card-head">
        <h2>{isEdit ? t("Edit profile") : t("New profile")}</h2>
      </div>
      <div className="card-body padded sp-form">
        <label className="field">
          <span>{t("Domain pattern")}</span>
          <input className={`input mono ${patternOk ? "" : "bad"}`} placeholder={t("example.com")} spellCheck={false} value={draft.pattern} onChange={(e) => set("pattern", e.target.value)} />
          <span className="muted small">{t("Matches the domain and its subdomains. Use *.example.com for subdomains only, or add a path like example.com/app.")}</span>
        </label>
        <label className="field">
          <span>{t("Label")}</span>
          <input className="input" placeholder={t("Optional name")} value={draft.label} onChange={(e) => set("label", e.target.value)} />
        </label>
        <label className="field">
          <span>{t("System-prompt note")}</span>
          <textarea className="input sp-addendum" rows={3} placeholder={t("Extra instructions the AI follows on this site.")} value={draft.promptAddendum} onChange={(e) => set("promptAddendum", e.target.value)} />
        </label>
        <div className="field">
          <span>{t("Note position")}</span>
          <div className="segmented">
            <button className={draft.promptPosition === "append" ? "on" : ""} onClick={() => set("promptPosition", "append")}>{t("After")}</button>
            <button className={draft.promptPosition === "prepend" ? "on" : ""} onClick={() => set("promptPosition", "prepend")}>{t("Before")}</button>
          </div>
        </div>
        <label className="field">
          <span>{t("Access cap")}</span>
          <select className="input" value={draft.accessCap} onChange={(e) => set("accessCap", e.target.value as Draft["accessCap"])}>
            {ACCESS_OPTIONS.map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </select>
          <span className="muted small">{t("Read-only removes click and type from the agent on this site. A cap only narrows your global access.")}</span>
        </label>
        <label className="field">
          <span>{t("Provider")}</span>
          <select className="input" value={draft.provider} onChange={(e) => set("provider", e.target.value as Draft["provider"])}>
            {PROVIDER_OPTIONS.map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t("Model")}</span>
          <input className="input mono" placeholder={t("Leave blank for the global model")} value={draft.model} onChange={(e) => set("model", e.target.value)} />
        </label>
        <div className="sp-form-actions">
          <button className="btn small primary" disabled={!draft.pattern.trim() || !patternOk} onClick={onSave}>
            {isEdit ? t("Save changes") : t("Create profile")}
          </button>
          <button className="btn small ghost" onClick={onCancel}>{t("Cancel")}</button>
        </div>
      </div>
    </div>
  );
}

function ProfileRow({ p, api, run, onEdit }: { p: SiteProfile; api: Api; run: (pr: Promise<SiteProfile[]>) => void; onEdit: () => void }) {
  return (
    <div className={`list-row sp-row ${p.enabled ? "" : "off"}`}>
      <div className="grow sp-main">
        <div className="sp-title-row">
          <button className="link-button sp-title mono" onClick={onEdit} title={t("Edit")}>
            {p.pattern}
          </button>
          {p.label && <span className="sp-label">{p.label}</span>}
          {!p.enabled && <span className="pill sp-status off">{t("Disabled")}</span>}
        </div>
        <div className="sp-tags">
          <span className={`pill sp-tag ${p.accessCap === "read" ? "warn" : ""}`}>{accessLabel(p.accessCap)}</span>
          {p.provider && <span className="pill sp-tag">{p.provider}</span>}
          {p.model && <span className="pill sp-tag mono">{p.model}</span>}
          {p.promptAddendum.trim() && <span className="pill sp-tag">{t("prompt")}{" "}{p.promptPosition === "prepend" ? "before" : "after"}</span>}
        </div>
        {p.promptAddendum.trim() && <div className="sp-preview muted">{p.promptAddendum}</div>}
      </div>
      <div className="sp-actions">
        <label className="sp-toggle" title={p.enabled ? t("Disable") : t("Enable")}>
          <input type="checkbox" checked={p.enabled} onChange={(e) => run(api.call("siteProfile.setEnabled", p.id, e.target.checked))} />
        </label>
        <button className="icon-btn" title={t("Delete")} onClick={() => run(api.call("siteProfile.remove", p.id))}>
          <IconTrash size={15} />
        </button>
      </div>
    </div>
  );
}

function Tester({ api }: { api: Api }) {
  const [url, setUrl] = useState("");
  const [result, setResult] = useState<SiteProfileMatch | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const test = (): void => {
    setErr(null);
    setResult(null);
    const value = url.trim();
    if (!value) return;
    api
      .call("siteProfile.match", /^[a-z]+:\/\//i.test(value) ? value : `https://${value}`)
      .then(setResult)
      .catch((e: unknown) => setErr(errorMessage(e)));
  };
  return (
    <div className="card">
      <div className="card-head">
        <h2>{t("Test a URL")}</h2>
        <p className="muted">{t("See which profile a page would match and the access the agent would run at.")}</p>
      </div>
      <div className="card-body padded sp-tester">
        <div className="sp-tester-row">
          <input className="input mono" placeholder={t("https://example.com/page")} value={url} spellCheck={false} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === "Enter" && test()} />
          <button className="btn" onClick={test}>{t("Test")}</button>
        </div>
        {err && <div className="notice error">{err}</div>}
        {result && (
          <div className="sp-result">
            {result.profile ? (
              <>
                <span className="pill ok">{t("Matched")}</span>
                <span className="mono">{result.profile.pattern}</span>
                {result.profile.label && <span className="muted">{result.profile.label}</span>}
              </>
            ) : (
              <span className="pill">{t("No profile — default behavior")}</span>
            )}
            <span className="muted small">{t("access {effectiveAccess} · {provider}", { effectiveAccess: result.effectiveAccess, provider: result.provider })}{result.model ? ` · ${result.model}` : ""}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

mount(<SiteProfilesPage />);
