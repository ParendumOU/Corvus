/**
 * Local QR decoding for 2FA setup codes. Pixels come from Electron's nativeImage (BGRA bitmap) and are
 * decoded with paulmillr's `qr` (MIT OR Apache-2.0, no dependencies), loaded lazily so the decoder
 * only costs anything when someone imports a QR code. Nothing leaves the machine.
 */
import { parseOtpauthUri } from "../shared/totp";

export type PixelFormat = "BGRA" | "RGBA";

/** Decodes the text of the first QR code in a raw 4-bytes-per-pixel bitmap. */
export async function decodeQrBitmap(data: Uint8Array, width: number, height: number, format: PixelFormat = "BGRA"): Promise<string> {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 21 || height < 21) throw new Error("The image is too small to hold a QR code.");
  if (data.length !== width * height * 4) throw new Error("Unexpected image data.");
  const { decodeQR } = await import("qr/decode.js");
  try {
    return decodeQR({ width, height, data }, { format, effort: 3, timeLimit: 2000 });
  } catch {
    throw new Error("No QR code was found in that image.");
  }
}

/**
 * Validates decoded QR text as a TOTP setup link and returns it with a readable label. Google
 * Authenticator bulk exports (otpauth-migration://) get a clear explanation instead of a parse error.
 */
export function totpFromQrText(text: string): { uri: string; label: string } {
  const trimmed = text.trim();
  if (/^otpauth-migration:/i.test(trimmed)) {
    throw new Error("This is an authenticator app export code. Scan the setup QR code from the site itself, or add the secret manually.");
  }
  const parsed = parseOtpauthUri(trimmed);
  const label = [parsed.issuer, parsed.account].filter(Boolean).join(": ");
  return { uri: trimmed, label };
}
