import { useState } from "react";
import { internalApi } from "../common/api";
import { CorvusMark } from "../common/icons";
import { mount } from "./shell";
import "./crash.css";

const params = new URLSearchParams(location.search);
const crashedUrl = params.get("url") ?? "";
const reason = params.get("reason") ?? "";
const unresponsive = reason === "unresponsive";

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

function CrashPage() {
  const [reloading, setReloading] = useState(false);
  const reload = (): void => {
    setReloading(true);
    void internalApi()
      .call("crash.reload")
      .catch(() => setReloading(false));
  };
  return (
    <div className="crash-view">
      <div className="crash-card">
        <CorvusMark size={40} />
        <h1>{unresponsive ? "This page stopped responding" : "This page crashed"}</h1>
        <p className="crash-sub">
          {unresponsive
            ? "Corvus ended the page because it became unresponsive."
            : "Something went wrong while displaying this page."}{" "}
          Your other tabs and windows are unaffected.
        </p>
        {crashedUrl && (
          <p className="crash-url" title={crashedUrl}>
            {hostOf(crashedUrl)}
          </p>
        )}
        <button className="btn primary" onClick={reload} disabled={reloading} autoFocus>
          {reloading ? "Reloading…" : "Reload page"}
        </button>
        {reason && <p className="crash-reason">Reason: {reason}</p>}
      </div>
    </div>
  );
}

mount(<CrashPage />);
