// Draws the Library tab icon (a bookmark ribbon) as template PNGs at 1x/2x/3x (24/48/72 px):
// black on transparent, anti-aliased by supersampling. Run in Docker: node scripts/make-tab-icon.mjs
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
};

/** Ribbon in a 24-unit box: rounded top, notch at the bottom, 2-unit stroke. */
function inside(x, y) {
  const outer = (px, py) => px >= 5 && px <= 19 && py >= 3 && py <= 21 && py <= 21 - (7 - Math.abs(px - 12)) * (4 / 7);
  const inner = (px, py) => px >= 7 && px <= 17 && py >= 5 && py <= 18.2 - (5 - Math.abs(px - 12)) * (4 / 7) - 0.6;
  return outer(x, y) && !inner(x, y);
}

function png(size) {
  const ss = 4;
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4);
    for (let x = 0; x < size; x++) {
      let hits = 0;
      for (let sy = 0; sy < ss; sy++)
        for (let sx = 0; sx < ss; sx++) if (inside(((x + (sx + 0.5) / ss) * 24) / size, ((y + (sy + 0.5) / ss) * 24) / size)) hits++;
      row[1 + x * 4 + 3] = Math.round((255 * hits) / (ss * ss));
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))]);
}

const dir = new URL("../assets/images/tabIcons/", import.meta.url);
for (const [suffix, size] of [["", 24], ["@2x", 48], ["@3x", 72]]) writeFileSync(new URL(`library${suffix}.png`, dir), png(size));
console.log("wrote the Library tab icon at 1x, 2x and 3x");
