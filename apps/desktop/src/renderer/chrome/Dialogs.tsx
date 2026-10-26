import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import "./dialogs.css";
import type { DialogView } from "../../shared/dialog";
import { chromeApi } from "../common/api";
import { t } from "../common/i18n";
import { IconShield, IconSparkle } from "../common/icons";

function answer(view: DialogView, button: number, checked: boolean, value: string, values?: string[]): void {
  void chromeApi().call("dialog.answer", view.id, button, checked, value, values);
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
        {view.fields?.map((field, i) => (
          <label key={i} className="dialog-field">
            <span className="dialog-field-label">{field.label}</span>
            <input
              ref={(el) => {
                fields.current[i] = el;
              }}
              className="input"
              value={values[i] ?? ""}
              placeholder={field.placeholder}
              spellCheck={false}
              data-dialog-field={i}
              aria-invalid={missing === i || undefined}
              onChange={(e) => {
                const next = [...values];
                next[i] = e.target.value;
                setValues(next);
                if (missing === i) setMissing(null);
              }}
            />
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

/** Questions that leave the page usable (an AI agent asks for a hand in it), as bars under the toolbar. */
export function DialogBars({ bars }: { bars: DialogView[] }) {
  return (
    <>
      {bars.map((view) => (
        <div key={view.id} className={`dialog-bar tone-${view.tone}`} role="status" data-dialog-bar={view.id}>
          <span className="dialog-glyph" aria-hidden>
            <IconSparkle size={15} />
          </span>
          <div className="grow dialog-bar-text">
            <strong>{view.message}</strong>
            {view.detail ? <span className="dialog-bar-detail">{view.detail.split("\n\n")[0]}</span> : null}
          </div>
          <Buttons view={view} focus={false} onPress={(button) => answer(view, button, false, "")} />
        </div>
      ))}
    </>
  );
}
