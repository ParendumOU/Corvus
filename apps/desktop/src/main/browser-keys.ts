/**
 * Where the key another browser keeps its saved passwords under comes from, on each system, for the
 * person running Corvus (never anyone else): Windows' DPAPI as the current user, the macOS Keychain
 * (the system asks the person first), and Linux's Secret Service. Used only while a password import
 * the person started runs; nothing is cached, and nothing read here is ever logged.
 *
 * Windows calls crypt32's CryptUnprotectData in-process through koffi (loaded on first use, only on
 * Windows) rather than spawning a shell: no script, nothing for a policy to block, and the key never
 * crosses a process boundary. When it cannot load, those logins count as protected and the person is
 * offered the browser's own export.
 */
import { execFile } from "node:child_process";
import { createRequire } from "node:module";

export interface KeyProviders {
  /** Windows: unprotects a DPAPI blob as the current user. */
  dpapi?: (blob: Buffer) => Buffer | null;
  /** macOS: a Keychain password (service, account); the system asks the person. */
  keychain?: (service: string, account: string) => Promise<string | null>;
  /** Linux: the Secret Service secret stored for an application name. */
  secretService?: (application: string) => Promise<string | null>;
}

/** Runs a program (no shell) and returns its trimmed output, or null. Its output is never logged. */
function output(file: string, args: string[], timeout: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, windowsHide: true, maxBuffer: 64 * 1024 }, (err, stdout) => {
      const text = typeof stdout === "string" ? stdout.replace(/\r?\n$/, "") : "";
      resolve(err || !text ? null : text);
    });
  });
}

const CRYPTPROTECT_UI_FORBIDDEN = 0x1;
let dpapiCall: ((blob: Buffer) => Buffer | null) | null | undefined;

/** crypt32!CryptUnprotectData through koffi, or null when it cannot be loaded. */
function windowsDpapi(): ((blob: Buffer) => Buffer | null) | null {
  if (dpapiCall !== undefined) return dpapiCall;
  try {
    const koffi = createRequire(import.meta.url)("koffi") as typeof import("koffi");
    const crypt32 = koffi.load("crypt32.dll");
    const kernel32 = koffi.load("kernel32.dll");
    koffi.struct("CORVUS_DATA_BLOB", { cbData: "uint32_t", pbData: "void *" });
    const unprotect = crypt32.func(
      "bool __stdcall CryptUnprotectData(CORVUS_DATA_BLOB *pDataIn, void *ppszDataDescr, CORVUS_DATA_BLOB *pOptionalEntropy, void *pvReserved, void *pPromptStruct, uint32_t dwFlags, _Out_ CORVUS_DATA_BLOB *pDataOut)",
    );
    const localFree = kernel32.func("void * __stdcall LocalFree(void *hMem)");
    dpapiCall = (blob) => {
      if (blob.length === 0) return null;
      const input = koffi.alloc("uint8_t", blob.length);
      try {
        new Uint8Array(koffi.view(input, blob.length)).set(blob);
        const out: { cbData?: number; pbData?: unknown } = {};
        if (!unprotect({ cbData: blob.length, pbData: input }, null, null, null, null, CRYPTPROTECT_UI_FORBIDDEN, out) || !out.pbData || !out.cbData) return null;
        try {
          const view = new Uint8Array(koffi.view(out.pbData, out.cbData));
          const copy = Buffer.from(view);
          view.fill(0);
          return copy;
        } finally {
          localFree(out.pbData);
        }
      } catch {
        return null;
      } finally {
        koffi.free(input);
      }
    };
  } catch {
    dpapiCall = null;
  }
  return dpapiCall;
}

/** This system's providers. */
export function systemKeyProviders(platform: string = process.platform): KeyProviders {
  if (platform === "win32") {
    return {
      dpapi: (blob) => {
        const call = windowsDpapi();
        return call ? call(blob) : null;
      },
    };
  }
  if (platform === "darwin") {
    // Two minutes: the system dialog waits for the person to answer.
    return { keychain: (service, account) => output("/usr/bin/security", ["find-generic-password", "-w", "-s", service, "-a", account], 120_000) };
  }
  return { secretService: (application) => output("secret-tool", ["lookup", "application", application], 15_000) };
}

/** The names a Chromium browser keeps its key under: macOS Keychain (service, account), Linux application. */
export function chromiumKeyNames(sourceId: string): { service: string; account: string; application: string } {
  switch (sourceId) {
    case "edge":
      return { service: "Microsoft Edge Safe Storage", account: "Microsoft Edge", application: "microsoft-edge" };
    case "brave":
      return { service: "Brave Safe Storage", account: "Brave", application: "brave" };
    case "vivaldi":
      return { service: "Vivaldi Safe Storage", account: "Vivaldi", application: "vivaldi" };
    case "opera":
    case "opera-gx":
      return { service: "Opera Safe Storage", account: "Opera", application: "opera" };
    case "chromium":
    case "chromium-snap":
      return { service: "Chromium Safe Storage", account: "Chromium", application: "chromium" };
    default:
      return { service: "Chrome Safe Storage", account: "Chrome", application: "chrome" };
  }
}
