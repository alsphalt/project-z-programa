/**
 * Generates the PWA icon set from scratch (no image dependencies).
 *
 * Run with: npm run icons
 *
 * The mark is a terminal prompt (">_") on the DARKNOTE violet -> cyan gradient.
 * Everything is drawn with signed distance fields so the edges stay crisp at
 * every size, and each icon is rendered at its final resolution.
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, "..", "public", "icons");

/* ---------------------------------------------------------------- PNG writer */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const payload = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(payload), 0);
  return Buffer.concat([length, payload, crc]);
}

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------- geometry */

const clamp01 = (value) => (value < 0 ? 0 : value > 1 ? 1 : value);

/** Signed distance to a rounded box centred on (cx, cy). */
function sdRoundBox(px, py, cx, cy, halfW, halfH, radius) {
  const qx = Math.abs(px - cx) - (halfW - radius);
  const qy = Math.abs(py - cy) - (halfH - radius);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - radius;
}

/** Signed distance to a capsule (thick line with round caps). */
function sdSegment(px, py, ax, ay, bx, by, radius) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const lengthSquared = vx * vx + vy * vy || 1;
  const t = clamp01((wx * vx + wy * vy) / lengthSquared);
  return Math.hypot(wx - vx * t, wy - vy * t) - radius;
}

/* -------------------------------------------------------------------- palette */

const STOPS = [
  { at: 0, rgb: [76, 60, 224] }, // accent-deep
  { at: 0.52, rgb: [109, 94, 252] }, // accent
  { at: 1, rgb: [47, 184, 217] }, // cyber, slightly deepened for glyph contrast
];

function gradientAt(t) {
  const value = clamp01(t);
  for (let i = 1; i < STOPS.length; i += 1) {
    const prev = STOPS[i - 1];
    const next = STOPS[i];
    if (value <= next.at) {
      const span = next.at - prev.at || 1;
      const local = (value - prev.at) / span;
      return [
        prev.rgb[0] + (next.rgb[0] - prev.rgb[0]) * local,
        prev.rgb[1] + (next.rgb[1] - prev.rgb[1]) * local,
        prev.rgb[2] + (next.rgb[2] - prev.rgb[2]) * local,
      ];
    }
  }
  return STOPS[STOPS.length - 1].rgb;
}

/** Coverage from a signed distance, anti-aliased over one device pixel. */
const coverage = (distance) => clamp01(0.5 - distance);

/* ---------------------------------------------------------------------- paint */

function renderIcon({ size, maskable }) {
  const rgba = Buffer.alloc(size * size * 4);
  const radius = maskable ? size * 0.5 : size * 0.22;
  const cx = size / 2;
  const cy = size / 2;
  const half = size / 2;

  // Maskable icons keep the mark inside the 80% safe zone.
  const scale = maskable ? 0.78 : 1;

  const stroke = size * 0.072 * scale;
  const points = {
    a: [size * 0.33, size * 0.345],
    b: [size * 0.475, size * 0.5],
    c: [size * 0.33, size * 0.655],
    d: [size * 0.545, size * 0.655],
    e: [size * 0.7, size * 0.655],
  };
  // Re-centre the glyph (scaled around the canvas centre).
  const recentre = (point) => [cx + (point[0] - cx) * scale, cy + (point[1] - cy) * scale];

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const px = x + 0.5;
      const py = y + 0.5;

      const plateDistance = sdRoundBox(px, py, cx, cy, half, half, radius);
      const plateAlpha = coverage(plateDistance);
      if (plateAlpha <= 0) continue;

      // Diagonal gradient with a soft vignette so the plate reads as a surface.
      const t = (px + py) / (2 * size);
      const base = gradientAt(t);
      const distanceFromCentre = Math.hypot(px - cx, py - cy) / half;
      const vignette = 1 - 0.16 * clamp01((distanceFromCentre - 0.35) / 0.85) ** 2;
      let r = base[0] * vignette;
      let g = base[1] * vignette;
      let b = base[2] * vignette;

      // Terminal prompt glyph.
      const [ax, ay] = recentre(points.a);
      const [bx, by] = recentre(points.b);
      const [cxx, cyy] = recentre(points.c);
      const [dx, dy] = recentre(points.d);
      const [ex, ey] = recentre(points.e);

      const glyph = Math.min(
        sdSegment(px, py, ax, ay, bx, by, stroke),
        sdSegment(px, py, bx, by, cxx, cyy, stroke),
        sdSegment(px, py, dx, dy, ex, ey, stroke),
      );
      const glyphAlpha = coverage(glyph) * 0.97;
      if (glyphAlpha > 0) {
        r = r + (255 - r) * glyphAlpha;
        g = g + (255 - g) * glyphAlpha;
        b = b + (255 - b) * glyphAlpha;
      }

      const offset = (y * size + x) * 4;
      rgba[offset] = Math.round(r);
      rgba[offset + 1] = Math.round(g);
      rgba[offset + 2] = Math.round(b);
      rgba[offset + 3] = Math.round(plateAlpha * 255);
    }
  }

  return encodePng(size, size, rgba);
}

/* ---------------------------------------------------------------------- write */

const targets = [
  { file: "icon-192.png", size: 192, maskable: false },
  { file: "icon-512.png", size: 512, maskable: false },
  { file: "icon-maskable-192.png", size: 192, maskable: true },
  { file: "icon-maskable-512.png", size: 512, maskable: true },
  { file: "apple-touch-icon.png", size: 180, maskable: true },
];

mkdirSync(outDir, { recursive: true });
for (const target of targets) {
  const png = renderIcon(target);
  writeFileSync(resolve(outDir, target.file), png);
  console.log(`icons: ${target.file} ${target.size}x${target.size} (${png.length} bytes)`);
}

// Next.js picks these up through the file conventions in src/app.
const appDir = resolve(here, "..", "src", "app");
writeFileSync(resolve(appDir, "icon.png"), renderIcon({ size: 192, maskable: false }));
writeFileSync(resolve(appDir, "apple-icon.png"), renderIcon({ size: 180, maskable: true }));
console.log("icons: src/app/icon.png, src/app/apple-icon.png");
