import { useState } from "react";
import { internalApi } from "../common/api";
import { CorvusMark } from "../common/icons";
import { t } from "../common/i18n";
import { mount } from "./shell";
import "./crash.css";

const params = new URLSearchParams(location.search);
const failedUrl = params.get("url") ?? "";
const code = params.get("code") ?? "";

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

document.title = t("Website not available");

function NetErrorPage() {
  const [retrying, setRetrying] = useState(false);
  const retry = (): void => {
    setRetrying(true);
    void internalApi()
      .call("netError.retry")
      .catch(() => setRetrying(false));
  };
  return (
    <div className="crash-view">
      <div className="crash-card">
        <CorvusMark size={40} />
        <h1>{t("Website not available right now")}</h1>
        {failedUrl && (
          <p className="crash-url" title={failedUrl}>
            {hostOf(failedUrl)}
          </p>
        )}
        <button className="btn primary" onClick={retry} disabled={retrying} autoFocus>
          {retrying ? t("Reloading…") : t("Try again")}
        </button>
        {code && <p className="crash-reason">{code}</p>}
      </div>
    </div>
  );
}

mount(<NetErrorPage />);
