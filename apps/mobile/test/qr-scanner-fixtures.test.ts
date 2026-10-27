import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkPairingCode } from "../src/lib/pairing";

// The QR images the Android scanner's Kotlin test decodes (QrDecoderTest): here, what they hold must
// be what the pairing screen accepts once the scanner reports it.
const dir = fileURLToPath(new URL("../modules/qr-scanner/android/src/test/resources/qr", import.meta.url));
const fixtures = readFileSync(join(dir, "fixtures.tsv"), "utf8")
  .split("\n")
  .filter((line) => line.trim() && !line.startsWith("#"))
  .map((line) => {
    const [file, expected, note] = line.split("\t");
    return { file, expected: expected === "-" ? null : expected, note };
  });

describe("QR scanner fixtures", () => {
  it("cover a clean code, camera-like shots and an image without a code", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(6);
    expect(fixtures.some((f) => f.file.endsWith(".png"))).toBe(true);
    expect(fixtures.some((f) => f.file.endsWith(".jpg"))).toBe(true);
    expect(fixtures.map((f) => f.file)).toEqual(expect.arrayContaining(["rotated.jpg", "low-contrast.jpg", "no-code.jpg"]));
    expect(fixtures.filter((f) => f.expected === null)).toHaveLength(1);
  });

  it.each(fixtures)("$file is a real PNG or JPEG image", ({ file }) => {
    const head = readFileSync(join(dir, file)).subarray(0, 4);
    const png = head.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const jpeg = head[0] === 0xff && head[1] === 0xd8;
    expect(png || jpeg).toBe(true);
    expect(png).toBe(file.endsWith(".png"));
  });

  it.each(fixtures.filter((f) => f.expected !== null))("$file holds a pairing code the pairing screen accepts", ({ expected }) => {
    const check = checkPairingCode(expected!);
    expect(check.ok).toBe(true);
    if (check.ok) {
      expect(["https://sync.example.com", "http://192.168.1.20:8787"]).toContain(check.info.serverUrl);
      expect(check.info.phrase.split(" ")).toHaveLength(24);
    }
  });
});
