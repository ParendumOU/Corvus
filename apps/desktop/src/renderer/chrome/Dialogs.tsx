import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import "./dialogs.css";
import { formBlocks, formBlockValue, type DialogView, type FormBlock } from "../../shared/dialog";
import { chromeApi } from "../common/api";
import { t } from "../common/i18n";
import { IconEye, IconEyeOff, IconLock, IconSettings, IconShield, IconSparkle } from "../common/icons";

function answer(view: DialogView, button: number, checked: boolean, value: string, values?: string[], choice?: number): void {
  void chromeApi().call("dialog.answer", view.id, button, checked, value, values, choice);
}

/** Buttons in order; the default one is the primary, a destructive one is red. */
function Buttons({ view, focus, onPress }: { view: DialogView; focus: boolean; onPress: (button: number) => void }) {
  return (
    <>
      {view.buttons.map((label, i) => (
        <button
          key={i}
          type="button"
          autoFocus={focus && i === view.defaultId && !view.input && !view.fields?.length}
          className={`btn ${i === view.dangerId ? "danger-solid" : i === view.defaultId ? "primary" : ""}`}
          data-dialog-button={i}
          onClick={() => onPress(i)}
        >
          {label}
        </button>
      ))}
    </>
  );
}

/**
 * The window's question (main/dialogs.ts) as a modal over everything: Enter presses the default
 * button, Escape the cancel one. Clicking outside does nothing, as with the system's box. A field
 * that may not be empty keeps the dialog open, with its message under it, until it is filled.
 */
export function DialogModal({ view }: { view: DialogView }) {
  const [checked, setChecked] = useState(view.checkbox?.checked ?? false);
  const [value, setValue] = useState(view.input?.value ?? "");
  const [values, setValues] = useState(() => view.fields?.map((f) => f.value) ?? []);
  const [missing, setMissing] = useState<number | null>(null);
  const [revealed, setRevealed] = useState<number[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const fields = useRef<Array<HTMLInputElement | null>>([]);
  // The view is a new object on every state push: focus once per dialog, not on each push.
  const hasInput = Boolean(view.input);
  const fieldCount = view.fields?.length ?? 0;
  useEffect(() => {
    const first = hasInput ? input.current : fieldCount > 0 ? fields.current[0] : null;
    first?.focus();
    first?.select();
  }, [view.id, hasInput, fieldCount]);

  const press = (button: number): void => {
    if (button !== view.cancelId) {
      const empty = view.fields?.findIndex((f, i) => f.required !== undefined && !(values[i] ?? "").trim()) ?? -1;
      if (empty >= 0) {
        setMissing(empty);
        fields.current[empty]?.focus();
        return;
      }
    }
    answer(view, button, checked, value, view.fields ? values : undefined);
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      press(view.cancelId);
    } else if (e.key === "Enter" && (e.target as HTMLElement).tagName !== "BUTTON") {
      e.preventDefault();
      press(view.defaultId);
    }
  };

  return (
    <div className="dialog-layer" onMouseDown={(e) => e.stopPropagation()}>
      <div
        key={view.id}
        className={`dialog-card tone-${view.tone}`}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={`dialog-title-${view.id}`}
        aria-describedby={`dialog-message-${view.id}`}
        onKeyDown={onKey}
      >
        <div className="dialog-head">
          {view.icon ? (
            <img className="dialog-icon" src={view.icon} alt="" width={32} height={32} />
          ) : (
            <span className="dialog-glyph" aria-hidden>
              {view.tone === "warning" || view.tone === "danger" ? <IconShield size={18} /> : <IconSparkle size={18} />}
            </span>
          )}
          <div className="dialog-titles">
            <h2 id={`dialog-title-${view.id}`}>{view.title}</h2>
            {view.origin ? <div className="dialog-origin">{t("A page asks: {host}", { host: view.origin })}</div> : null}
          </div>
        </div>
        {view.message && view.message !== view.title ? (
          <p className="dialog-message" id={`dialog-message-${view.id}`}>
            {view.message}
          </p>
        ) : (
          <span id={`dialog-message-${view.id}`} hidden />
        )}
        {view.detail ? <p className="dialog-detail">{view.detail}</p> : null}
        {view.settingsHint ? (
          <p className="dialog-settings-hint">
            <IconSettings size={14} />
            <span>{view.settingsHint.text}</span>
            <button
              type="button"
              className="dialog-settings-link"
              data-dialog-settings={view.settingsHint.section}
              onClick={() => void chromeApi().call("tabs.openUrl", `corvus://settings/#${encodeURIComponent(view.settingsHint?.section ?? "")}`, "new-tab")}
            >
              {t("Open settings")}
            </button>
          </p>
        ) : null}
        {view.input && (
          <input
            ref={input}
            className="input dialog-input"
            value={value}
            placeholder={view.input.placeholder}
            spellCheck={false}
            onChange={(e) => setValue(e.target.value)}
          />
        )}
        {view.choices?.length ? (
          <div className="dialog-choices" role="list">
            {view.choices.map((choice, i) => (
              <button
                key={i}
                type="button"
                role="listitem"
                className="dialog-choice"
                data-dialog-choice={i}
                onClick={() => answer(view, view.defaultId, checked, value, view.fields ? values : undefined, i)}
              >
                <IconLock size={15} />
                <span className="dialog-choice-label">{choice.label}</span>
                {choice.detail ? <span className="dialog-choice-detail">{choice.detail}</span> : null}
              </button>
            ))}
          </div>
        ) : null}
        {view.fields?.map((field, i) => (
          <label key={i} className="dialog-field">
            <span className="dialog-field-label">{field.label}</span>
            <span className={field.secret ? "dialog-secret" : "dialog-plain"}>
              <input
                ref={(el) => {
                  fields.current[i] = el;
                }}
                className="input"
                type={field.secret && !revealed.includes(i) ? "password" : "text"}
                value={values[i] ?? ""}
                placeholder={field.placeholder}
                spellCheck={false}
                autoComplete="off"
                data-dialog-field={i}
                aria-invalid={missing === i || undefined}
                onChange={(e) => {
                  const next = [...values];
                  next[i] = e.target.value;
                  setValues(next);
                  if (missing === i) setMissing(null);
                }}
              />
              {field.secret ? (
                <button
                  type="button"
                  className="icon-btn dialog-eye"
                  data-dialog-reveal={i}
                  aria-label={revealed.includes(i) ? t("Hide password") : t("Show password")}
                  title={revealed.includes(i) ? t("Hide password") : t("Show password")}
                  onClick={(e) => {
                    e.preventDefault();
                    setRevealed((r) => (r.includes(i) ? r.filter((x) => x !== i) : [...r, i]));
                  }}
                >
                  {revealed.includes(i) ? <IconEyeOff size={16} /> : <IconEye size={16} />}
                </button>
              ) : null}
            </span>
            {missing === i && field.required ? (
              <span className="dialog-field-error" role="alert">
                {field.required}
              </span>
            ) : null}
          </label>
        ))}
        <div className="dialog-foot">
          {view.checkbox ? (
            <label className="dialog-check">
              <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
              <span>{view.checkbox.label}</span>
            </label>
          ) : (
            <span />
          )}
          <div className="dialog-buttons">
            <Buttons view={view} focus onPress={press} />
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Questions that leave the page usable (an AI agent asks for a hand in it), as bars under the toolbar.
 * A bar about a tab that is not the active one offers to go to it, which does not answer it.
 */
export function DialogBars({ bars, activeTabId }: { bars: DialogView[]; activeTabId: string | null }) {
  return (
    <>
      {bars.map((view) => (
        <DialogBar key={view.id} view={view} activeTabId={activeTabId} />
      ))}
    </>
  );
}

function DialogBar({ view, activeTabId }: { view: DialogView; activeTabId: string | null }) {
  const blocks = view.blocks ?? [];
  const [values, setValues] = useState(() => formBlocks(blocks).map(formBlockValue));
  const [missing, setMissing] = useState<string | null>(null);
  const [copied, setCopied] = useState<number | null>(null);
  const form = formBlocks(blocks);
  const hasForm = form.length > 0;

  const setValue = (block: FormBlock, value: string): void => {
    setValues((all) => all.map((v, i) => (form[i] === block ? value : v)));
    if (missing === block.name) setMissing(null);
  };
  const valueOf = (block: FormBlock): string => values[form.indexOf(block)] ?? "";
  const press = (button: number): void => {
    if (button !== view.cancelId) {
      const empty = form.find((b) => b.kind !== "checkbox" && b.required && !valueOf(b).trim());
      if (empty) {
        setMissing(empty.name);
        return;
      }
    }
    answer(view, button, false, "", hasForm ? values : undefined);
  };
  const copy = (index: number): void => {
    void chromeApi().call("dialog.copy", view.id, index);
    setCopied(index);
    setTimeout(() => setCopied((c) => (c === index ? null : c)), 1500);
  };
  const onEnter = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    press(view.defaultId);
  };
  const error = (block: FormBlock) =>
    missing === block.name ? (
      <span className="dialog-field-error" role="alert">
        {t("Fill this in")}
      </span>
    ) : null;

  return (
    <div className={`dialog-bar tone-${view.tone}${blocks.length ? " has-blocks" : ""}`} role="status" data-dialog-bar={view.id}>
      <span className="dialog-glyph" aria-hidden>
        <IconSparkle size={15} />
      </span>
      <div className="grow dialog-bar-text">
        <strong>{view.message}</strong>
        {view.detail ? <span className="dialog-bar-detail">{view.detail.split("\n\n")[0]}</span> : null}
        {blocks.map((block, i) => {
          switch (block.kind) {
            case "text":
              return (
                <p key={i} className="dialog-bar-para">
                  {block.text}
                </p>
              );
            case "steps":
              return (
                <ol key={i} className="dialog-bar-steps">
                  {block.items.map((item, n) => (
                    <li key={n}>{item}</li>
                  ))}
                </ol>
              );
            case "copy":
              return (
                <div key={i} className="dialog-bar-copy">
                  {block.label ? <span className="dialog-field-label">{block.label}</span> : null}
                  <div className="dialog-bar-copy-row">
                    <code>{block.value}</code>
                    <button type="button" className="btn" data-dialog-copy={i} onClick={() => copy(i)}>
                      {copied === i ? t("Copied") : t("Copy")}
                    </button>
                  </div>
                </div>
              );
            case "input":
              return (
                <label key={i} className="dialog-field">
                  <span className="dialog-field-label">{block.label}</span>
                  {block.multiline ? (
                    <textarea
                      className="input"
                      rows={3}
                      value={valueOf(block)}
                      placeholder={block.placeholder}
                      spellCheck={false}
                      data-dialog-block={block.name}
                      aria-invalid={missing === block.name || undefined}
                      onChange={(e) => setValue(block, e.target.value)}
                    />
                  ) : (
                    <input
                      className="input"
                      value={valueOf(block)}
                      placeholder={block.placeholder}
                      spellCheck={false}
                      autoComplete="off"
                      data-dialog-block={block.name}
                      aria-invalid={missing === block.name || undefined}
                      onChange={(e) => setValue(block, e.target.value)}
                      onKeyDown={onEnter}
                    />
                  )}
                  {error(block)}
                </label>
              );
            case "select":
              return (
                <label key={i} className="dialog-field">
                  <span className="dialog-field-label">{block.label}</span>
                  <select
                    className="input"
                    value={valueOf(block)}
                    data-dialog-block={block.name}
                    aria-invalid={missing === block.name || undefined}
                    onChange={(e) => setValue(block, e.target.value)}
                  >
                    {block.value === undefined ? <option value="">{t("Choose one")}</option> : null}
                    {block.options.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                  {error(block)}
                </label>
              );
            case "checkbox":
              return (
                <label key={i} className="dialog-check">
                  <input type="checkbox" checked={valueOf(block) === "true"} data-dialog-block={block.name} onChange={(e) => setValue(block, String(e.target.checked))} />
                  <span>{block.label}</span>
                </label>
              );
          }
        })}
      </div>
      {view.tabId && view.tabId !== activeTabId ? (
        <button type="button" className="btn" data-dialog-goto onClick={() => void chromeApi().call("tabs.activate", view.tabId!)}>
          {t("Go to tab")}
        </button>
      ) : null}
      <Buttons view={view} focus={false} onPress={press} />
    </div>
  );
}
