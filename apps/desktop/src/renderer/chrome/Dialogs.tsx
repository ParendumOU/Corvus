import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import "./dialogs.css";
import type { DialogView } from "../../shared/dialog";
import { chromeApi } from "../common/api";
import { t } from "../common/i18n";
import { IconShield, IconSparkle } from "../common/icons";

function answer(view: DialogView, button: number, checked: boolean, value: string): void {
  void chromeApi().call("dialog.answer", view.id, button, checked, value);
}

/** Buttons in order; the default one is the primary, a destructive one is red. */
function Buttons({ view, checked, value, focus }: { view: DialogView; checked: boolean; value: string; focus: boolean }) {
  return (
    <>
      {view.buttons.map((label, i) => (
        <button
          key={i}
          type="button"
          autoFocus={focus && i === view.defaultId && !view.input}
          className={`btn ${i === view.dangerId ? "danger-solid" : i === view.defaultId ? "primary" : ""}`}
          data-dialog-button={i}
          onClick={() => answer(view, i, checked, value)}
        >
          {label}
        </button>
      ))}
    </>
  );
}

/**
 * The window's question (main/dialogs.ts) as a modal over everything: Enter presses the default
 * button, Escape the cancel one. Clicking outside does nothing, as with the system's box.
 */
export function DialogModal({ view }: { view: DialogView }) {
  const [checked, setChecked] = useState(view.checkbox?.checked ?? false);
  const [value, setValue] = useState(view.input?.value ?? "");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (view.input) {
      input.current?.focus();
      input.current?.select();
    }
  }, [view.id, view.input]);

  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      answer(view, view.cancelId, checked, value);
    } else if (e.key === "Enter" && (e.target as HTMLElement).tagName !== "BUTTON") {
      e.preventDefault();
      answer(view, view.defaultId, checked, value);
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
            <Buttons view={view} checked={checked} value={value} focus />
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
          <Buttons view={view} checked={false} value="" focus={false} />
        </div>
      ))}
    </>
  );
}
