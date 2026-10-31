import { useEffect, useState } from "react";
import { DELETE_ARM_MS, deleteChoices, type DeleteChoice, type DeleteTarget } from "../../shared/password-tabs";
import { errorMessage, internalApi } from "../common/api";
import { t } from "../common/i18n";
import { IconTrash } from "../common/icons";
import { Modal } from "../common/modal";

/** Removes what the person chose, through the calls of the login's source. */
async function remove(target: DeleteTarget, choice: DeleteChoice): Promise<void> {
  const api = internalApi();
  if (target.source === "keepass") {
    if (choice === "totp") await api.call("keepass.removeTotp", target.id);
    else await api.call("keepass.deleteEntry", target.id);
  } else if (choice === "totp") {
    await api.call("credentials.update", target.id, { totp: "" });
  } else {
    await api.call("credentials.remove", target.id);
  }
}

/** What the first step says will go, when there is nothing to choose. */
function onlyChoiceText(target: DeleteTarget): string {
  return target.hasPassword
    ? t("Its password is deleted, and Corvus no longer fills it on the site.")
    : t("This login holds only a 2FA: deleting it deletes its 2FA secret, and Corvus no longer shows or fills its codes.");
}

/** The second step: its title, what happens, and the button that does it. */
function finalStep(target: DeleteTarget, choice: DeleteChoice): { title: string; lines: string[]; button: string } {
  const keepass = target.source === "keepass";
  const lines: string[] = [];
  if (keepass) {
    lines.push(
      choice === "totp"
        ? t("The entry keeps its password; its 2FA fields are cleared, and the previous version stays in the entry's history, as KeePass keeps it.")
        : t("Corvus moves the entry to the database's Recycle Bin, as KeePass does, or deletes it for good when the database has the Recycle Bin turned off."),
      t("Corvus keeps a .bak copy of the file before its first change."),
    );
  } else if (choice === "totp") {
    lines.push(t("The 2FA secret is deleted; the password stays. This cannot be undone."));
  } else {
    lines.push(
      !target.hasTotp
        ? t("The login and its password are deleted. This cannot be undone.")
        : target.hasPassword
          ? t("The login is deleted with its password and its 2FA. This cannot be undone.")
          : t("The login and its 2FA secret are deleted. This cannot be undone."),
    );
  }
  if (target.hasTotp) {
    lines.push(t("Before you go on, make sure you can still sign in to the site without it (another authenticator app or the site's backup codes): getting the codes back needs the site's QR code or setup key again."));
  }
  if (!keepass) lines.push(choice === "totp" ? t("With sync on, the 2FA is removed from your other devices too.") : t("With sync on, the login is removed from your other devices too."));
  if (keepass) {
    return choice === "totp"
      ? { title: t("Remove the 2FA from the KeePass entry?"), lines, button: t("Remove the 2FA") }
      : { title: t("Delete the KeePass entry?"), lines, button: t("Delete the entry") };
  }
  return choice === "totp"
    ? { title: t("Remove the 2FA for good?"), lines, button: t("Remove the 2FA for good") }
    : { title: t("Delete the login for good?"), lines, button: t("Delete for good") };
}

/**
 * Deleting a login (or only its 2FA) takes two distinct steps: the first names the login and what
 * goes, with the choice when there is one; the second says what happens and has the red button,
 * which stays off for a moment so a double click on the first step's button cannot reach it.
 * `onClose` must be stable (the Modal moves the focus whenever it changes).
 */
export function DeleteLoginDialog({ target, initial, onClose, onDone }: { target: DeleteTarget; initial: DeleteChoice; onClose: () => void; onDone: () => void }) {
  const choices = deleteChoices(target);
  const [choice, setChoice] = useState<DeleteChoice>(choices.includes(initial) ? initial : "login");
  const [step, setStep] = useState<1 | 2>(1);
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (step !== 2) return;
    const timer = setTimeout(() => setArmed(true), DELETE_ARM_MS);
    return () => clearTimeout(timer);
  }, [step]);

  const run = (): void => {
    setBusy(true);
    setError(null);
    remove(target, choice).then(onDone, (err: unknown) => {
      setError(errorMessage(err));
      setBusy(false);
    });
  };

  const keepass = target.source === "keepass";
  const login = (
    <div className="dl-login">
      <IconTrash size={15} />
      <div className="dl-login-main">
        <strong className="dl-site">{target.site || t("(no site)")}</strong>
        <span className="dl-user">{target.username || t("(no username)")}</span>
      </div>
      {keepass && <span className="pill">{target.sourceName ? `KeePass: ${target.sourceName}` : "KeePass"}</span>}
    </div>
  );

  if (step === 1) {
    return (
      <Modal
        title={keepass ? t("Delete this KeePass entry?") : t("Delete this login?")}
        onClose={onClose}
        footer={
          <>
            <button key="cancel-1" className="btn" onClick={onClose}>
              {t("Cancel")}
            </button>
            <button key="next" className="btn danger dl-next" onClick={() => setStep(2)}>
              {choice === "totp" ? t("Remove the 2FA…") : t("Delete…")}
            </button>
          </>
        }
      >
        {login}
        {choices.length > 1 ? (
          <div className="dl-choices" role="radiogroup" aria-label={t("What to delete")}>
            {choices.map((c) => (
              <label key={c} className={`dl-choice ${choice === c ? "on" : ""}`}>
                <input type="radio" name="dl-choice" value={c} checked={choice === c} onChange={() => setChoice(c)} />
                <span>
                  <strong>{c === "totp" ? t("Remove the 2FA only") : t("Delete the whole login")}</strong>
                  <span className="muted">{c === "totp" ? t("The password stays; Corvus stops showing and filling this login's 2FA codes.") : t("Its password and its 2FA are both deleted.")}</span>
                </span>
              </label>
            ))}
          </div>
        ) : (
          <p className="dl-text">{onlyChoiceText(target)}</p>
        )}
      </Modal>
    );
  }

  const last = finalStep(target, choice);
  return (
    <Modal
      title={last.title}
      onClose={onClose}
      footer={
        <>
          <button key="cancel-2" className="btn" autoFocus onClick={onClose}>
            {t("Cancel")}
          </button>
          <button key="confirm" className="btn danger-solid dl-confirm" disabled={!armed || busy} onClick={run}>
            {busy ? t("Deleting…") : last.button}
          </button>
        </>
      }
    >
      {login}
      {last.lines.map((line) => (
        <p key={line} className="dl-text">
          {line}
        </p>
      ))}
      {error && <div className="pw-error">{error}</div>}
    </Modal>
  );
}
