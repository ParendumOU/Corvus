import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isPrivateAddress } from "../src/network.js";
import { DEV_1, KEYS_A, makeServer, registerChain, signed } from "./helpers.js";

describe("isPrivateAddress", () => {
  it("accepts this computer and private networks", () => {
    for (const a of ["127.0.0.1", "::1", "::ffff:127.0.0.1", "10.0.0.5", "172.16.0.1", "172.31.255.1", "192.168.1.20", "::ffff:192.168.1.20", "169.254.3.4", "100.101.102.103", "fd12:3456::1", "fe80::1%eth0"]) {
      expect(isPrivateAddress(a), a).toBe(true);
    }
  });
  it("refuses public addresses and nonsense", () => {
    for (const a of [undefined, "", "8.8.8.8", "172.32.0.1", "100.128.0.1", "192.169.0.1", "2001:db8::1", "::ffff:8.8.8.8", "999.1.1.1", "localhost"]) {
      expect(isPrivateAddress(a), String(a)).toBe(false);
    }
  });
});

describe("allowClient", () => {
  it("answers 403 to clients the check refuses, before auth", async () => {
    const app = await makeServer({ allowClient: (a) => a !== "127.0.0.1" });
    const health = await app.inject({ method: "GET", url: "/healthz" });
    expect(health.statusCode).toBe(403);
    expect(health.json()).toMatchObject({ error: "forbidden" });
    await app.close();
  });
  it("lets allowed clients through", async () => {
    const app = await makeServer({ allowClient: isPrivateAddress });
    expect((await app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
    await app.close();
  });
});

describe("database file", () => {
  it("keeps chains, devices and records across restarts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "corvus-sync-"));
    try {
      const dbPath = join(dir, "nested", "sync.db");
      let app = await makeServer({ dbPath });
      await registerChain(app, KEYS_A, DEV_1);
      await app.close();
      app = await makeServer({ dbPath });
      const res = await signed(app, KEYS_A, DEV_1, "GET", `/v1/chains/${KEYS_A.chainId}/devices`);
      expect(res.statusCode).toBe(200);
      expect(res.json().devices).toHaveLength(1);
      await app.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("embedded server", () => {
  it("tries the remembered port, then 8797 and the next ones, then any", async () => {
    const { portCandidates } = await import("../src/embedded.js");
    expect(portCandidates()).toEqual([8797, 8798, 8799, 8800, 8801, 8802, 8803, 8804, 8805, 8806, 0]);
    expect(portCandidates(8801).slice(0, 3)).toEqual([8801, 8797, 8798]);
    expect(portCandidates(40000)[0]).toBe(40000);
    expect(portCandidates(-1)[0]).toBe(8797);
  });

  it("falls back to the next port when the remembered one is taken", async () => {
    const { startEmbeddedServer } = await import("../src/embedded.js");
    const first = await startEmbeddedServer({ dbPath: ":memory:", remembered: 0, host: "127.0.0.1" });
    const second = await startEmbeddedServer({ dbPath: ":memory:", remembered: first.port, host: "127.0.0.1" });
    try {
      expect(second.port).not.toBe(first.port);
      const res = await fetch(`http://127.0.0.1:${second.port}/healthz`);
      expect(res.status).toBe(200);
    } finally {
      await first.app.close();
      await second.app.close();
    }
  });
});
