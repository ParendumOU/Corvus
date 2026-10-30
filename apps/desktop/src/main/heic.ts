/**
 * HEIC/HEIF photos, what iPhone cameras save by default and what Electron's nativeImage cannot open on
 * Windows. Decoded with libheif (LGPL-3.0, with libde265 for HEVC) compiled to WebAssembly by
 * libheif-js, loaded the first time such a photo is read, in the QR decoder's utility process. The
 * photo is scanned for its QR code with the same sizes and retries as any other photo.
 */
import type { LibHeif } from "libheif-js/wasm-bundle";
import { decodeQrBitmap, scaleBitmap, scanPhoto, type Bitmap, type QrEffort } from "./qr-decode";

/** Brands of the "ftyp" box that mark a HEIF image (HEVC-coded HEIC and the generic HEIF ones). */
const HEIF_BRANDS = new Set(["heic", "heix", "heim", "heis", "hevc", "hevx", "hevm", "hevs", "mif1", "mif2", "msf1"]);

/** Bigger than any phone photo (a 48 MP iPhone photo is 8064 x 6048): what is decoded at most. */
const MAX_PIXELS = 64 * 1024 * 1024;

/** True when a file starts like a HEIF image, whatever its name says (its first 64 bytes are enough). */
export function isHeif(head: Uint8Array): boolean {
  if (head.length < 12) return false;
  const fourcc = (at: number): string => String.fromCharCode(...head.subarray(at, at + 4));
  if (fourcc(4) !== "ftyp") return false;
  const size = ((head[0]! << 24) | (head[1]! << 16) | (head[2]! << 8) | head[3]!) >>> 0;
  // The major brand, then (after the minor version) the compatible brands.
  const brands = [fourcc(8)];
  for (let at = 16; at + 4 <= Math.min(size, head.length); at += 4) brands.push(fourcc(at));
  return brands.some((b) => HEIF_BRANDS.has(b));
}

let loading: Promise<LibHeif> | null = null;

/** libheif with its WebAssembly inside the module (nothing read from disk), loaded once. */
function libheif(): Promise<LibHeif> {
  loading ??= import("libheif-js/wasm-bundle").then((mod) => (mod as { default?: LibHeif }).default ?? (mod as unknown as LibHeif));
  return loading;
}

/** The main image of a HEIF file (its largest), as RGBA, turned and mirrored as the file says. */
export async function decodeHeif(bytes: Uint8Array): Promise<Bitmap> {
  const lib = await libheif();
  const decoder = new lib.HeifDecoder();
  const images = decoder.decode(bytes);
  try {
    const image = [...images].sort((a, b) => b.get_width() * b.get_height() - a.get_width() * a.get_height())[0];
    if (!image) throw new Error("No image in the HEIF file.");
    const width = image.get_width();
    const height = image.get_height();
    if (width < 1 || height < 1 || width * height > MAX_PIXELS) throw new Error("The HEIF image is too large.");
    const data = new Uint8ClampedArray(width * height * 4);
    const shown = await new Promise<unknown>((resolve) => image.display({ data, width, height }, resolve));
    if (!shown) throw new Error("The HEIF image could not be decoded.");
    return { data: new Uint8Array(data.buffer), width, height };
  } finally {
    for (const image of images) image.free();
    if (decoder.decoder) lib.heif_context_free(decoder.decoder);
  }
}

/** The text of the QR code in a HEIF photo, or why there is none (the file could not be decoded). */
export async function readHeifQr(bytes: Uint8Array, effort: QrEffort): Promise<{ text: string } | { status: "unreadable" | "none" }> {
  let photo: Bitmap;
  try {
    photo = await decodeHeif(bytes);
  } catch {
    return { status: "unreadable" };
  }
  const text = await scanPhoto(
    Math.max(photo.width, photo.height),
    (size) => scaleBitmap(photo, size),
    (b) => decodeQrBitmap(b.data, b.width, b.height, "RGBA", effort).catch(() => null),
  );
  return text ? { text } : { status: "none" };
}
