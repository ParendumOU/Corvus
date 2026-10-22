import encodeQR from "qr";
import { describe, expect, it } from "vitest";
import { decodeQrBitmap, totpFromQrText } from "../src/main/qr-decode";

/** Renders a QR code as a 4-bytes-per-pixel bitmap with a quiet zone, like a screenshot would. */
function bitmap(text: string, format: "RGBA" | "BGRA", scale = 6, quiet = 4): { data: Uint8Array; width: number; height: number } {
  const modules = encodeQR(text, "raw");
  const size = (modules.length + quiet * 2) * scale;
  const data = new Uint8Array(size * size * 4).fill(255);
  modules.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (!dark) return;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const px = ((y + quiet) * scale + dy) * size + (x + quiet) * scale + dx;
          data.set(format === "RGBA" ? [0, 0, 0, 255] : [0, 0, 0, 255], px * 4);
        }
      }
    }),
  );
  return { data, width: size, height: size };
}

const URI = "otpauth://totp/Example:alice@example.com?secret=JBSWY3DPEHPK3PXP&issuer=Example";

describe("decodeQrBitmap", () => {
  it("decodes a 2FA setup code from a BGRA bitmap (Electron nativeImage)", async () => {
    const img = bitmap(URI, "BGRA");
    expect(await decodeQrBitmap(img.data, img.width, img.height, "BGRA")).toBe(URI);
  });

  it("decodes RGBA too", async () => {
    const img = bitmap(URI, "RGBA");
    expect(await decodeQrBitmap(img.data, img.width, img.height, "RGBA")).toBe(URI);
  });

  it("explains when there is no code", async () => {
    const blank = new Uint8Array(100 * 100 * 4).fill(255);
    await expect(decodeQrBitmap(blank, 100, 100)).rejects.toThrow(/No QR code/);
  });

  it("rejects tiny or mismatched images", async () => {
    await expect(decodeQrBitmap(new Uint8Array(16), 2, 2)).rejects.toThrow(/too small/);
    await expect(decodeQrBitmap(new Uint8Array(10), 40, 40)).rejects.toThrow(/Unexpected/);
  });
});

describe("totpFromQrText", () => {
  it("returns the link with a readable label", () => {
    expect(totpFromQrText(URI)).toEqual({ uri: URI, label: "Example: alice@example.com" });
  });

  it("explains authenticator export codes and rejects other text", () => {
    expect(() => totpFromQrText("otpauth-migration://offline?data=abc")).toThrow(/export code/);
    expect(() => totpFromQrText("https://example.com")).toThrow(/otpauth/);
  });
});
