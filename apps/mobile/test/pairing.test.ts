import { decodePairing, encodePairing, isLoopbackUrl, reachableFromPhone } from "@corvus/shared";
import { deriveKeys, generateRecoveryPhrase } from "@corvus/sync-core";
import { describe, expect, it } from "vitest";
import { checkManualPairing, checkPairingCode, pairingFailedMessage, phoneDeviceName } from "../src/lib/pairing";

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
    expect(reachableFromPhone("http://0.0.0.0:8797")).toBe(false);
  });

  it("knows when a code's server is the computer's localhost", () => {
    expect(isLoopbackUrl("http://localhost:8797")).toBe(true);
    expect(isLoopbackUrl("http://127.0.0.1:8797")).toBe(true);
    expect(isLoopbackUrl("http://[::1]:8797")).toBe(true);
    expect(isLoopbackUrl("http://192.168.1.20:8797")).toBe(false);
    expect(isLoopbackUrl("https://sync.example.com")).toBe(false);
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

  it("explains a code that points at localhost (older Corvus on the computer) instead of the raw connection error", () => {
    const refused = new TypeError("fetch failed: java.net.ConnectException: Failed to connect to localhost/127.0.0.1:8797");
    for (const url of ["http://localhost:8797", "http://127.0.0.1:8797", "http://[::1]:8797", "http://0.0.0.0:8797"]) {
      expect(pairingFailedMessage(refused, url), url).toBe(
        "This code points to the computer itself (localhost). Update Corvus on the computer, or enter its network address by hand.",
      );
    }
    expect(pairingFailedMessage(new Error("Network request failed"), "http://localhost:8797")).toMatch(/points to the computer itself/);
  });

  it("says what to check when the computer does not answer, and shows other failures as they are", () => {
    expect(pairingFailedMessage(new TypeError("fetch failed"), "http://192.168.1.20:8797")).toMatch(/^Could not reach your computer. Check that the phone is on the same Wi-Fi/);
    // A server answered (sync-core's SyncError has the HTTP status): its message is the useful one.
    const answered = Object.assign(new Error("Device was removed"), { status: 403, code: "device_revoked" });
    expect(pairingFailedMessage(answered, "http://localhost:8797")).toBe("Could not join the sync chain: Device was removed");
    expect(pairingFailedMessage("boom", "https://sync.example.com")).toBe("Could not join the sync chain: boom");
  });

  it("names the phone after its model", () => {
    expect(phoneDeviceName("Pixel 9", "android")).toBe("Pixel 9");
    expect(phoneDeviceName(null, "ios")).toBe("iPhone");
    expect(phoneDeviceName("  ", "android")).toBe("Android phone");
    expect(phoneDeviceName(undefined, "web")).toBe("Phone");
  });
});
