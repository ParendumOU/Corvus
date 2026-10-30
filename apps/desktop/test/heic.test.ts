import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseMigrationUri } from "../src/shared/authenticator-migration";
import { base32Encode } from "../src/shared/totp";
import { decodeHeif, isHeif, readHeifQr } from "../src/main/heic";
import { scaleBitmap, scanPhoto, type Bitmap } from "../src/main/qr-decode";

/**
 * A HEIC photo like an iPhone's (2016 x 1512, HEVC, YCbCr 4:2:0, 4 x 3 grid of 512 px tiles) of a
 * screen showing a Google Authenticator export QR code with two made-up accounts. Made in Docker:
 * the code drawn with `qr` from encodeMigrationPayload (fake secrets below), slightly turned, with
 * noise, encoded by libheif's heif-enc (x265, -q 30 --cut-tiles 512) on debian:trixie.
 */
const FIXTURE = path.join(import.meta.dirname, "fixtures/heic/export-photo.heic");
const fakeSecret = (seed: number): string => base32Encode(Uint8Array.from({ length: 20 }, (_, i) => (seed * 41 + i * 13 + 5) & 0xff));
const EFFORT = { effort: 4, timeLimit: 3000 };

describe("isHeif", () => {
  it("knows a HEIF file by its ftyp box, not by its name", () => {
    expect(isHeif(fs.readFileSync(FIXTURE).subarray(0, 64))).toBe(true);
    const box = (major: string, ...compatible: string[]): Uint8Array => {
      const size = 16 + compatible.length * 4;
      return Uint8Array.from([0, 0, 0, size, ...Buffer.from(`ftyp${major}`), 0, 0, 0, 0, ...Buffer.from(compatible.join(""))]);
    };
    expect(isHeif(box("heic", "mif1", "heic"))).toBe(true);
    expect(isHeif(box("mif1", "heic"))).toBe(true);
    expect(isHeif(box("isom", "mp41"))).toBe(false);
    expect(isHeif(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1]))).toBe(false);
    expect(isHeif(new Uint8Array(4))).toBe(false);
  });
});

describe("HEIC photos", () => {
  it("decodes the photo to RGBA at its full size", async () => {
    const image = await decodeHeif(fs.readFileSync(FIXTURE));
    expect([image.width, image.height]).toEqual([2016, 1512]);
    expect(image.data.length).toBe(2016 * 1512 * 4);
    // The light screen around the code, the dark bezel at the edge.
    const at = (x: number, y: number): number => image.data[(y * image.width + x) * 4]!;
    expect(at(1048, 190)).toBeGreaterThan(180);
    expect(at(10, 10)).toBeLessThan(110);
  });

  it("reads the export QR code with the photo pipeline and gets every account", async () => {
    const found = await readHeifQr(fs.readFileSync(FIXTURE), EFFORT);
    expect("text" in found).toBe(true);
    const batch = parseMigrationUri((found as { text: string }).text);
    expect(batch).toMatchObject({ batchSize: 1, batchIndex: 0, batchId: 424242 });
    expect(batch.accounts.map((a) => [a.issuer, a.account, a.config.secret])).toEqual([
      ["Corvus HEIC Smoke", "heic-smoke@example.com", fakeSecret(1)],
      ["heic.example.org", "heic-second@example.org", fakeSecret(2)],
    ]);
  }, 60_000);

  it("says a cut-off or damaged HEIC file cannot be read", async () => {
    const bytes = fs.readFileSync(FIXTURE);
    expect(await readHeifQr(bytes.subarray(0, 120), EFFORT)).toEqual({ status: "unreadable" });
    expect(await readHeifQr(new Uint8Array(100), EFFORT)).toEqual({ status: "unreadable" });
  });
});

describe("scaleBitmap", () => {
  it("averages the pixels each one covers and keeps the shape", () => {
    // 4 x 2: two 2 x 2 blocks, black and white.
    const data = new Uint8Array(4 * 2 * 4);
    for (let y = 0; y < 2; y++) for (let x = 2; x < 4; x++) data.fill(255, (y * 4 + x) * 4, (y * 4 + x) * 4 + 4);
    const half = scaleBitmap({ data, width: 4, height: 2 }, 2);
    expect([half.width, half.height]).toEqual([2, 1]);
    expect([...half.data]).toEqual([0, 0, 0, 0, 255, 255, 255, 255]);
    const one = scaleBitmap({ data, width: 4, height: 2 }, 1);
    expect([one.width, one.height, one.data[0]]).toEqual([1, 1, 128]);
  });

  it("returns a copy at the same size and never scales up", () => {
    const src: Bitmap = { data: Uint8Array.from([1, 2, 3, 4]), width: 1, height: 1 };
    const same = scaleBitmap(src, 10);
    same.data[0] = 99;
    expect(same.width).toBe(1);
    expect(src.data[0]).toBe(1);
  });
});

describe("scanPhoto", () => {
  it("tries every size dark on light, then the likeliest two inverted, and stops at the first text", async () => {
    const seen: string[] = [];
    const at = (size: number): Bitmap => ({ data: new Uint8Array(4).fill(10), width: 1, height: 1, size } as Bitmap & { size: number });
    const decode = async (b: Bitmap): Promise<string | null> => {
      seen.push(`${(b as Bitmap & { size: number }).size}${b.data[0] === 245 ? "i" : ""}`);
      return null;
    };
    expect(await scanPhoto(2200, at, decode)).toBeNull();
    expect(seen).toEqual(["1600", "2000", "1100", "2200", "1600i", "2000i"]);
    seen.length = 0;
    const second = async (b: Bitmap): Promise<string | null> => {
      await decode(b);
      return seen.length === 2 ? "found" : null;
    };
    expect(await scanPhoto(2200, at, second)).toBe("found");
    expect(seen).toEqual(["1600", "2000"]);
  });
});
