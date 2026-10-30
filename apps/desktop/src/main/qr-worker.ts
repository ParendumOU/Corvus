// Entry of the QR decoder (an Electron utility process): finds the QR code in one bitmap per message,
// so reading a dozen large phone photos never stalls the browser. Pixels in, text out; nothing else.
import { decodeQrBitmap, type QrEffort } from "./qr-decode";

interface DecodeRequest {
  id: number;
  data: Uint8Array;
  width: number;
  height: number;
  effort: QrEffort;
}

process.parentPort.on("message", (event) => {
  const { id, data, width, height, effort } = event.data as DecodeRequest;
  void decodeQrBitmap(data, width, height, "BGRA", effort).then(
    (text) => process.parentPort.postMessage({ id, text }),
    () => process.parentPort.postMessage({ id, text: null }),
  );
});
