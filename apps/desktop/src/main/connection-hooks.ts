import { app } from "electron";
import type { ProfileRegistry } from "./profiles";

/**
 * Proxies of every profile: their sign-in when Chromium asks for it, and WebRTC kept on the proxy
 * for the pages of proxied sessions (no direct UDP showing the real address).
 */
export function installConnectionHooks(profiles: ProfileRegistry): void {
  app.on("login", (event, wc, _details, authInfo, callback) => {
    if (!authInfo.isProxy || !wc) return;
    const credentials = profiles.bySession(wc.session)?.proxyCredentials(authInfo.host, authInfo.port);
    if (!credentials) return;
    event.preventDefault();
    callback(credentials.username, credentials.password);
  });
  app.on("web-contents-created", (_event, wc) => {
    const runtime = profiles.bySession(wc.session);
    if (runtime) wc.setWebRTCIPHandlingPolicy(runtime.webrtcPolicy(wc.session));
  });
}
