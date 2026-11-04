import { useEffect, useId, useRef, type KeyboardEvent } from "react";
import type { AutofillBarState } from "../../shared/credentials-ipc";
import { chromeApi } from "../common/api";
import { t } from "../common/i18n";
import { IconCard, IconLocation } from "../common/icons";

interface SaveAddressProps {
  save: NonNullable<AutofillBarState["addressSave"]>;
  /** A sent card form (never its CVV) instead of an address. */
  kind?: "address" | "card";
  /** Opened from the omnibox button, the prompt takes the keyboard; opened by itself, it leaves it on the page. */
  takeFocus: boolean;
  /** The prompt is done (saved or not now); `hadFocus` when it had the keyboard. */
  onClose: (hadFocus: boolean) => void;
}

/** The prompt to save the address (or card) just sent in a form, or to update the saved one it changed. */
export function SaveAddressPrompt({ save, kind = "address", takeFocus, onClose }: SaveAddressProps) {
  const api = chromeApi();
  const id = useId();
  const saveRef = useRef<HTMLButtonElement>(null);
  const updates = save.kind === "update";
  const card = kind === "card";

  useEffect(() => {
    void api.call(card ? "autofill.cardSaveShown" : "autofill.addressSaveShown", save.id);
    if (takeFocus) saveRef.current?.focus();
  }, [save.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const accept = (): void => {
    void api.call(card ? "autofill.cardSaveAccept" : "autofill.addressSaveAccept", save.id);
    onClose(document.hasFocus());
  };
  const dismiss = (): void => {
    void api.call(card ? "autofill.cardSaveDismiss" : "autofill.addressSaveDismiss", save.id);
    onClose(document.hasFocus());
  };
  const onKeyDown = (e: KeyboardEvent<HTMLFormElement>): void => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    dismiss();
  };

  return (
    <form
      className="omni-autofill-panel af-save"
      role="dialog"
      aria-labelledby={`${id}-title`}
      onSubmit={(e) => {
        e.preventDefault();
        accept();
      }}
      onKeyDown={onKeyDown}
    >
      <div className="af-save-head">
        <span className="af-save-icon">
          {card ? <IconCard size={16} /> : <IconLocation size={16} />}
        </span>
        <div className="af-save-heading">
          <div className="af-save-title" id={`${id}-title`}>
            {card ? (updates ? t("Update this card?") : t("Save this card?")) : updates ? t("Update this address?") : t("Save this address?")}
          </div>
          <div className="af-save-host" title={save.line}>
            {save.line}
          </div>
        </div>
      </div>
      <div className="af-actions">
        <button ref={saveRef} type="submit" className="btn primary af-save-btn">
          {updates ? t("Update") : t("Save")}
        </button>
        <button type="button" className="btn ghost af-cancel" onClick={dismiss}>
          {t("Not now")}
        </button>
      </div>
    </form>
  );
}
