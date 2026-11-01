/**
 * crypt32's CryptUnprotectData through koffi, for the keys Chromium browsers keep on Windows. It runs
 * only in the DPAPI worker (dpapi-worker.ts), never in the main process: a native call that goes
 * wrong must not take the browser down.
 *
 * Electron runs V8 with its memory sandbox, where an ArrayBuffer over outside memory aborts the whole
 * process. So native memory is only crossed by copy, with koffi's encode and decode, never its view
 * function (test/koffi-guard.test.ts fails if that comes back).
 */
import { createRequire } from "node:module";

export type Koffi = typeof import("koffi");

export const loadKoffi = (): Koffi => createRequire(import.meta.url)("koffi") as Koffi;

/** Copies `data` into native memory. */
export function writeBytes(koffi: Koffi, pointer: unknown, data: Uint8Array): void {
  koffi.encode(pointer, "uint8_t", Array.from(data), data.length);
}

/** A copy of `length` bytes of native memory, which stays valid after that memory is wiped or freed. */
export function readBytes(koffi: Koffi, pointer: unknown, length: number): Uint8Array {
  const copy = koffi.decode(pointer, "uint8_t", length) as Uint8Array | number[];
  return ArrayBuffer.isView(copy) ? copy : Uint8Array.from(copy);
}

/** Overwrites `length` bytes of native memory with zeros. */
export function wipeBytes(koffi: Koffi, pointer: unknown, length: number): void {
  koffi.encode(pointer, "uint8_t", new Array<number>(length).fill(0), length);
}

/** Whether the helpers above work in this process: bytes in, a copy out, then wiped. */
export function memoryWorks(koffi: Koffi): boolean {
  const size = 32;
  const pointer = koffi.alloc("uint8_t", size);
  try {
    const pattern = Uint8Array.from({ length: size }, (_, i) => i + 1);
    writeBytes(koffi, pointer, pattern);
    const copy = readBytes(koffi, pointer, size);
    wipeBytes(koffi, pointer, size);
    return copy.every((byte, i) => byte === pattern[i]) && readBytes(koffi, pointer, size).every((byte) => byte === 0);
  } finally {
    koffi.free(pointer);
  }
}

const CRYPTPROTECT_UI_FORBIDDEN = 0x1;

/** Unprotects DPAPI blobs as the current user. Throws when the system libraries cannot be loaded. */
export function openDpapi(koffi: Koffi, crypt32Path = "crypt32.dll", kernel32Path = "kernel32.dll"): (blob: Uint8Array) => Uint8Array | null {
  const crypt32 = koffi.load(crypt32Path);
  const kernel32 = koffi.load(kernel32Path);
  koffi.struct("CORVUS_DATA_BLOB", { cbData: "uint32_t", pbData: "void *" });
  const unprotect = crypt32.func(
    "int __stdcall CryptUnprotectData(CORVUS_DATA_BLOB *pDataIn, void *ppszDataDescr, CORVUS_DATA_BLOB *pOptionalEntropy, void *pvReserved, void *pPromptStruct, uint32_t dwFlags, _Out_ CORVUS_DATA_BLOB *pDataOut)",
  );
  const localFree = kernel32.func("void * __stdcall LocalFree(void *hMem)");
  return (blob) => {
    if (blob.length === 0) return null;
    const input = koffi.alloc("uint8_t", blob.length);
    try {
      writeBytes(koffi, input, blob);
      const out: { cbData?: number; pbData?: unknown } = {};
      if (!unprotect({ cbData: blob.length, pbData: input }, null, null, null, null, CRYPTPROTECT_UI_FORBIDDEN, out) || !out.pbData) return null;
      const length = out.cbData ?? 0;
      try {
        return length > 0 ? readBytes(koffi, out.pbData, length) : null;
      } finally {
        if (length > 0) wipeBytes(koffi, out.pbData, length);
        localFree(out.pbData);
      }
    } finally {
      koffi.free(input);
    }
  };
}
