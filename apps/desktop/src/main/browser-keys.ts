/**
 * Where the key another browser keeps its saved passwords under comes from, on each system, for the
 * person running Corvus (never anyone else): Windows' DPAPI as the current user, the macOS Keychain
 * (the system asks the person first), and Linux's Secret Service. Used only while a password import
 * the person started runs; nothing is cached, and nothing read here is ever logged.
 *
 * Windows calls crypt32's CryptUnprotectData through koffi in a utility process (dpapi-worker.ts), one
 * for the import and killed when it ends, rather than in the main process, where a native fault would
 * close the browser, or by spawning a shell. If the worker crashes, exits, hangs or cannot load koffi,
 * the answer is null: those logins count as protected and the person is offered the browser's own
 * export. The bytes only cross the private channel to that child.
 */
import { execFile } from "node:child_process";

export interface KeyProviders {
  /** Windows: unprotects a DPAPI blob as the current user, or null. Never rejects. */
  dpapi?: (blob: Buffer) => Promise<Buffer | null>;
  /** macOS: a Keychain password (service, account); the system asks the person. */
  keychain?: (service: string, account: string) => Promise<string | null>;
  /** Linux: the Secret Service secret stored for an application name. */
  secretService?: (application: string) => Promise<string | null>;
  /** Ends what the providers started (Windows' worker). Called when the import ends, whatever happened. */
  close?: () => void;
}

/** The parts of Electron's UtilityProcess a DPAPI session uses. */
export interface DpapiChild {
  on(event: "spawn", listener: () => void): unknown;
  on(event: "exit", listener: (code: number) => void): unknown;
  on(event: "message", listener: (message: unknown) => void): unknown;
  postMessage(message: unknown): void;
  kill(): boolean;
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

/** How long one answer may take, starting the worker included (an antivirus may scan koffi's binary). */
export const DPAPI_TIMEOUT_MS = 20_000;

/**
 * One DPAPI worker for one import: started by the first request, killed by `close`. Once it crashed,
 * exited or timed out it is over: what was waiting and every later request answer null at once, so a
 * dead worker costs one timeout at most, however many logins the import reads.
 */
export function dpapiSession(fork: () => DpapiChild, timeoutMs = DPAPI_TIMEOUT_MS): { unprotect: (blob: Buffer) => Promise<Buffer | null>; close: () => void } {
  let child: DpapiChild | null = null;
  let spawned: Promise<void> = Promise.resolve();
  let over = false;
  let nextId = 1;
  const waiting = new Map<number, { resolve: (value: Buffer | null) => void; timer: ReturnType<typeof setTimeout> }>();

  const end = (): void => {
    over = true;
    for (const { resolve, timer } of waiting.values()) {
      clearTimeout(timer);
      resolve(null);
    }
    waiting.clear();
    const gone = child;
    child = null;
    try {
      gone?.kill();
    } catch {
      // Already gone.
    }
  };

  const start = (): DpapiChild => {
    const started = fork();
    spawned = new Promise((resolve) => started.on("spawn", resolve));
    started.on("exit", end);
    started.on("message", (message) => {
      const { id, data } = (message ?? {}) as { id?: number; data?: unknown };
      const entry = typeof id === "number" ? waiting.get(id) : undefined;
      if (!entry) return;
      waiting.delete(id!);
      clearTimeout(entry.timer);
      if (!(ArrayBuffer.isView(data) && data.byteLength > 0)) return entry.resolve(null);
      const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      const copy = Buffer.from(bytes);
      bytes.fill(0);
      entry.resolve(copy);
    });
    child = started;
    return started;
  };

  return {
    unprotect: (blob) =>
      new Promise((resolve) => {
        if (over || blob.length === 0) return resolve(null);
        const id = nextId++;
        waiting.set(id, { resolve, timer: setTimeout(end, timeoutMs) });
        try {
          const worker = child ?? start();
          void spawned.then(() => {
            if (waiting.has(id)) worker.postMessage({ id, blob: new Uint8Array(blob) });
          });
        } catch {
          end();
        }
      }),
    close: end,
  };
}

/** This system's providers. On Windows `forkDpapi` starts the worker (no worker: no DPAPI). */
export function systemKeyProviders(platform: string = process.platform, forkDpapi?: () => DpapiChild, timeoutMs?: number): KeyProviders {
  if (platform === "win32") {
    if (!forkDpapi) return {};
    const session = dpapiSession(forkDpapi, timeoutMs);
    return { dpapi: session.unprotect, close: session.close };
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
