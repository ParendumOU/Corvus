import { EventEmitter } from "node:events";
import { chainServerAlternatives, chainServerMove, parseChainServer } from "@corvus/shared";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({}));

import { LocalSyncServer, type LocalServerReply, type LocalServerRequest, type ServerProcess } from "../src/main/local-sync-server";
import { firewallVerdict, networkCategories, programRules } from "../src/main/network-help";
import { ownChainServer, reviveSyncState, type ProfileSyncState } from "../src/main/sync-state";

const defaults = (): ProfileSyncState => ({
  enabled: false,
  mode: "local",
  serverUrl: "http://localhost:8797",
  customServerUrl: "http://localhost:8797",
  localPort: null,
  retireLocalUntil: null,
  deviceName: "pc",
  chainId: null,
  phrase: null,
  lastSyncAt: null,
  intervalMinutes: 5,
  syncServiceUrls: false,
  syncWorkflows: true,
  syncSiteMemory: true,
  syncCommandHistory: true,
  syncAssistHistory: true,
});

describe("reviveSyncState", () => {
  it("keeps a profile already syncing on its server as Your own server", () => {
    const s = reviveSyncState({ enabled: true, serverUrl: "https://sync.example.org", chainId: "abc" }, defaults());
    expect(s.mode).toBe("custom");
    expect(s.serverUrl).toBe("https://sync.example.org");
    expect(s.customServerUrl).toBe("https://sync.example.org");
  });
  it("puts a profile not syncing on This computer, remembering the address it had", () => {
    const s = reviveSyncState({ enabled: false, serverUrl: "http://localhost:8797" }, defaults());
    expect(s.mode).toBe("local");
    expect(s.customServerUrl).toBe("http://localhost:8797");
  });
  it("keeps a stored mode and fixes bad fields", () => {
    const s = reviveSyncState({ enabled: true, mode: "local", localPort: "x", retireLocalUntil: "y" }, defaults());
    expect(s.mode).toBe("local");
    expect(s.localPort).toBeNull();
    expect(s.retireLocalUntil).toBeNull();
    expect(reviveSyncState(null, defaults())).toEqual(defaults());
  });
});

describe("chain_server record", () => {
  const record = { urls: ["http://192.168.1.10:8797", "http://100.64.1.2:8797"], at: 5, from: "pc-1" };

  it("parses, normalizes and caps addresses", () => {
    expect(parseChainServer({ urls: ["http://a.lan:1/", "ftp://x", 3, "http://a.lan:1"], at: 1, from: "d" })).toEqual({ urls: ["http://a.lan:1"], at: 1, from: "d" });
    expect(parseChainServer({ urls: [], at: 1, from: "d" })).toBeNull();
    expect(parseChainServer("nope")).toBeNull();
  });

  it("tells a device to follow only when its server is not listed and it did not write it", () => {
    expect(chainServerMove(record, "http://192.168.1.10:8797/", "phone")).toBeNull();
    expect(chainServerMove(record, "https://old.example.org", "phone")).toEqual(record.urls);
    expect(chainServerMove(record, "https://old.example.org", "pc-1")).toBeNull();
    expect(chainServerMove(undefined, "https://old.example.org", "phone")).toBeNull();
  });

  it("offers the other addresses of the same server", () => {
    expect(chainServerAlternatives(record, "http://192.168.1.10:8797")).toEqual(["http://100.64.1.2:8797"]);
    expect(chainServerAlternatives(record, "https://elsewhere.example.org")).toEqual([]);
  });

  it("a computer keeps its record while its addresses stay the same", () => {
    expect(ownChainServer(record.urls, record, "pc-1", 99)).toEqual(record);
    expect(ownChainServer(["http://192.168.1.11:8797"], record, "pc-1", 99)).toEqual({ urls: ["http://192.168.1.11:8797"], at: 99, from: "pc-1" });
    expect(ownChainServer(record.urls, record, "pc-2", 99)?.from).toBe("pc-2");
    expect(ownChainServer([], record, "pc-1", 99)).toBeNull();
  });
});

describe("network help (Windows)", () => {
  const exe = "C:\\Users\\Ana\\AppData\\Local\\Programs\\Corvus\\Corvus.exe";
  const english = (action: string, enabled: string, profiles: string, program = exe): string =>
    [
      "Rule Name:                            corvus.exe",
      "----------------------------------------------------------------------",
      `Enabled:                              ${enabled}`,
      "Direction:                            In",
      `Profiles:                             ${profiles}`,
      `Program:                              ${program}`,
      `Action:                               ${action}`,
    ].join("\r\n");
  // As netsh writes it on a Spanish Windows, through the console code page (accents garbled), path in lower case.
  const spanish = (action: string, enabled: string, profiles: string): string =>
    [
      "Nombre de regla:                      corvus.exe",
      "----------------------------------------------------------------------",
      `Habilitada:                           ${enabled}`,
      "Direcci\ufffdn:                            Dentro",
      `Perfiles:                             ${profiles}`,
      `Programa:                             ${exe.toLowerCase()}`,
      `Acci\ufffdn:                               ${action}`,
    ].join("\r\n");

  it("reads the program's rules in English and Spanish", () => {
    const rules = programRules([english("Allow", "Yes", "Private"), english("Block", "Yes", "Public"), english("Allow", "Yes", "Public", "C:\\Other\\app.exe")].join("\r\n\r\n"), exe);
    expect(rules).toEqual([
      { enabled: true, allow: true, profiles: "Private" },
      { enabled: true, allow: false, profiles: "Public" },
    ]);
    expect(programRules(spanish("Bloquear", "S\ufffd", "P\ufffdblica"), exe)).toEqual([{ enabled: true, allow: false, profiles: "P\ufffdblica" }]);
    expect(programRules(spanish("Permitir", "No", "Privada"), exe)).toEqual([{ enabled: false, allow: true, profiles: "Privada" }]);
    expect(networkCategories("Private\r\nPublic\r\n\r\n")).toEqual(["Private", "Public"]);
  });

  it("a Public network keeps devices out unless Corvus is allowed on Public networks", () => {
    const privateOnly = programRules(english("Allow", "Yes", "Private"), exe);
    expect(firewallVerdict(["Public"], privateOnly)).toEqual({ publicNetwork: true, firewallBlocks: false });
    expect(firewallVerdict(["Private"], privateOnly)).toEqual({ publicNetwork: false, firewallBlocks: false });
    expect(firewallVerdict(["Public"], programRules(spanish("Permitir", "S\ufffd", "P\ufffdblica"), exe))).toEqual({ publicNetwork: false, firewallBlocks: false });
    expect(firewallVerdict(["Public"], programRules(english("Allow", "Yes", "Domain,Private,Public"), exe)).publicNetwork).toBe(false);
  });

  it("an enabled Block rule for the network keeps devices out (Cancel at the prompt)", () => {
    expect(firewallVerdict(["Private"], programRules(english("Block", "Yes", "Private"), exe)).firewallBlocks).toBe(true);
    expect(firewallVerdict(["Private"], programRules(english("Block", "No", "Private"), exe)).firewallBlocks).toBe(false);
    expect(firewallVerdict(["Private"], programRules(english("Block", "Yes", "Public"), exe)).firewallBlocks).toBe(false);
  });
});

class FakeProcess extends EventEmitter implements ServerProcess {
  sent: LocalServerRequest[] = [];
  killed = false;
  constructor(private readonly answer: (msg: LocalServerRequest, self: FakeProcess) => void) {
    super();
  }
  postMessage(msg: LocalServerRequest): void {
    this.sent.push(msg);
    queueMicrotask(() => this.answer(msg, this));
  }
  reply(msg: LocalServerReply): void {
    this.emit("message", msg);
  }
  kill(): boolean {
    this.killed = true;
    queueMicrotask(() => this.emit("exit", 1));
    return true;
  }
}

describe("LocalSyncServer", () => {
  const listening = (port: number) => (msg: LocalServerRequest, self: FakeProcess) => {
    if (msg.type === "start") self.reply({ type: "listening", port });
    else self.emit("exit", 0);
  };

  it("starts once, remembers the port it got and who reached it", async () => {
    const procs: FakeProcess[] = [];
    const server = new LocalSyncServer("/p/sync.db", () => {
      const p = new FakeProcess(listening(8798));
      procs.push(p);
      return p;
    });
    const [a, b] = await Promise.all([server.start(8797), server.start(8797)]);
    expect([a, b]).toEqual([8798, 8798]);
    expect(procs).toHaveLength(1);
    expect(procs[0]!.sent[0]).toEqual({ type: "start", dbPath: "/p/sync.db", remembered: 8797 });
    procs[0]!.reply({ type: "client", address: "192.168.1.33", at: 7 });
    expect(server.status).toMatchObject({ running: true, port: 8798, lastClient: { address: "192.168.1.33", at: 7 } });
    await server.stop();
    expect(server.status.running).toBe(false);
  });

  it("reports a failed start and starts again later", async () => {
    let fail = true;
    const server = new LocalSyncServer("/p/sync.db", () =>
      new FakeProcess((msg, self) => {
        if (msg.type === "start") self.reply(fail ? { type: "failed", error: "EACCES" } : { type: "listening", port: 8797 });
      }),
    );
    await expect(server.start(null)).rejects.toThrow("EACCES");
    expect(server.status.error).toBe("EACCES");
    fail = false;
    await expect(server.start(null)).resolves.toBe(8797);
  });

  it("notices when the process dies", async () => {
    let proc: FakeProcess | undefined;
    const server = new LocalSyncServer("/p/sync.db", () => (proc = new FakeProcess(listening(8797))));
    await server.start(null);
    proc!.emit("exit", 9);
    expect(server.status.running).toBe(false);
    expect(server.status.error).toMatch(/stopped/);
  });

  it("gives up when the process never answers", async () => {
    const server = new LocalSyncServer("/p/sync.db", () => new FakeProcess(() => undefined), 20);
    await expect(server.start(null)).rejects.toThrow(/did not start/);
  });
});
