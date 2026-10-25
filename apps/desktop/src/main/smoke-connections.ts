import http from "node:http";
import type { AddressInfo } from "node:net";
import type { WebContents } from "electron";
import type { AppContext } from "./context";
import type { BrowserWindowCtl } from "./window";

interface ConnectionsSmokeHelpers {
  win: BrowserWindowCtl;
  check: (name: string, ok: boolean, detail?: unknown) => void;
  capture: (name: string, wc: WebContents) => Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function poll(wc: WebContents, expr: string, timeoutMs = 10_000): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if ((await wc.executeJavaScript(`Boolean(${expr})`).catch(() => false)) === true) return true;
    await sleep(150);
  }
  return false;
}

async function waitFor<T>(fn: () => T | undefined | null | false, timeoutMs = 10_000): Promise<T | undefined> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const value = fn();
    if (value) return value;
    await sleep(150);
  }
  return undefined;
}

/**
 * A plain HTTP proxy on localhost that answers every request itself (the sites, *.test, exist only
 * behind it), saying which proxy it is; optionally it asks for a Basic sign-in.
 */
async function fakeProxy(name: string, auth?: { user: string; pass: string }) {
  const hits: Array<{ host: string; path: string; authorized: boolean }> = [];
  const expected = auth ? `Basic ${Buffer.from(`${auth.user}:${auth.pass}`).toString("base64")}` : null;
  const server = http.createServer((req, res) => {
    let target: URL;
    try {
      target = new URL(req.url ?? "");
    } catch {
      res.writeHead(400).end();
      return;
    }
    const authorized = !expected || req.headers["proxy-authorization"] === expected;
    hits.push({ host: target.host, path: target.pathname, authorized });
    if (!authorized) {
      res.writeHead(407, { "Proxy-Authenticate": 'Basic realm="corvus smoke"', "Content-Type": "text/plain" }).end("sign in");
      return;
    }
    if (target.pathname.endsWith(".bin")) {
      res.writeHead(200, { "Content-Type": "application/octet-stream" }).end(`file via ${name}\n`);
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(`<!doctype html><title>via ${name}</title><body><p id="via">via ${name} ${target.host}</p></body>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { hits, port: (server.address() as AddressInfo).port, close: () => server.close() };
}

/**
 * Connections: the profile through one proxy, a site rule sending some sites through another, a
 * container through a third that asks for a sign-in, WebRTC kept on the proxy, the download queue
 * going the same way, and Settings → Connections listing it all.
 */
export async function runConnectionsSmoke(ctx: AppContext, h: ConnectionsSmokeHelpers): Promise<void> {
  const { win, check, capture } = h;
  const runtime = win.profile;
  const store = runtime.connections;
  const a = await fakeProxy("A");
  const b = await fakeProxy("B");
  const c = await fakeProxy("C", { user: "smoke", pass: "proxy-pass" });
  const before = store.config();
  const opened: string[] = [];
  let containerId: string | null = null;
  try {
    const pa = store.saveProxy({ name: "Smoke A", kind: "http", host: "127.0.0.1", port: a.port });
    const pb = store.saveProxy({ name: "Smoke B", kind: "http", host: "127.0.0.1", port: b.port });
    const pc = store.saveProxy({ name: "Smoke C", kind: "http", host: "127.0.0.1", port: c.port, username: "smoke", password: "proxy-pass" });
    store.setProfileChoice({ mode: "proxy", proxyId: pa.id });
    store.setRules([{ pattern: "*.rule.test", via: pb.id }]);

    const viaText = async (url: string, containerTab?: string): Promise<{ text: string | null; tab: string; policy: string | null }> => {
      const tab = win.createTab(url, { activate: false, ...(containerTab ? { containerId: containerTab } : {}) });
      opened.push(tab.id);
      const wc = tab.view.webContents;
      await poll(wc, "document.getElementById('via')");
      const text = (await wc.executeJavaScript("document.getElementById('via')?.textContent ?? null").catch(() => null)) as string | null;
      return { text, tab: tab.id, policy: wc.getWebRTCIPHandlingPolicy() };
    };

    const profilePage = await viaText("http://site-a.test/page");
    const rulePage = await viaText("http://x.rule.test/page");
    check(
      "connections: the profile goes through its proxy, a site rule through another, WebRTC stays on the proxy",
      profilePage.text === "via A site-a.test" &&
        rulePage.text === "via B x.rule.test" &&
        profilePage.policy === "disable_non_proxied_udp" &&
        a.hits.some((x) => x.host === "site-a.test") &&
        !a.hits.some((x) => x.host === "x.rule.test") &&
        b.hits.some((x) => x.host === "x.rule.test"),
      { profilePage, rulePage, a: a.hits, b: b.hits },
    );

    const container = runtime.containers.add("Proxy smoke", "purple");
    containerId = container.id;
    store.setContainerChoice(container.id, { mode: "proxy", proxyId: pc.id });
    const containerPage = await viaText("http://auth.test/page", container.id);
    check(
      "connections: a container goes through its own proxy, which asks for a sign-in Corvus answers",
      containerPage.text === "via C auth.test" && c.hits.some((x) => !x.authorized) && c.hits.some((x) => x.authorized && x.host === "auth.test") && !a.hits.some((x) => x.host === "auth.test"),
      { containerPage, c: c.hits },
    );

    // The download queue fetches through the profile's proxy too.
    ctx.grabber.queueLinks(win, ["http://files.test/proxied.bin"], "smoke");
    const item = await waitFor(() => ctx.queue.list(runtime).packages.flatMap((p) => p.items).find((i) => i.url === "http://files.test/proxied.bin" && i.state === "done"), 15_000);
    check("connections: the download queue goes through the profile's proxy", item !== undefined && a.hits.some((x) => x.host === "files.test"), { item, a: a.hits.map((x) => x.host) });
    for (const p of ctx.queue.list(runtime).packages) if (p.items.some((i) => i.url === "http://files.test/proxied.bin")) ctx.queue.act(runtime, p.id, "remove");

    // Removing a proxy in use is refused; Settings lists the proxies, the container and the rule.
    let refused = false;
    try {
      store.removeProxy(pa.id);
    } catch {
      refused = true;
    }
    const settings = win.createTab("corvus://settings/#connections");
    opened.push(settings.id);
    const shown = await poll(
      settings.view.webContents,
      `document.querySelector('[data-proxy="Smoke A"]') && document.querySelector('[data-proxy="Smoke C"]') && document.querySelector('[data-connection-container="${container.id}"]') && document.querySelector('[data-connection-rule="*.rule.test"]')`,
    );
    await settings.view.webContents.executeJavaScript("document.getElementById('connections')?.scrollIntoView()").catch(() => undefined);
    await sleep(300);
    await capture("settings-connections", settings.view.webContents);
    check("connections: a proxy in use cannot be removed; Settings shows proxies, containers and rules", refused && shown, { refused, shown });
  } finally {
    for (const id of opened) if (win.getTab(id)) win.closeTab(id);
    store.setRules([]);
    if (containerId) {
      store.setContainerChoice(containerId, null);
      runtime.containers.remove(containerId);
    }
    store.setProfileChoice(before.profile);
    for (const p of store.config().proxies) if (!before.proxies.some((x) => x.id === p.id)) store.removeProxy(p.id);
    await runtime.whenConnected(runtime.session);
    a.close();
    b.close();
    c.close();
  }
}
