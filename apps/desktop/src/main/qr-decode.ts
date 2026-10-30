/**
 * Local QR decoding for 2FA setup codes. Pixels come from Electron's nativeImage (BGRA bitmap) and are
 * decoded with paulmillr's `qr` (MIT OR Apache-2.0, no dependencies), loaded lazily so the decoder
 * only costs anything when someone imports a QR code. Nothing leaves the machine.
 */
import { photoScales } from "../shared/authenticator-import";
import { parseOtpauthUri } from "../shared/totp";

export type PixelFormat = "BGRA" | "RGBA";

/** How hard to look: the retry tier and the time it may take (see the `qr` package's DecodeOpts). */
export interface QrEffort {
  effort: number;
  timeLimit: number;
}

/** A screenshot of a setup page: sharp and straight, found at once. */
const SCREENSHOT: QrEffort = { effort: 3, timeLimit: 2000 };

/** Decodes the text of the first QR code in a raw 4-bytes-per-pixel bitmap. */
export async function decodeQrBitmap(data: Uint8Array, width: number, height: number, format: PixelFormat = "BGRA", effort: QrEffort = SCREENSHOT): Promise<string> {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 21 || height < 21) throw new Error("The image is too small to hold a QR code.");
  if (data.length !== width * height * 4) throw new Error("Unexpected image data.");
  const { decodeQR } = await import("qr/decode.js");
  try {
    return decodeQR({ width, height, data }, { format, ...effort });
  } catch {
    throw new Error("No QR code was found in that image.");
  }
}

/** Turns a 4-bytes-per-pixel bitmap into its negative in place (alpha kept): light codes on dark screens. */
export function invertBitmap(data: Uint8Array): void {
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 255 - data[i]!;
    data[i + 1] = 255 - data[i + 1]!;
    data[i + 2] = 255 - data[i + 2]!;
  }
}

/** A raw image, 4 bytes per pixel (BGRA or RGBA: the scaling below treats channels alike). */
export interface Bitmap {
  data: Uint8Array;
  width: number;
  height: number;
}

/** Where each of `to` output pixels starts among `from` source pixels (to <= from), plus the end. */
function spans(from: number, to: number): Int32Array {
  const edges = new Int32Array(to + 1);
  for (let i = 0; i <= to; i++) edges[i] = Math.round((i * from) / to);
  return edges;
}

/**
 * The bitmap scaled down to a long side, each pixel the average of the ones it covers (a box filter,
 * like a "good" quality resize): a new bitmap the caller may change. Never scales up.
 */
export function scaleBitmap({ data, width, height }: Bitmap, longSide: number): Bitmap {
  const long = Math.max(width, height);
  if (longSide >= long) return { data: data.slice(), width, height };
  const w = Math.max(1, Math.round((width * longSide) / long));
  const h = Math.max(1, Math.round((height * longSide) / long));
  const xs = spans(width, w);
  const ys = spans(height, h);
  // Rows first (w x height), then columns (w x h).
  const mid = new Uint8Array(w * height * 4);
  for (let y = 0; y < height; y++) {
    const row = y * width * 4;
    for (let x = 0; x < w; x++) {
      const from = xs[x]!, to = xs[x + 1]!;
      let c0 = 0, c1 = 0, c2 = 0, c3 = 0;
      for (let i = row + from * 4, end = row + to * 4; i < end; i += 4) {
        c0 += data[i]!;
        c1 += data[i + 1]!;
        c2 += data[i + 2]!;
        c3 += data[i + 3]!;
      }
      const n = to - from, o = (y * w + x) * 4;
      mid[o] = c0 / n + 0.5;
      mid[o + 1] = c1 / n + 0.5;
      mid[o + 2] = c2 / n + 0.5;
      mid[o + 3] = c3 / n + 0.5;
    }
  }
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const from = ys[y]!, to = ys[y + 1]!, n = to - from;
    for (let x = 0; x < w; x++) {
      let c0 = 0, c1 = 0, c2 = 0, c3 = 0;
      for (let r = from; r < to; r++) {
        const i = (r * w + x) * 4;
        c0 += mid[i]!;
        c1 += mid[i + 1]!;
        c2 += mid[i + 2]!;
        c3 += mid[i + 3]!;
      }
      const o = (y * w + x) * 4;
      out[o] = c0 / n + 0.5;
      out[o + 1] = c1 / n + 0.5;
      out[o + 2] = c2 / n + 0.5;
      out[o + 3] = c3 / n + 0.5;
    }
  }
  return { data: out, width: w, height: h };
}

/**
 * Looks for the QR code in a photo of a screen: dark on light at each size `photoScales` gives, then
 * light on dark (a code shown in a dark theme) at the likeliest two. `at` scales the photo to a long
 * side (a bitmap the scan may change, or null to skip that size); `decode` finds the text or null.
 */
export async function scanPhoto(longSide: number, at: (size: number) => Bitmap | null, decode: (bitmap: Bitmap) => Promise<string | null>): Promise<string | null> {
  const sizes = photoScales(longSide);
  const tries = [...sizes.map((size) => ({ size, invert: false })), ...sizes.slice(0, 2).map((size) => ({ size, invert: true }))];
  for (const { size, invert } of tries) {
    const bitmap = at(size);
    if (!bitmap || bitmap.data.length !== bitmap.width * bitmap.height * 4) continue;
    if (invert) invertBitmap(bitmap.data);
    const text = await decode(bitmap);
    if (text) return text;
  }
  return null;
}

/**
 * Validates decoded QR text as a TOTP setup link and returns it with a readable label. Google
 * Authenticator bulk exports (otpauth-migration://) get a pointer to the import that reads them.
 */
export function totpFromQrText(text: string): { uri: string; label: string } {
  const trimmed = text.trim();
  if (/^otpauth-migration:/i.test(trimmed)) {
    throw new Error("This is a Google Authenticator export code. Use \"Import from Google Authenticator\" on the Passwords page to import every account in it.");
  }
  const parsed = parseOtpauthUri(trimmed);
  const label = [parsed.issuer, parsed.account].filter(Boolean).join(": ");
  return { uri: trimmed, label };
}
