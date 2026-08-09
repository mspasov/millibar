import { describe, expect, test } from 'bun:test';
import { inflateSync } from 'node:zlib';
import { encodePng } from './png';

/** Reference CRC-32, written bitwise — deliberately not the table form the
 * encoder uses, so the two cannot share a copied mistake. */
function crcRef(bytes: Uint8Array): number {
  let c = ~0 >>> 0;
  for (const b of bytes) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

/** Independent chunk walk: length-prefixed, typed, CRC over type+data. */
function chunks(png: Buffer): { type: string; data: Buffer }[] {
  const out: { type: string; data: Buffer }[] = [];
  let off = 8;
  while (off < png.length) {
    const length = png.readUInt32BE(off);
    const type = png.subarray(off + 4, off + 8).toString('ascii');
    const data = png.subarray(off + 8, off + 8 + length);
    expect(png.readUInt32BE(off + 8 + length)).toBe(crcRef(png.subarray(off + 4, off + 8 + length)));
    out.push({ type, data });
    off += 12 + length;
  }
  return out;
}

describe('encodePng', () => {
  const pixels = Uint8Array.from([
    255, 0, 0,   0, 255, 0, // red, green
    0, 0, 255,   17, 34, 51, // blue, dark mix
  ]);

  test('round-trips through an independent decode, scanlines unfiltered', () => {
    const png = encodePng(pixels, 2, 2);
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    const [ihdr, idat, iend] = chunks(png);
    expect(ihdr!.type).toBe('IHDR');
    expect(ihdr!.data.readUInt32BE(0)).toBe(2); // width
    expect(ihdr!.data.readUInt32BE(4)).toBe(2); // height
    // depth 8, truecolour, deflate, no filter, no interlace
    expect([...ihdr!.data.subarray(8)]).toEqual([8, 2, 0, 0, 0]);
    expect(iend!.type).toBe('IEND');
    expect(iend!.data.length).toBe(0);

    expect(idat!.type).toBe('IDAT');
    const raw = inflateSync(idat!.data);
    expect([...raw]).toEqual([
      0, 255, 0, 0, 0, 255, 0, // filter byte, then the row's pixels
      0, 0, 0, 255, 17, 34, 51,
    ]);
  });

  test('integer scale repeats pixels across and rows down', () => {
    const png = encodePng(Uint8Array.from([255, 0, 0, 0, 0, 255]), 2, 1, 2);
    const [ihdr, idat] = chunks(png);
    expect(ihdr!.data.readUInt32BE(0)).toBe(4);
    expect(ihdr!.data.readUInt32BE(4)).toBe(2);
    const row = [0, 255, 0, 0, 255, 0, 0, 0, 0, 255, 0, 0, 255];
    expect([...inflateSync(idat!.data)]).toEqual([...row, ...row]);
  });

  test('a byte count that disagrees with the dimensions throws', () => {
    expect(() => encodePng(Uint8Array.from([1, 2, 3]), 2, 2)).toThrow(/expected 12 bytes/);
  });
});
