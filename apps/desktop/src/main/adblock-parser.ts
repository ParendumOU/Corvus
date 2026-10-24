// Entry of the filter list parser (an Electron utility process): turns downloaded lists into a
// serialized engine, so parsing a hundred thousand rules never stalls the browser's main process.
// One request per process; it exits once it has answered.
import { buildEngine } from "./adblock-engine";

interface ParseRequest {
  lists: string;
  resources: string | null;
}

process.parentPort.once("message", (event) => {
  const { lists, resources } = event.data as ParseRequest;
  try {
    const built = buildEngine(lists, resources);
    process.parentPort.postMessage({ ok: true, bytes: built.bytes, filterCount: built.filterCount });
  } catch (err) {
    process.parentPort.postMessage({ ok: false, error: (err as Error).message });
  }
});
