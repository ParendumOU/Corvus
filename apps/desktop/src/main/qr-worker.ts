// Entry of the QR decoder (an Electron utility process): finds the QR code in one bitmap per message,
// so reading a dozen large phone photos never stalls the browser. Pixels in, text out; nothing else.
// HEIC photos, which the main process cannot open, come as a file: decoded and scanned here.
import fs from "node:fs";
import { readHeifQr } from "./heic";
import { decodeQrBitmap, type QrEffort } from "./qr-decode";

type DecodeRequest =
  | { id: number; kind: "bitmap"; data: Uint8Array; width: number; height: number; effort: QrEffort }
  | { id: number; kind: "heif"; file: string; effort: QrEffort };

process.parentPort.on("message", (event) => {
  const request = event.data as DecodeRequest;
  const { id } = request;
  if (request.kind === "heif") {
    void fs.promises
      .readFile(request.file)
      .then((bytes) => readHeifQr(bytes, request.effort))
      .catch(() => ({ status: "unreadable" as const }))
      .then((found) => process.parentPort.postMessage({ id, ...found }));
    return;
  }
  const { data, width, height, effort } = request;
  void decodeQrBitmap(data, width, height, "BGRA", effort).then(
    (text) => process.parentPort.postMessage({ id, text }),
    () => process.parentPort.postMessage({ id, text: null }),
  );
});
