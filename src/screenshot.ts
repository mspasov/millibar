/**
 * Captures a BUSY Bar display and writes it as a scaled-up PNG.
 *
 * Usage: bun run src/screenshot.ts [out.png] [front|back] [scale]
 *
 * `GET /api/screen` returns a base64-encoded **BGR888** framebuffer — the
 * OpenAPI spec claims `image/bmp` and the channel order is not RGB. Reading it
 * as RGB silently swaps red and blue, which looks plausible enough to go
 * unnoticed (greens and greys are unaffected). The official library does the
 * same swap in Global/utils/frameData.ts:bgrToRgba.
 */
import { deflateSync } from 'node:zlib';

const DISPLAYS = {
  front: { index: 0, width: 72, height: 16 },
  back: { index: 1, width: 160, height: 80 },
} as const;

const [outPath = 'screen.png', displayName = 'front', scaleArg] = process.argv.slice(2);
const display = DISPLAYS[displayName as keyof typeof DISPLAYS];
if (!display) throw new Error(`display must be one of: ${Object.keys(DISPLAYS).join(', ')}`);
const scale = Number(scaleArg ?? 10);

const addr = process.env.BUSY_BAR_ADDR ?? '10.0.4.20';
const response = await fetch(`http://${addr}/api/screen?display=${display.index}`, {
  signal: AbortSignal.timeout(10_000),
});
if (!response.ok) throw new Error(`screen capture failed: HTTP ${response.status}`);

const bgr = Buffer.from((await response.text()).trim(), 'base64');
const { width, height } = display;
const expected = width * height * 3;
if (bgr.length < expected) {
  throw new Error(`short framebuffer: got ${bgr.length} bytes, expected ${expected}`);
}

// Scale up and convert BGR -> RGB into PNG scanlines (filter byte 0 per row).
const rowBytes = width * scale * 3;
const raw = Buffer.alloc((rowBytes + 1) * height * scale);
let o = 0;
for (let y = 0; y < height; y++) {
  const rowStart = o;
  raw[o++] = 0; // filter: none
  for (let x = 0; x < width; x++) {
    const src = (y * width + x) * 3;
    for (let s = 0; s < scale; s++) {
      raw[o++] = bgr[src + 2]!;
      raw[o++] = bgr[src + 1]!;
      raw[o++] = bgr[src]!;
    }
  }
  // Repeat the scanline `scale` times for vertical scaling.
  for (let s = 1; s < scale; s++) {
    raw.copyWithin(o, rowStart, rowStart + rowBytes + 1);
    o += rowBytes + 1;
  }
}

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(width * scale, 0);
ihdr.writeUInt32BE(height * scale, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 2; // colour type: truecolour

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0)),
]);

await Bun.write(outPath, png);
const lit = Array.from({ length: width * height }, (_, i) => bgr.readUIntBE(i * 3, 3)).filter(Boolean).length;
console.log(`Wrote ${outPath} (${width}x${height} @ ${scale}x, ${lit}/${width * height} pixels lit)`);
