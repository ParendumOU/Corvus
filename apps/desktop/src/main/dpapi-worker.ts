// Entry of the DPAPI worker (an Electron utility process), started only while a password import reads
// a browser on Windows and killed when it ends: if the native call crashes or hangs, this process goes
// and the browser stays. A blob in, its plain bytes out over the private channel to the parent, or
// null. Nothing is logged, and the answer is wiped here once sent.
import { loadKoffi, memoryWorks, openDpapi } from "./dpapi-native";

type WorkerRequest = { id: number; blob: Uint8Array } | { id: number; probe: true };

let unprotect: ((blob: Uint8Array) => Uint8Array | null) | null | undefined;

function unprotectOrNull(blob: Uint8Array): Uint8Array | null {
  try {
    unprotect ??= openDpapi(loadKoffi());
    return unprotect(blob);
  } catch {
    return null;
  }
}

function probe(): boolean {
  try {
    return memoryWorks(loadKoffi());
  } catch {
    return false;
  }
}

process.parentPort.on("message", (event) => {
  const request = event.data as WorkerRequest;
  if ("probe" in request) {
    process.parentPort.postMessage({ id: request.id, ok: probe() });
    return;
  }
  const data = unprotectOrNull(request.blob);
  process.parentPort.postMessage({ id: request.id, data });
  data?.fill(0);
});
