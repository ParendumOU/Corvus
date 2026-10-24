import { decodePairing, encodePairing, reachableFromPhone } from "@corvus/shared";
import { deriveKeys, generateRecoveryPhrase } from "@corvus/sync-core";
import { describe, expect, it } from "vitest";
import { checkManualPairing, checkPairingCode, phoneDeviceName } from "../src/lib/pairing";

describe("pairing code", () => {
  it("carries the server and the phrase, and is not a URL another app would open", () => {
    const phrase = generateRecoveryPhrase();
    const code = encodePairing({ serverUrl: "https://sync.example.com", phrase });
    expect(code.startsWith("corvus-pair:1:")).toBe(true);
    expect(decodePairing(code)).toEqual({ serverUrl: "https://sync.example.com", phrase });
    expect(decodePairing(`  ${code}\n`)).toEqual({ serverUrl: "https://sync.example.com", phrase });
    expect(decodePairing("https://example.com")).toBeNull();
    expect(decodePairing("corvus-pair:1:not-base64!")).toBeNull();
    expect(decodePairing(encodePairing({ serverUrl: "ftp://x.example", phrase }))).toBeNull();
    expect(decodePairing(encodePairing({ serverUrl: "https://x.example", phrase: "too few words" }))).toBeNull();
  });

  it("warns when the phone cannot reach the sync server address", () => {
    expect(reachableFromPhone("https://sync.example.com")).toBe(true);
    expect(reachableFromPhone("http://192.168.1.20:8787")).toBe(true);
    expect(reachableFromPhone("http://localhost:8797")).toBe(false);
    expect(reachableFromPhone("http://127.0.0.1:8797")).toBe(false);
    expect(reachableFromPhone("http://sync-server:8787")).toBe(false);
  });
});

describe("pairing on the phone", () => {
  it("accepts a scanned code and opens the code's chain", () => {
    const phrase = generateRecoveryPhrase();
    const check = checkPairingCode(encodePairing({ serverUrl: "https://sync.example.com/", phrase }));
    expect(check).toEqual({ ok: true, info: { serverUrl: "https://sync.example.com", phrase }, chainId: deriveKeys(phrase).chainId });
    expect(checkPairingCode("hello").ok).toBe(false);
  });

  it("accepts the server and the 24 words typed by hand, or a pasted code", () => {
    const phrase = generateRecoveryPhrase();
    const typed = checkManualPairing(" https://sync.example.com ", phrase.toUpperCase());
    expect(typed.ok && typed.info).toEqual({ serverUrl: "https://sync.example.com", phrase });
    expect(checkManualPairing("", encodePairing({ serverUrl: "https://a.example", phrase })).ok).toBe(true);
    expect(checkManualPairing("sync.example.com", phrase)).toEqual({ ok: false, error: expect.stringMatching(/starting with https:\/\//) });
    expect(checkManualPairing("https://sync.example.com", "raven ".repeat(24))).toEqual({ ok: false, error: expect.stringMatching(/not valid/) });
  });

  it("names the phone after its model", () => {
    expect(phoneDeviceName("Pixel 9", "android")).toBe("Pixel 9");
    expect(phoneDeviceName(null, "ios")).toBe("iPhone");
    expect(phoneDeviceName("  ", "android")).toBe("Android phone");
    expect(phoneDeviceName(undefined, "web")).toBe("Phone");
  });
});
