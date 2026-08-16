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

// ------------------------------------------------------------------ APNG --

export interface ApngFrame {
  /** Full-canvas RGB888, `width * height * 3` bytes. */
  rgb: Uint8Array;
  /** How long this frame stays up. Encoded in ms (delay_den 1000); the
   * field is 16-bit, so 65535 ms is the ceiling. */
  delayMs: number;
}

export interface ApngOptions {
  /** A frame that is shown by viewers that do not animate (and by anything
   * that just wants "the picture") but is not part of the loop — the APNG
   * default image, carried in IDAT with no fcTL of its own. Use the settled
   * hero frame so a still render is what a still viewer gets. When omitted,
   * the first animation frame doubles as the default image. */
  still?: Uint8Array;
  /** 0 = loop forever (the default). */
  loops?: number;
}

/** PNG scanline filters, chosen per row by the usual minimum-sum heuristic:
 * the bloom gradients around lit LEDs are smooth, and Sub/Up/Paeth roughly
 * halve what deflate has to store versus unfiltered rows. `rows` is packed
 * `bpp`-byte pixels, `w` pixels per row, no filter bytes yet. */
function filterRows(rows: Uint8Array, w: number, h: number, bpp: number): Buffer {
  const rowBytes = w * bpp;
  const out = Buffer.alloc((rowBytes + 1) * h);
  const prev = new Uint8Array(rowBytes); // zeros above the first row, per spec
  const cand = new Uint8Array(rowBytes);
  let o = 0;
  for (let y = 0; y < h; y++) {
    const cur = rows.subarray(y * rowBytes, (y + 1) * rowBytes);
    let bestType = 0;
    let bestSum = Infinity;
    let best: Uint8Array | null = null;
    for (let type = 0; type < 5; type++) {
      let sum = 0;
      for (let i = 0; i < rowBytes; i++) {
        const a = i >= bpp ? cur[i - bpp]! : 0;
        const b = prev[i]!;
        const c = i >= bpp ? prev[i - bpp]! : 0;
        let pred = 0;
        if (type === 1) pred = a;
        else if (type === 2) pred = b;
        else if (type === 3) pred = (a + b) >> 1;
        else if (type === 4) {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        }
        const v = (cur[i]! - pred) & 0xff;
        cand[i] = v;
        sum += v < 128 ? v : 256 - v;
      }
      if (sum < bestSum) {
        bestSum = sum;
        bestType = type;
        best = Uint8Array.from(cand);
      }
    }
    out[o++] = bestType;
    out.set(best!, o);
    o += rowBytes;
    prev.set(cur);
  }
  return out;
}

/** Bounding box of the pixels that differ between two full-canvas frames;
 * null when they are identical. */
function changedBox(a: Uint8Array, b: Uint8Array, width: number, height: number) {
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 3;
      if (a[o] === b[o] && a[o + 1] === b[o + 1] && a[o + 2] === b[o + 2]) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/**
 * Animated PNG with delta frames, the way the APNG optimizers do it: every
 * frame after the first carries only the bounding box of what changed, as
 * RGBA blended OVER the previous frame with every *unchanged* pixel inside
 * that box fully transparent. Transparent runs deflate to almost nothing, so
 * a frame costs what actually moved — a bar sweep on a 900px-wide LED-glow
 * panel spans most of the picture but only the bar head and the digits pay.
 * The first animation frame is always the full canvas because the spec
 * clears the output buffer to transparent at the start of every play.
 */
export function encodeApng(frames: ApngFrame[], width: number, height: number, options: ApngOptions = {}): Buffer {
  if (frames.length === 0) throw new Error('an APNG needs at least one frame');
  for (const f of frames) {
    if (f.rgb.length !== width * height * 3) {
      throw new Error(`expected ${width * height * 3} bytes of RGB per frame, got ${f.rgb.length}`);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6; // truecolour with alpha — the deltas need transparency
  const actl = Buffer.alloc(8);
  actl.writeUInt32BE(frames.length, 0);
  actl.writeUInt32BE(options.loops ?? 0, 4);
  const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('acTL', actl)];

  let seq = 0;
  const fctl = (box: { x: number; y: number; w: number; h: number }, delayMs: number): Buffer => {
    const b = Buffer.alloc(26);
    b.writeUInt32BE(seq++, 0);
    b.writeUInt32BE(box.w, 4);
    b.writeUInt32BE(box.h, 8);
    b.writeUInt32BE(box.x, 12);
    b.writeUInt32BE(box.y, 16);
    b.writeUInt16BE(Math.min(65535, Math.max(0, Math.round(delayMs))), 20);
    b.writeUInt16BE(1000, 22);
    b[24] = 0; // dispose_op: none — the next delta paints over what is there
    b[25] = 1; // blend_op: over — transparent pixels leave the previous frame showing
    return chunk('fcTL', b);
  };
  /** The region of `rgb` as RGBA rows; pixels equal to `against` (when
   * given) become transparent. */
  const region = (rgb: Uint8Array, box: { x: number; y: number; w: number; h: number }, against?: Uint8Array): Buffer => {
    const rows = new Uint8Array(box.w * box.h * 4);
    let o = 0;
    for (let y = box.y; y < box.y + box.h; y++) {
      for (let x = box.x; x < box.x + box.w; x++) {
        const i = (y * width + x) * 3;
        const same = against && against[i] === rgb[i] && against[i + 1] === rgb[i + 1] && against[i + 2] === rgb[i + 2];
        if (!same) {
          rows[o] = rgb[i]!;
          rows[o + 1] = rgb[i + 1]!;
          rows[o + 2] = rgb[i + 2]!;
          rows[o + 3] = 255;
        }
        o += 4;
      }
    }
    return deflateSync(filterRows(rows, box.w, box.h, 4), { level: 9 });
  };
  const fdat = (data: Buffer): Buffer => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(seq++, 0);
    return chunk('fdAT', Buffer.concat([head, data]));
  };

  const full = { x: 0, y: 0, w: width, h: height };
  if (options.still) {
    // Default image outside the animation: IDAT with no fcTL, then every
    // animation frame — including the first — as fdAT.
    parts.push(chunk('IDAT', region(options.still, full)));
    parts.push(fctl(full, frames[0]!.delayMs), fdat(region(frames[0]!.rgb, full)));
  } else {
    parts.push(fctl(full, frames[0]!.delayMs), chunk('IDAT', region(frames[0]!.rgb, full)));
  }
  let previous = frames[0]!.rgb;
  for (const frame of frames.slice(1)) {
    // An unchanged frame still needs a region; a single pixel keeps its delay.
    const box = changedBox(previous, frame.rgb, width, height) ?? { x: 0, y: 0, w: 1, h: 1 };
    parts.push(fctl(box, frame.delayMs), fdat(region(frame.rgb, box, previous)));
    previous = frame.rgb;
  }
  parts.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}
