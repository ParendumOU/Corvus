import { useCallback, useEffect, useState } from "react";
import { PROXY_KINDS, parseProxyAddress, type ConnectionChoice, type ProxyKind, type ProxyServer, type SiteRule } from "../../shared/connections";
import type { ConnectionCheck, ConnectionsView, ProxyInputView } from "../../shared/ipc";
import { errorMessage, internalApi } from "../common/api";
import { t } from "../common/i18n";
import { IconTrash } from "../common/icons";
import { Toggle } from "../common/ui";
import "./settings-connections.css";
import { Row, Section } from "./shell";

const KIND_NAMES: Record<ProxyKind, string> = { http: "HTTP", https: "HTTPS", socks5: "SOCKS5", socks4: "SOCKS4", pac: "PAC" };

/** "system", "direct", "proxy:<id>" (and "" for "like the profile" on containers). */
const choiceValue = (c: ConnectionChoice | undefined): string => (!c ? "" : c.mode === "proxy" ? `proxy:${c.proxyId}` : c.mode);
const choiceOf = (value: string): ConnectionChoice | null =>
  value === "system" || value === "direct" ? { mode: value } : value.startsWith("proxy:") ? { mode: "proxy", proxyId: value.slice(6) } : null;

const address = (p: ProxyServer): string => (p.kind === "pac" ? (p.pacUrl ?? "") : `${p.host}:${p.port}`);

function checkText(result: ConnectionCheck): string {
  if ("error" in result) return t("No connection: {error}", { error: result.error });
  return result.country ? t("Sites see {ip} ({country})", { ip: result.ip, country: result.country }) : t("Sites see {ip}", { ip: result.ip });
}

function ChoiceSelect({ value, proxies, onChange, inherit, label }: { value: string; proxies: ProxyServer[]; onChange: (v: string) => void; inherit?: boolean; label: string }) {
  return (
    <select className="input" aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
      {inherit && <option value="">{t("Like the profile")}</option>}
      <option value="system">{t("System settings")}</option>
      <option value="direct">{t("Direct (no proxy)")}</option>
      {proxies.map((p) => (
        <option key={p.id} value={`proxy:${p.id}`}>
          {p.name}
        </option>
      ))}
    </select>
  );
}

const EMPTY: ProxyInputView = { name: "", kind: "socks5", host: "", port: 1080, username: "", password: "" };

/** Add or edit a proxy: its type and address (or a pasted "socks5://user@host:port"), and its sign-in. */
function ProxyForm({ initial, onSave, onCancel }: { initial?: ProxyServer; onSave: (input: ProxyInputView) => void; onCancel?: () => void }) {
  const [form, setForm] = useState<ProxyInputView>(
    initial ? { name: initial.name, kind: initial.kind, host: initial.host, port: initial.port, ...(initial.pacUrl ? { pacUrl: initial.pacUrl } : {}), username: initial.username ?? "" } : EMPTY,
  );
  const [where, setWhere] = useState(initial ? address(initial) : "");
  const pac = form.kind === "pac";
  const set = (patch: Partial<ProxyInputView>): void => setForm((f) => ({ ...f, ...patch }));
  const save = (): void => {
    if (pac) {
      onSave({ ...form, host: "", port: 0, pacUrl: where.trim() });
      return;
    }
    const parsed = parseProxyAddress(where.includes("://") ? where : `${form.kind}://${where}`);
    onSave({
      ...form,
      kind: parsed?.kind ?? form.kind,
      host: parsed?.host ?? "",
      port: parsed?.port ?? 0,
      ...(parsed?.username && !form.username ? { username: parsed.username } : {}),
      ...(parsed?.password && !form.password ? { password: parsed.password } : {}),
    });
    if (!initial) {
      setForm(EMPTY);
      setWhere("");
    }
  };
  return (
    <div className="proxy-form" data-proxy-form={initial?.id ?? "new"}>
      <input className="input" placeholder={t("Name (optional)")} value={form.name} maxLength={60} onChange={(e) => set({ name: e.target.value })} />
      <select className="input" aria-label={t("Proxy type")} value={form.kind} onChange={(e) => set({ kind: e.target.value as ProxyKind })}>
        {PROXY_KINDS.map((k) => (
          <option key={k} value={k}>
            {KIND_NAMES[k]}
          </option>
        ))}
      </select>
      <input
        className="input grow"
        data-proxy-address
        placeholder={pac ? t("Address of the PAC script") : t("host:port")}
        value={where}
        spellCheck={false}
        onChange={(e) => setWhere(e.target.value)}
      />
      {!pac && (
        <>
          <input className="input" placeholder={t("User (optional)")} autoComplete="off" value={form.username ?? ""} onChange={(e) => set({ username: e.target.value })} />
          <input
            className="input"
            type="password"
            autoComplete="new-password"
            placeholder={initial?.hasPassword ? t("Password (saved)") : t("Password (optional)")}
            value={form.password ?? ""}
            onChange={(e) => set({ password: e.target.value })}
          />
        </>
      )}
      <button className="btn small" data-proxy-save disabled={!where.trim()} onClick={save}>
        {initial ? t("Save") : t("Add proxy")}
      </button>
      {onCancel && (
        <button className="btn small ghost" onClick={onCancel}>
          {t("Cancel")}
        </button>
      )}
    </div>
  );
}

/** Settings → Connections: proxies, the profile's and each container's, site rules, WebRTC, and a check. */
export function ConnectionsSection() {
  const api = internalApi();
  const [view, setView] = useState<ConnectionsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, string>>({});
  const [check, setCheck] = useState<string | null>(null);
  const [pattern, setPattern] = useState("");
  const [via, setVia] = useState("direct");

  const reload = useCallback(() => void api.call("connections.get").then(setView), [api]);
  useEffect(() => {
    reload();
    return api.onEvent((e) => {
      if (e.type === "settings-changed") reload();
    });
  }, [api, reload]);

  const run = (p: Promise<ConnectionsView>): void => {
    setError(null);
    p.then(setView).catch((e: unknown) => setError(errorMessage(e)));
  };
  if (!view) return null;
  const { config, containers } = view;
  const proxies = config.proxies;

  const test = (id: string): void => {
    setTests((m) => ({ ...m, [id]: t("Testing…") }));
    void api
      .call("connections.test", id)
      .then((r) => setTests((m) => ({ ...m, [id]: checkText(r) })))
      .catch((e: unknown) => setTests((m) => ({ ...m, [id]: errorMessage(e) })));
  };
  const runCheck = (): void => {
    setCheck(t("Checking…"));
    void api
      .call("connections.check")
      .then((r) => setCheck(checkText(r)))
      .catch((e: unknown) => setCheck(errorMessage(e)));
  };
  const addRule = (): void => {
    if (!pattern.trim()) return;
    run(api.call("connections.setRules", [...config.rules, { pattern, via }]));
    setPattern("");
  };
  const removeRule = (rule: SiteRule): void => run(api.call("connections.setRules", config.rules.filter((r) => r !== rule)));
  const viaName = (v: string): string => (v === "direct" ? t("Direct (no proxy)") : (proxies.find((p) => p.id === v)?.name ?? v));

  return (
    <Section
      id="connections"
      title={t("Connections")}
      description={t("Send this profile's pages through a proxy (HTTP, HTTPS, SOCKS or a PAC script), or each container through a different one. When a proxy stops answering, its pages fail instead of going out through your own connection.")}
    >
      <Row label={t("This profile connects")} hint={t("Downloads and extensions go the same way. Sync, updates and AI services keep using this computer's connection.")}>
        <ChoiceSelect label={t("This profile connects")} value={choiceValue(config.profile)} proxies={proxies} onChange={(v) => run(api.call("connections.setProfile", choiceOf(v)!))} />
      </Row>
      {containers.length > 0 && (
        <>
          <Row label={t("Containers")} hint={t("Each container can use a proxy of its own.")} />
          <div className="list">
            {containers.map((c) => (
              <div key={c.id} className="list-row" data-connection-container={c.id}>
                <span className="grow">{c.name}</span>
                <ChoiceSelect
                  label={t("Connection of {name}", { name: c.name })}
                  inherit
                  value={choiceValue(config.containers[c.id])}
                  proxies={proxies}
                  onChange={(v) => run(api.call("connections.setContainer", c.id, choiceOf(v)))}
                />
              </div>
            ))}
          </div>
        </>
      )}
      <Row label={t("Proxies")} hint={view.keychain ? undefined : t("This system has no keychain: proxy passwords are kept until Corvus closes.")}>
        {proxies.length === 0 ? <span className="muted small">{t("No proxies yet. Add one below.")}</span> : undefined}
      </Row>
      {proxies.length > 0 && (
        <div className="list">
          {proxies.map((p) =>
            editing === p.id ? (
              <div key={p.id} className="stack">
                <ProxyForm
                  initial={p}
                  onSave={(input) => {
                    setEditing(null);
                    run(api.call("connections.saveProxy", input, p.id));
                  }}
                  onCancel={() => setEditing(null)}
                />
              </div>
            ) : (
              <div key={p.id} className="list-row" data-proxy={p.name}>
                <div className="grow">
                  <span className="title">{p.name}</span>
                  <div className="sub">
                    {KIND_NAMES[p.kind]} · {address(p)}
                    {p.username ? ` · ${p.username}` : ""}
                    {tests[p.id] ? ` · ${tests[p.id]}` : ""}
                  </div>
                </div>
                <button className="btn small ghost" data-proxy-test={p.name} onClick={() => test(p.id)}>
                  {t("Test")}
                </button>
                <button className="btn small ghost" onClick={() => setEditing(p.id)}>
                  {t("Edit")}
                </button>
                <button
                  className="btn small ghost danger"
                  title={t("Remove")}
                  onClick={() => {
                    if (window.confirm(t("Remove the “{name}” proxy?", { name: p.name }))) run(api.call("connections.removeProxy", p.id));
                  }}
                >
                  <IconTrash size={13} />
                </button>
              </div>
            ),
          )}
        </div>
      )}
      <Row label={t("Add a proxy")} hint={t("Type host:port, or paste an address such as socks5://user@host:1080.")} />
      <div className="stack">
        <ProxyForm onSave={(input) => run(api.call("connections.saveProxy", input))} />
      </div>
      <Row label={t("Site rules")} hint={t("Sites that go another way, whatever the profile uses. *.example.com covers its subdomains too.")} />
      {config.rules.length > 0 && (
        <div className="list">
          {config.rules.map((r) => (
            <div key={`${r.pattern}-${r.via}`} className="list-row" data-connection-rule={r.pattern}>
              <span className="grow">
                {r.pattern} → {viaName(r.via)}
              </span>
              <button className="btn small ghost danger" title={t("Remove")} onClick={() => removeRule(r)}>
                <IconTrash size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="stack">
        <div className="field-row">
          <input className="input" data-rule-pattern placeholder={t("*.example.com")} value={pattern} spellCheck={false} onChange={(e) => setPattern(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addRule()} />
          <select className="input" aria-label={t("Goes through")} value={via} onChange={(e) => setVia(e.target.value)}>
            <option value="direct">{t("Direct (no proxy)")}</option>
            {proxies.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <button className="btn small" data-rule-add disabled={!pattern.trim()} onClick={addRule}>
            {t("Add rule")}
          </button>
        </div>
      </div>
      <Row label={t("WebRTC")} hint={t("With a proxy, calls and other WebRTC traffic go through it too, so sites cannot see your real address.")}>
        <Toggle label={t("Keep WebRTC on the proxy")} checked={config.webrtcProtection} onChange={(on) => run(api.call("connections.setWebrtc", on))} />
      </Row>
      <Row label={t("Check connection")} hint={t("Asks Cloudflare which address this profile's pages come from.")}>
        <button className="btn small" data-connection-check onClick={runCheck}>
          {t("Check")}
        </button>
        {check && (
          <span className="small" data-connection-result>
            {check}
          </span>
        )}
      </Row>
      {error && <div className="notice error">{error}</div>}
    </Section>
  );
}
