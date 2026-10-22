import { useCallback, useEffect, useState } from "react";
import type { CredentialSummary, PasswordOptions } from "../../shared/credentials";
import { DEFAULT_PASSWORD_OPTIONS } from "../../shared/credentials";
import type { RevealedCredential } from "../../shared/credentials-ipc";
import { internalApi } from "../common/api";
import { IconCopy, IconEdit, IconLock, IconPlus, IconTrash } from "../common/icons";
import { Favicon, hostOf } from "../common/ui";
import { PageShell, mount } from "./shell";
import "./passwords.css";

interface FormState {
  id: string | null;
  origin: string;
  username: string;
  password: string;
  notes: string;
}

const EMPTY_FORM: FormState = { id: null, origin: "", username: "", password: "", notes: "" };

function PasswordsPage() {
  const api = internalApi();
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<CredentialSummary[]>([]);
  const [persisted, setPersisted] = useState(true);
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [form, setForm] = useState<FormState | null>(null);
  const [options, setOptions] = useState<PasswordOptions>(DEFAULT_PASSWORD_OPTIONS);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback((q: string) => void api.call("credentials.list", q).then(setItems), [api]);

  useEffect(() => {
    void api.call("credentials.persisted").then(setPersisted);
  }, [api]);

  useEffect(() => {
    const timer = setTimeout(() => load(query), 120);
    return () => clearTimeout(timer);
  }, [query, load]);

  useEffect(() => api.onEvent((e) => e.type === "credentials-changed" && load(query)), [api, query, load]);

  const reveal = async (id: string): Promise<void> => {
    if (revealed[id]) {
      setRevealed(({ [id]: _gone, ...rest }) => rest);
      return;
    }
    if (!window.confirm("Reveal this password?")) return;
    const cred = (await api.call("credentials.reveal", id)) as RevealedCredential;
    setRevealed((r) => ({ ...r, [id]: cred.password }));
  };

  const copyPassword = async (id: string): Promise<void> => {
    const cred = (await api.call("credentials.reveal", id)) as RevealedCredential;
    await api.call("clipboard.write", cred.password);
  };

  const openEdit = async (item: CredentialSummary): Promise<void> => {
    if (!window.confirm("Edit this login? Its password will be shown in the form.")) return;
    const cred = (await api.call("credentials.reveal", item.id)) as RevealedCredential;
    setError(null);
    setForm({ id: item.id, origin: cred.origin, username: cred.username, password: cred.password, notes: cred.notes });
  };

  const remove = (id: string): void => {
    if (!window.confirm("Delete this login? This cannot be undone.")) return;
    void api.call("credentials.remove", id).then(() => load(query));
  };

  const generate = (): void => void api.call("credentials.generate", options).then((pw) => setForm((f) => (f ? { ...f, password: pw } : f)));

  const submit = async (): Promise<void> => {
    if (!form) return;
    setError(null);
    try {
      if (form.id) await api.call("credentials.update", form.id, { origin: form.origin, username: form.username, password: form.password, notes: form.notes });
      else await api.call("credentials.add", { origin: form.origin, username: form.username, password: form.password, notes: form.notes });
      setForm(null);
      load(query);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const set = (patch: Partial<FormState>): void => setForm((f) => (f ? { ...f, ...patch } : f));
  const toggle = (key: keyof PasswordOptions): void => setOptions((o) => ({ ...o, [key]: !o[key] }));

  return (
    <PageShell
      title="Passwords"
      active="passwords"
      toolbar={
        <>
          <input className="input" placeholder="Search logins" value={query} onChange={(e) => setQuery(e.target.value)} />
          <button className="btn primary" onClick={() => {
            setError(null);
            setForm(EMPTY_FORM);
          }}>
            <IconPlus size={14} /> Add
          </button>
        </>
      }
    >
      {!persisted && (
        <div className="card">
          <div className="pw-warn">No system keychain is available, so saved logins are kept in memory for this session only and are not written to disk.</div>
        </div>
      )}

      {form && (
        <div className="card">
          <div className="card-head">
            <h2>{form.id ? "Edit login" : "Add login"}</h2>
          </div>
          <div className="card-body pw-form">
            <label className="pw-field">
              <span>Site</span>
              <input className="input" placeholder="https://example.com" value={form.origin} onChange={(e) => set({ origin: e.target.value })} />
            </label>
            <label className="pw-field">
              <span>Username</span>
              <input className="input" autoComplete="off" value={form.username} onChange={(e) => set({ username: e.target.value })} />
            </label>
            <label className="pw-field">
              <span>Password</span>
              <input className="input" type="text" autoComplete="off" value={form.password} onChange={(e) => set({ password: e.target.value })} />
            </label>
            <div className="pw-gen">
              <button className="btn small" onClick={generate}>Generate</button>
              <label className="pw-opt">
                Length
                <input className="input pw-len" type="number" min={4} max={128} value={options.length} onChange={(e) => setOptions((o) => ({ ...o, length: Number(e.target.value) || 20 }))} />
              </label>
              <label className="pw-opt"><input type="checkbox" checked={options.uppercase} onChange={() => toggle("uppercase")} /> A-Z</label>
              <label className="pw-opt"><input type="checkbox" checked={options.lowercase} onChange={() => toggle("lowercase")} /> a-z</label>
              <label className="pw-opt"><input type="checkbox" checked={options.digits} onChange={() => toggle("digits")} /> 0-9</label>
              <label className="pw-opt"><input type="checkbox" checked={options.symbols} onChange={() => toggle("symbols")} /> !@#</label>
            </div>
            <label className="pw-field">
              <span>Notes</span>
              <textarea className="input pw-notes" value={form.notes} onChange={(e) => set({ notes: e.target.value })} />
            </label>
            {error && <div className="pw-error">{error}</div>}
            <div className="pw-actions">
              <button className="btn primary" onClick={submit}>Save</button>
              <button className="btn ghost" onClick={() => setForm(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      <div className="card">
        {items.length === 0 ? (
          <div className="empty">{query ? "No logins match your search." : "No saved logins yet. Sign in to a site or add one with the Add button."}</div>
        ) : (
          <div className="list">
            {items.map((item) => (
              <div key={item.id} className="list-row" style={{ alignItems: "center" }}>
                <Favicon url={item.origin} />
                <div className="grow">
                  <div className="title">{item.username || "(no username)"}</div>
                  <div className="sub">{hostOf(item.origin)}</div>
                  {revealed[item.id] && <div className="pw-reveal">{revealed[item.id]}</div>}
                </div>
                <div className="actions">
                  <button className="btn small ghost" title="Reveal password" onClick={() => void reveal(item.id)}>
                    <IconLock size={13} /> {revealed[item.id] ? "Hide" : "Show"}
                  </button>
                  <button className="icon-btn" title="Copy password" onClick={() => void copyPassword(item.id)}>
                    <IconCopy size={15} />
                  </button>
                  <button className="icon-btn" title="Edit" onClick={() => void openEdit(item)}>
                    <IconEdit size={15} />
                  </button>
                  <button className="icon-btn" title="Delete" onClick={() => remove(item.id)}>
                    <IconTrash size={15} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </PageShell>
  );
}

mount(<PasswordsPage />);
