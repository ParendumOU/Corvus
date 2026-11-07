import { lockSecretProblem, type LockKind } from "../../shared/profile-lock";
import { t } from "./i18n";

/** Why a PIN or password cannot be a profile lock's, in the UI's language; null when it can. */
export function lockProblemText(kind: LockKind, secret: string): string | null {
  switch (lockSecretProblem(kind, secret)) {
    case "too-long":
      return t("That is too long.");
    case "pin":
      return t("A PIN has at least 6 digits, and only digits.");
    case "password":
      return t("A password has at least 8 characters.");
    default:
      return null;
  }
}
