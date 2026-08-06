/**
 * Minimal PNG writer — truecolour, 8-bit, no filters — for screenshots and
 * local previews. Nearest-neighbour `scale` keeps LED pixels as crisp squares.
 */
import { deflateSync } from 'node:zlib';

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

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** Encode row-major RGB888 pixels as a PNG, scaled up by an integer factor. */
export function encodePng(rgb: Uint8Array, width: number, height: number, scale = 1): Buffer {
  if (rgb.length !== width * height * 3) {
    throw new Error(`expected ${width * height * 3} bytes of RGB, got ${rgb.length}`);
  }

  // Scanlines with a leading filter byte (0 = none) per row.
  const rowBytes = width * scale * 3;
  const raw = Buffer.alloc((rowBytes + 1) * height * scale);
  let o = 0;
  for (let y = 0; y < height; y++) {
    const rowStart = o;
    raw[o++] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const src = (y * width + x) * 3;
      for (let s = 0; s < scale; s++) {
        raw[o++] = rgb[src]!;
        raw[o++] = rgb[src + 1]!;
        raw[o++] = rgb[src + 2]!;
      }
    }
    // Repeat the scanline `scale` times for vertical scaling.
    for (let s = 1; s < scale; s++) {
      raw.copyWithin(o, rowStart, rowStart + rowBytes + 1);
      o += rowBytes + 1;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width * scale, 0);
  ihdr.writeUInt32BE(height * scale, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
