#!/usr/bin/env node
// Makes the QR code images the scanner's tests decode (android/src/test/resources/qr): real pairing
// codes, drawn with the same QR encoder as the desktop's "Pair a phone" (`qr`, border 2), then shot
// "through a camera" with ImageMagick: placed in a 1280x960 frame (the size the app analyses),
// rotated, tilted, blurred, noisy, low-contrast, inverted, JPEG-compressed. Each image's expected
// text goes in fixtures.tsv, which the Kotlin test (QrDecoderTest) and the vitest test
// (test/qr-scanner-fixtures.test.ts) both read. The recovery phrases are random test phrases.
//
// Run from the repository root, in the dev container (it has ImageMagick):
//   docker compose run --rm dev sh -c "pnpm --filter @corvus/shared --filter @corvus/sync-core build && node apps/mobile/modules/qr-scanner/scripts/make-fixtures.mjs"
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../../../..");
const outDir = resolve(here, "../android/src/test/resources/qr");

const load = (path) => import(pathToFileURL(join(root, path)).href);
const { encodePairing } = await load("packages/shared/dist/index.js");
const { generateRecoveryPhrase } = await load("packages/sync-core/dist/index.js");
const { encodeQR } = await load("apps/desktop/node_modules/qr/index.js");

const work = mkdtempSync(join(tmpdir(), "qr-fixtures-"));
const magick = (...args) => execFileSync("convert", args.flat(), { stdio: "inherit" });

/** The code as a greyscale PGM, `scale` pixels per module, with the desktop's 2-module border. */
function codePgm(name, text, { scale = 8, dark = 0, light = 255 } = {}) {
  const matrix = encodeQR(text, "raw", { border: 2 });
  const size = matrix.length * scale;
  const pixels = Buffer.alloc(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) pixels[y * size + x] = matrix[Math.floor(y / scale)][Math.floor(x / scale)] ? dark : light;
  }
  const path = join(work, `${name}.pgm`);
  writeFileSync(path, Buffer.concat([Buffer.from(`P5\n${size} ${size}\n255\n`), pixels]));
  return path;
}

const FRAME = ["-size", "1280x960"];
const lan = encodePairing({ serverUrl: "http://192.168.1.20:8787", phrase: generateRecoveryPhrase() });
const https = encodePairing({ serverUrl: "https://sync.example.com", phrase: generateRecoveryPhrase() });

mkdirSync(outDir, { recursive: true });
const fixtures = [];
const add = (file, text, note) => fixtures.push({ file, text, note });

// As the computer shows it: black on white, sharp.
magick(codePgm("screen", https), join(outDir, "screen.png"));
add("screen.png", https, "the code as drawn, black on white");

// A camera frame: the code off-centre on a grey desk, slightly out of focus, sensor noise, JPEG.
magick(FRAME, "xc:#6f6f6f", "(", codePgm("photo", https), "-resize", "440x440", ")", "-geometry", "+560+300", "-composite", "-blur", "0x1.3", "-seed", "1", "-attenuate", "0.6", "+noise", "Gaussian", "-quality", "60", join(outDir, "photo.jpg"));
add("photo.jpg", https, "off-centre in a 1280x960 frame, blurred, noisy, JPEG quality 60");

// The phone held at an angle: rotated 33 degrees.
magick(FRAME, "xc:#6f6f6f", "(", codePgm("rotated", lan), "-resize", "460x460", "-background", "#6f6f6f", "-rotate", "33", ")", "-gravity", "center", "-composite", "-blur", "0x1", "-quality", "70", join(outDir, "rotated.jpg"));
add("rotated.jpg", lan, "rotated 33 degrees, blurred, JPEG");

// The phone not square to the screen: perspective on both axes, the far edges 88% as long as the near
// ones (about 20 degrees off square with the phone 25 cm from a 10 cm code). ZXing still reads this
// code with the far edges at 85%, not at 80%.
magick(FRAME, "xc:#6f6f6f", "(", codePgm("tilted", https), "-resize", "520x520", "-virtual-pixel", "background", "-background", "#6f6f6f", "-distort", "Perspective", "0,0 0,0  519,0 489,31  0,519 31,489  519,519 458,458", ")", "-gravity", "center", "-composite", "-blur", "0x0.8", "-quality", "75", join(outDir, "tilted.jpg"));
add("tilted.jpg", https, "seen about 20 degrees off square on both axes (perspective), JPEG");

// A dim screen in a bright room: grey on grey, light falling off across the frame, noise.
magick(FRAME, "xc:#7d7d7d", "(", codePgm("low-contrast", lan, { dark: 0x5f, light: 0x8f }), "-resize", "520x520", ")", "-gravity", "center", "-composite", "(", "-size", "960x1280", "gradient:#ffffff-#a0a0a0", "-rotate", "90", ")", "-compose", "Multiply", "-composite", "-seed", "2", "-attenuate", "0.3", "+noise", "Gaussian", "-colorspace", "Gray", "-depth", "8", "-quality", "85", join(outDir, "low-contrast.jpg"));
add("low-contrast.jpg", lan, "grey on grey (about 19% contrast), light falling off across the frame, noise, JPEG");

// Held far from the screen: the code is 300 pixels wide, about 4 pixels per module.
magick(FRAME, "xc:#6f6f6f", "(", codePgm("far", https), "-resize", "300x300", ")", "-geometry", "+200+500", "-composite", "-blur", "0x0.7", "-colorspace", "Gray", "-quality", "75", join(outDir, "far.jpg"));
add("far.jpg", https, "small: about 4 pixels per module, JPEG");

// A screen in dark mode: light modules on a dark background.
magick(FRAME, "xc:#141414", "(", codePgm("dark", https, { dark: 0xe6, light: 0x1e }), "-resize", "480x480", ")", "-gravity", "center", "-composite", "-blur", "0x0.8", "-colorspace", "Gray", "-depth", "8", join(outDir, "dark-mode.png"));
add("dark-mode.png", https, "inverted: light modules on dark");

// No code at all.
magick(FRAME, "-seed", "3", "plasma:grey40-grey70", "-colorspace", "Gray", "-quality", "70", join(outDir, "no-code.jpg"));
add("no-code.jpg", "-", "no QR code: nothing is reported");

writeFileSync(
  join(outDir, "fixtures.tsv"),
  ["# file\texpected text (- for none)\tdescription. Made by modules/qr-scanner/scripts/make-fixtures.mjs.", ...fixtures.map((f) => `${f.file}\t${f.text}\t${f.note}`)].join("\n") + "\n",
);
rmSync(work, { recursive: true, force: true });
console.log(`Wrote ${fixtures.length} fixtures to ${outDir}`);
