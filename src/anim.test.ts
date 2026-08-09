import { describe, expect, test } from 'bun:test';
import { encodeAnim } from './anim';

const W = 2;
const H = 2;

const solid = (r: number, g: number, b: number): Uint8Array => {
  const frame = new Uint8Array(W * H * 3);
  for (let i = 0; i < W * H; i++) {
    frame[i * 3] = r;
    frame[i * 3 + 1] = g;
    frame[i * 3 + 2] = b;
  }
  return frame;
};

/** Every 3-byte block distinct, so RLE (1 opcode per verbatim run) cannot win. */
const gradient = (): Uint8Array => Uint8Array.from({ length: W * H * 3 }, (_, i) => (i * 7) % 256);

const toBgr = (rgb: Uint8Array): number[] => {
  const out: number[] = [];
  for (let i = 0; i < rgb.length; i += 3) out.push(rgb[i + 2]!, rgb[i + 1]!, rgb[i]!);
  return out;
};

/** Reference decoder for the firmware's RLE: opcode high bit = verbatim run of
 * low-7-bits blocks; otherwise repeat run (opcode = count, one block follows). */
function rleDecode(data: Uint8Array, blk = 3): number[] {
  const out: number[] = [];
  let i = 0;
  while (i < data.length) {
    const op = data[i++]!;
    if (op & 0x80) {
      for (let k = 0; k < (op & 0x7f) * blk; k++) out.push(data[i++]!);
    } else {
      const block = [...data.subarray(i, i + blk)];
      i += blk;
      for (let r = 0; r < op; r++) out.push(...block);
    }
  }
  return out;
}

/** Parses the container back apart, per lib/anim_file/anim_file_format.h. */
function parseAnim(data: Uint8Array) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const header = {
    signature: String.fromCharCode(...data.subarray(0, 8)),
    width: data[9]!,
    height: data[10]!,
    colorMode: data[11]!,
    fps: data[12]!,
    maxEncodedLen: view.getUint16(13, true),
    sectionsChunkLen: view.getUint32(16, true),
    framesChunkLen: view.getUint32(20, true),
    sectionCount: view.getUint32(24, true),
    fileFrameCount: view.getUint32(28, true),
    displayFrameCount: view.getUint32(32, true),
  };
  let o = 36;
  const sections: { name: string; start: number; end: number; frameOffs: number; durationOverride: number }[] = [];
  for (let i = 0; i < header.sectionCount; i++) {
    const start = view.getUint32(o, true);
    const end = view.getUint32(o + 4, true);
    const frameOffs = view.getUint32(o + 8, true);
    const durationOverride = data[o + 12]!;
    o += 13;
    let name = '';
    while (data[o] !== 0) name += String.fromCharCode(data[o++]!);
    o++;
    sections.push({ name, start, end, frameOffs, durationOverride });
  }
  const frames: { encoding: number; duration: number; recordStart: number; pixels: number[] }[] = [];
  while (o < data.length) {
    const recordStart = o;
    const encoding = data[o]!;
    const duration = data[o + 1]!;
    const encodedLen = view.getUint16(o + 2, true);
    o += 4;
    const encoded = data.subarray(o, o + encodedLen);
    o += encodedLen;
    frames.push({
      encoding,
      duration,
      recordStart,
      pixels: encoding === 1 ? rleDecode(encoded) : [...encoded],
    });
  }
  return { header, sections, frames };
}

describe('encodeAnim', () => {
  test('the header describes the file and the chunks account for every byte', () => {
    const data = encodeAnim([solid(255, 0, 0), gradient()], { width: W, height: H, fps: 12 });
    const { header } = parseAnim(data);
    expect(header.signature).toBe('bicycle0');
    expect(header).toMatchObject({ width: W, height: H, colorMode: 0, fps: 12 });
    expect(header.fileFrameCount).toBe(2);
    expect(header.displayFrameCount).toBe(2);
    expect(data.length).toBe(36 + header.sectionsChunkLen + header.framesChunkLen);
  });

  test('frames round-trip through the RLE codec, stored as BGR', () => {
    const red = solid(255, 0, 0);
    // Three identical blocks then one different: a repeat run plus a verbatim run.
    const mixed = Uint8Array.from([...solid(10, 20, 30).subarray(0, 9), 1, 2, 3]);
    const varied = gradient();
    const { frames } = parseAnim(encodeAnim([red, mixed, varied], { width: W, height: H, fps: 20 }));

    expect(frames[0]!.encoding).toBe(1); // solid colour compresses
    expect(frames[0]!.pixels).toEqual(toBgr(red)); // red pixel stored as 00,00,FF
    expect(frames[1]!.pixels).toEqual(toBgr(mixed));
    expect(frames[2]!.encoding).toBe(0); // all-distinct blocks stay raw
    expect(frames[2]!.pixels).toEqual(toBgr(varied));
  });

  test('identical consecutive frames fold into one file frame with a duration', () => {
    const a = solid(0, 255, 0);
    const { header, frames } = parseAnim(
      encodeAnim([a, a, a, gradient()], { width: W, height: H, fps: 20 })
    );
    expect(header.fileFrameCount).toBe(2);
    expect(header.displayFrameCount).toBe(4);
    expect(frames[0]!.duration).toBe(3);
    expect(frames[1]!.duration).toBe(1);
  });

  test('sections address display frames, even mid-way through a folded frame', () => {
    const a = solid(0, 0, 255);
    const { sections, frames } = parseAnim(
      encodeAnim([a, a, a], {
        width: W,
        height: H,
        fps: 20,
        sections: [{ name: 'tail', start: 1, end: 2 }],
      })
    );
    expect(sections.map((s) => s.name)).toEqual(['default', 'tail']);
    expect(sections[0]).toMatchObject({ start: 0, end: 2, durationOverride: 3 });
    // 'tail' starts one display frame into the single folded file frame, so it
    // points at that frame's record with 2 display frames left to cover.
    expect(sections[1]).toMatchObject({ start: 1, end: 2, durationOverride: 2 });
    expect(sections[1]!.frameOffs).toBe(frames[0]!.recordStart);
  });

  test('rejects malformed input loudly', () => {
    const opts = { width: W, height: H, fps: 20 };
    expect(() => encodeAnim([], opts)).toThrow('no frames');
    expect(() => encodeAnim([new Uint8Array(5)], opts)).toThrow('expected 12 bytes');
    const frame = solid(1, 2, 3);
    expect(() =>
      encodeAnim([frame], { ...opts, sections: [{ name: 'default', start: 0, end: 0 }] })
    ).toThrow('invalid section name');
    expect(() =>
      encodeAnim([frame], { ...opts, sections: [{ name: 'has space', start: 0, end: 0 }] })
    ).toThrow('invalid section name');
    expect(() =>
      encodeAnim([frame], {
        ...opts,
        sections: [
          { name: 'x', start: 0, end: 0 },
          { name: 'x', start: 0, end: 0 },
        ],
      })
    ).toThrow('duplicate section name');
    expect(() =>
      encodeAnim([frame], { ...opts, sections: [{ name: 'x', start: 0, end: 1 }] })
    ).toThrow('outside');
  });
});
