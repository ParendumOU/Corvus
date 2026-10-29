import { useState } from "react";
import { internalApi } from "../common/api";
import { IconWarning } from "../common/icons";
import type { CertBlockReason, CertErrorKind } from "../../shared/cert-errors";
import { mount } from "./shell";
import "./cert-error.css";

import { t } from "../common/i18n";
const params = new URLSearchParams(location.search);
const url = params.get("url") ?? "";
const code = params.get("code") ?? "";
const kind = (params.get("kind") ?? "other") as CertErrorKind;
const block = params.get("block") as CertBlockReason | null;

function hostOf(value: string): string {
  try {
    return new URL(value).host || value;
  } catch {
    return value;
  }
}

/** What is wrong with the certificate, in a sentence or two. */
function explanation(host: string): string {
  switch (kind) {
    case "authority":
      return t("The certificate of {host} was not issued by an authority your computer trusts. Routers and other home devices often use certificates like this, but so can someone intercepting your connection.", { host });
    case "expired":
      return t("The certificate of {host} has expired. The site may be misconfigured, or your computer's date and time may be wrong.", { host });
    case "not-yet-valid":
      return t("The certificate of {host} is not valid yet. Check that your computer's date and time are right.", { host });
    case "date":
      return t("The certificate of {host} is outside its valid dates. Check that your computer's date and time are right.", { host });
    case "name":
      return t("The certificate was issued for another site, not for {host}. The site may be misconfigured, or someone may be intercepting your connection.", { host });
    case "revoked":
      return t("The certificate of {host} was revoked by whoever issued it, so it can no longer be trusted.", { host });
    case "weak":
      return t("The certificate of {host} uses weak security (an outdated signature or a key that is too short).", { host });
    case "invalid":
      return t("The certificate of {host} is damaged or not valid.", { host });
    case "transparency":
      return t("The certificate of {host} was not made public as Certificate Transparency requires.", { host });
    case "pinned":
      return t("The certificate of {host} is not one this site is known to use.", { host });
    case "interception":
      return t("Software on your computer or network is intercepting your connection with a certificate known to be used for that.");
    default:
      return t("The certificate of {host} cannot be trusted.", { host });
  }
}

function CertErrorPage() {
  const host = hostOf(url);
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const act = (method: "certError.back" | "certError.proceed"): void => {
    setBusy(true);
    void internalApi()
      .call(method)
      .catch(() => undefined)
      .finally(() => setBusy(false));
  };
  return (
    <main className="cert-view">
      <div className="cert-card">
        <div className="cert-icon" aria-hidden="true">
          <IconWarning size={30} />
        </div>
        <h1>{t("Your connection is not private")}</h1>
        <p className="cert-lead">
          {t("Someone could be trying to steal your information from {host} (for example passwords, messages or card numbers).", { host })}
        </p>
        <p className="cert-code">{code}</p>
        <div className="cert-actions">
          <button className="btn ghost cert-advanced" aria-expanded={advanced} onClick={() => setAdvanced((v) => !v)}>
            {advanced ? t("Hide advanced") : t("Advanced")}
          </button>
          <button className="btn primary" onClick={() => act("certError.back")} disabled={busy} autoFocus>
            {t("Back to safety")}
          </button>
        </div>
        {advanced && (
          <section className="cert-details">
            <p>{explanation(host)}</p>
            <dl>
              <dt>{t("Site")}</dt>
              <dd>{host}</dd>
              <dt>{t("Error code")}</dt>
              <dd>{code}</dd>
            </dl>
            {block === "hsts" ? (
              <p className="cert-blocked">
                {t("You cannot visit {host} right now because the site uses HSTS, which asks browsers to always reach it securely. Network errors and attacks are usually temporary, so this page will probably work later.", { host })}
              </p>
            ) : block === "fatal" ? (
              <p className="cert-blocked">{t("You cannot visit {host} right now because its certificate cannot be accepted.", { host })}</p>
            ) : (
              <button className="cert-proceed" onClick={() => act("certError.proceed")} disabled={busy}>
                {t("Proceed to {host} (unsafe)", { host })}
              </button>
            )}
          </section>
        )}
      </div>
    </main>
  );
}

mount(<CertErrorPage />);
