import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import type { PendingSaveView } from "../../shared/credentials-ipc";
import { chromeApi } from "../common/api";
import { t } from "../common/i18n";
import { IconEye, IconEyeOff, IconLock } from "../common/icons";

interface SavePasswordProps {
  /** Opened from the key button, the prompt takes the keyboard; opened by itself, it leaves it on the page. */
  takeFocus: boolean;
  /** The prompt is done (saved, cancelled, or the save is gone); `hadFocus` when it had the keyboard. */
  onClose: (hadFocus: boolean) => void;
}

/**
 * The save-password prompt, like Brave's: the username and password the person just submitted, both
 * editable, the password masked until the eye shows it. The password comes from the main process as
 * the prompt opens and lives only in this component's state, so it is gone once the prompt closes.
 */
export function SavePasswordPrompt({ takeFocus, onClose }: SavePasswordProps) {
  const api = chromeApi();
  const id = useId();
  const [pending, setPending] = useState<Omit<PendingSaveView, "password"> | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [reveal, setReveal] = useState(false);
  const saveRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let live = true;
    void api.call("autofill.savePending").then((view) => {
      if (!live) return;
      if (!view) {
        onClose(false);
        return;
      }
      const { password: submitted, ...rest } = view;
      setPending(rest);
      setUsername(view.username);
      setPassword(submitted);
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  useEffect(() => {
    if (pending && takeFocus) saveRef.current?.focus();
  }, [pending, takeFocus]);

  if (!pending) return null;

  const updates = pending.savedUsernames.includes(username);
  const save = (): void => {
    if (!password) return;
    void api.call("autofill.saveAccept", { id: pending.id, username, password });
    onClose(document.hasFocus());
  };
  const cancel = (): void => {
    void api.call("autofill.saveDismiss", pending.id);
    onClose(document.hasFocus());
  };
  const onKeyDown = (e: KeyboardEvent<HTMLFormElement>): void => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    cancel();
  };

  return (
    <form
      className="omni-autofill-panel af-save"
      role="dialog"
      aria-labelledby={`${id}-title`}
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
      onKeyDown={onKeyDown}
    >
      <div className="af-save-head">
        <span className="af-save-icon">
          <IconLock size={16} />
        </span>
        <div className="af-save-heading">
          <div className="af-save-title" id={`${id}-title`}>
            {updates ? t("Update password?") : t("Save password?")}
          </div>
          <div className="af-save-host" title={pending.host}>
            {pending.host}
          </div>
        </div>
      </div>
      <label className="af-label" htmlFor={`${id}-user`}>
        {t("Username")}
      </label>
      <input id={`${id}-user`} className="input af-input" name="username" value={username} spellCheck={false} autoComplete="off" onChange={(e) => setUsername(e.target.value)} />
      <label className="af-label" htmlFor={`${id}-pass`}>
        {t("Password")}
      </label>
      <div className="af-password">
        <input
          id={`${id}-pass`}
          className="input af-input"
          name="password"
          type={reveal ? "text" : "password"}
          value={password}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setPassword(e.target.value)}
        />
        <button
          type="button"
          className="icon-btn af-eye"
          aria-label={reveal ? t("Hide password") : t("Show password")}
          title={reveal ? t("Hide password") : t("Show password")}
          onClick={() => setReveal((r) => !r)}
        >
          {reveal ? <IconEyeOff size={16} /> : <IconEye size={16} />}
        </button>
      </div>
      <div className="af-actions">
        <button ref={saveRef} type="submit" className="btn primary af-save-btn" disabled={!password}>
          {updates ? t("Update") : t("Save")}
        </button>
        <button type="button" className="btn ghost af-cancel" onClick={cancel}>
          {t("Cancel")}
        </button>
      </div>
      <button
        type="button"
        className="af-manage"
        onClick={() => {
          void api.call("autofill.openManager");
          onClose(false);
        }}
      >
        {t("Manage passwords")}
      </button>
    </form>
  );
}
