/**
 * Local QR decoding for 2FA setup codes. Pixels come from Electron's nativeImage (BGRA bitmap) and are
 * decoded with paulmillr's `qr` (MIT OR Apache-2.0, no dependencies), loaded lazily so the decoder
 * only costs anything when someone imports a QR code. Nothing leaves the machine.
 */
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
