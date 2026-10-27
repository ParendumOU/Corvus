import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import type { WebContents } from "electron";
import { decodePairing, isLoopbackUrl, phoneServerAddresses, type NetworkInterfaceMap } from "@corvus/shared";
import type { AppContext } from "./context";
import { phonePairingAddress } from "./pairing-address";
import type { ProfileRuntime } from "./profiles";

type Check = (name: string, ok: boolean, detail?: unknown) => void;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function poll(wc: WebContents, expr: string, timeoutMs = 8000): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if ((await wc.executeJavaScript(`Boolean(${expr})`).catch(() => false)) === true) return true;
    await sleep(120);
  }
  return false;
}

/** A stand-in sync server that only answers /healthz, listening on `host`. */
async function healthServer(host: string): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer((req, res) => {
    res.writeHead(req.url === "/healthz" ? 200 : 404, { "content-type": "application/json" });
    res.end('{"ok":true}');
  });
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  return { server, port: (server.address() as AddressInfo).port };
}

/**
 * "Pair a phone" with a sync server on localhost, on this machine's real network adapters: the
 * code carries the machine's network address and the server is checked there. A server listening
 * on every address answers; one listening on 127.0.0.1 only does not. Without a usable adapter the
 * code keeps localhost (and the warning), so the checks hold wherever the smoke runs.
 */
export async function runPairingAddressSmoke(check: Check): Promise<void> {
  const open = await healthServer("0.0.0.0");
  const local = await healthServer("127.0.0.1");
  try {
    const desktopUrl = `http://localhost:${open.port}`;
    const expected = phoneServerAddresses(desktopUrl, os.networkInterfaces()) ?? [];
    const answered = await phonePairingAddress(desktopUrl);
    const silent = await phonePairingAddress(`http://127.0.0.1:${local.port}`);
    if (expected.length === 0) {
      check(
        "pair a phone: without a network address the code keeps localhost and warns",
        !answered.lanOnly && !answered.reachable && answered.serverUrl === desktopUrl,
        answered,
      );
      return;
    }
    check(
      "pair a phone: a sync server on localhost goes in the code as this machine's network address, checked to answer there",
      answered.lanOnly &&
        answered.reachable &&
        answered.serverUrl === expected[0]!.url &&
        !isLoopbackUrl(answered.serverUrl) &&
        new URL(answered.serverUrl).port === String(open.port) &&
        answered.desktopServerUrl === desktopUrl,
      answered,
    );
    check("pair a phone: a sync server listening on 127.0.0.1 only is reported as not answering on the network", silent.lanOnly && !silent.reachable, silent);
  } finally {
    open.server.close();
    local.server.close();
  }
}

/** A Windows laptop on Wi-Fi with WSL and Tailscale: what "Pair a phone" shows is the same on any machine. */
const FIXED_NETWORK: NetworkInterfaceMap = {
  "vEthernet (WSL)": [{ address: "172.29.80.1", family: "IPv4", internal: false }],
  "Wi-Fi": [{ address: "192.168.1.20", family: "IPv4", internal: false }],
  Tailscale: [{ address: "100.101.102.103", family: "IPv4", internal: false }],
};

/**
 * Settings > Sync > Pair a phone when the sync server setting is on localhost (simulated: a fixed
 * network layout where the server answers on the Wi-Fi address but not on Tailscale): the QR code
 * carries the Wi-Fi address with the same-network note, and the address menu switches it to
 * Tailscale, which shows the "does not answer" warning. Needs sync on (CORVUS_SMOKE_SYNC_URL).
 */
export async function runPairPhoneUiSmoke(
  ctx: AppContext,
  h: { profile: ProfileRuntime; settings: WebContents; phrase: string; check: Check; capture: (name: string, wc: WebContents) => Promise<void> },
): Promise<void> {
  const { settings: wc, check, capture } = h;
  const real = ctx.sync.pairingAddress;
  ctx.sync.pairingAddress = (_url, prefer) =>
    phonePairingAddress("http://localhost:8797", { interfaces: FIXED_NETWORK, probe: async (url) => url.includes("192.168.1.20"), prefer });
  try {
    const tailscale = await ctx.sync.pairingCode(h.profile, "http://100.101.102.103:8797");
    check(
      "pair a phone: another of the computer's addresses can go in the code",
      decodePairing(tailscale.code)?.serverUrl === "http://100.101.102.103:8797" && decodePairing(tailscale.code)?.phrase === h.phrase && tailscale.address?.kind === "tailscale",
      { serverUrl: tailscale.serverUrl, alternatives: tailscale.alternatives.map((a) => a.url) },
    );

    await wc.executeJavaScript(`(() => {
      window.confirm = () => true;
      const button = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Pair a phone…");
      button?.scrollIntoView({ block: "center" });
      button?.click();
      return Boolean(button);
    })()`);
    const shown = await poll(wc, `document.querySelector(".pair-network") && document.querySelector(".pair-address select")?.value === "http://192.168.1.20:8797"`);
    const view = async (): Promise<{ server: string; note: string; options: string[]; warning: string }> =>
      (await wc.executeJavaScript(`({
        server: [...document.querySelectorAll(".pair-steps span")].map((s) => s.textContent).find((s) => s.startsWith("Sync server:")) ?? "",
        note: document.querySelector(".pair-network")?.textContent ?? "",
        options: [...document.querySelectorAll(".pair-address option")].map((o) => o.textContent),
        warning: document.querySelector(".pair-steps .notice.warn")?.textContent ?? "",
      })`)) as { server: string; note: string; options: string[]; warning: string };
    const lan = await view();
    check(
      "pair a phone UI: the code uses the Wi-Fi address, with the same-network note and Tailscale on offer",
      shown &&
        lan.server === "Sync server: http://192.168.1.20:8797" &&
        lan.note.includes("same Wi-Fi") &&
        lan.note.includes("port 8797") &&
        lan.options.join("|") === "192.168.1.20 (Wi-Fi)|100.101.102.103 (Tailscale)" &&
        lan.warning === "",
      lan,
    );
    await wc.executeJavaScript(`document.querySelector(".pair-phone")?.scrollIntoView({ block: "center" })`);
    await sleep(300);
    await capture("settings-pair-phone-lan", wc);

    await wc.executeJavaScript(`(() => {
      const select = document.querySelector(".pair-address select");
      select.value = "http://100.101.102.103:8797";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    })()`);
    const switched = await poll(wc, `document.querySelector(".pair-address select")?.value === "http://100.101.102.103:8797" && document.querySelector(".pair-steps .notice.warn")`);
    const after = await view();
    check(
      "pair a phone UI: switching to Tailscale updates the code and warns that the server does not answer there",
      switched &&
        after.server === "Sync server: http://100.101.102.103:8797" &&
        after.note.includes("Tailscale address") &&
        !after.note.includes("same Wi-Fi") &&
        after.warning.includes("does not answer at http://100.101.102.103:8797"),
      after,
    );
    await sleep(300);
    await capture("settings-pair-phone-tailscale", wc);
    await wc.executeJavaScript(`[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Hide")?.click()`);
  } finally {
    ctx.sync.pairingAddress = real;
  }
}
