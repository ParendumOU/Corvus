import { useEffect, useState } from "react";
import { GROUP_COLOR_HEX } from "../../shared/ipc";
import type { RemoteDeviceTabs } from "../../shared/open-tabs";
import { internalApi } from "../common/api";
import { Favicon, hostOf } from "../common/ui";

function updated(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** "Tabs from other devices" on corvus://history, from the synced `open_tabs` collection. */
export function RemoteTabs() {
  const [devices, setDevices] = useState<RemoteDeviceTabs[]>([]);

  useEffect(() => {
    void internalApi()
      .call("sync.remoteTabs")
      .then(setDevices)
      .catch(() => setDevices([]));
  }, []);

  const withTabs = devices.filter((d) => d.tabs.length > 0);
  if (withTabs.length === 0) return null;
  return (
    <div className="card remote-tabs">
      <div className="day-head">Tabs from other devices</div>
      {withTabs.map((d) => (
        <div key={d.deviceId} className="list">
          <div className="list-row">
            <strong>{d.device}</strong>
            <span className="muted small grow">
              {d.platform} · updated {updated(d.updatedAt)}
            </span>
          </div>
          {d.tabs.map((t, i) => (
            <div key={`${i}-${t.url}`} className="list-row">
              <Favicon url={t.url} />
              <div className="grow">
                <a className="title" href={t.url} title={t.url}>
                  {t.title || t.url}
                </a>
                <div className="sub">
                  {hostOf(t.url)}
                  {t.pinned ? " · pinned" : ""}
                  {t.group && (
                    <>
                      {" · "}
                      <span
                        aria-hidden="true"
                        style={{ display: "inline-block", width: 8, height: 8, borderRadius: 4, background: GROUP_COLOR_HEX[t.group.color].light }}
                      />{" "}
                      {t.group.title || "Group"}
                    </>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
