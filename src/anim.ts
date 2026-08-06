/**
 * Encoder for the BUSY Bar `.anim` file format ("bicycle0").
 *
 * Format reference: busy-app/busybar-firmware
 *   - lib/anim_file/anim_file_format.h (structs)
 *   - scripts/seq2anim.py, assets/frontend/util/seq2anim.ts (encoders)
 *
 * Layout (all integers little-endian):
 *   AnimFileHeader (36 bytes)
 *   Sections chunk: per section — start u32, end u32, frame_offs u32,
 *     duration_override u8, name (nul-terminated)
 *   Frames chunk: per file frame — encoding u8 (0 raw / 1 RLE), duration u8,
 *     encoded_len u16, data
 *
 * A "default" section covering all display frames is mandatory.
 */

const SIGNATURE = 'bicycle0';
const HEADER_LENGTH = 36;
const COLOR_MODE_BGR888 = 0;
const BLOCK_SIZE = 3;
const MAX_BLOCKS_PER_BYTE = 127;
const RLE_BLOCK_THRESHOLD = 3;
const MAX_FRAME_DURATION = 255;

export interface AnimOptions {
  width: number;
  height: number;
  fps: number;
}

interface FileFrame {
  encoding: 0 | 1;
  duration: number;
  encoded: Uint8Array;
}

/** RLE codec used by the firmware: opcode with high bit set = verbatim run
 * (low 7 bits = block count, blocks follow), otherwise repeat run
 * (opcode = repeat count, one block follows). Blocks are 3 bytes (BGR). */
function rleCompress(source: Uint8Array, blkSize: number): Uint8Array {
  const dest: number[] = [];
  const srcLen = source.length;
  let srcI = 0;

  const blockEq = (idx1: number, idx2: number) => {
    if (idx1 + blkSize > srcLen || idx2 + blkSize > srcLen) return false;
    for (let k = 0; k < blkSize; k++) {
      if (source[idx1 + k] !== source[idx2 + k]) return false;
    }
    return true;
  };

  while (srcI < srcLen) {
    let repeatCount = 0;
    for (let i = srcI; i < srcLen; i += blkSize) {
      if (blockEq(i, srcI)) repeatCount++;
      else break;
    }
    repeatCount = Math.min(repeatCount, MAX_BLOCKS_PER_BYTE);
    if (repeatCount === 0) break;

    if (repeatCount < RLE_BLOCK_THRESHOLD) {
      repeatCount = 0;
      let verbatimCount = 0;
      for (let i = srcI; i < srcLen; i += blkSize) {
        if (blockEq(i, i + blkSize)) {
          repeatCount++;
          if (repeatCount > RLE_BLOCK_THRESHOLD) break;
        } else {
          verbatimCount += 1 + repeatCount;
          repeatCount = 0;
        }
      }
      verbatimCount += repeatCount;
      verbatimCount = Math.min(verbatimCount, MAX_BLOCKS_PER_BYTE);

      dest.push(0x80 | verbatimCount);
      for (let k = 0; k < verbatimCount * blkSize; k++) {
        dest.push(source[srcI + k]!);
      }
      srcI += verbatimCount * blkSize;
    } else {
      dest.push(repeatCount);
      for (let k = 0; k < blkSize; k++) {
        dest.push(source[srcI + k]!);
      }
      srcI += repeatCount * blkSize;
    }
  }

  return new Uint8Array(dest);
}

function packBgr(rgbFrame: Uint8Array): Uint8Array {
  const packed = new Uint8Array(rgbFrame.length);
  for (let i = 0; i < rgbFrame.length; i += 3) {
    packed[i] = rgbFrame[i + 2]!;
    packed[i + 1] = rgbFrame[i + 1]!;
    packed[i + 2] = rgbFrame[i]!;
  }
  return packed;
}

function framesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Encode RGB frames (width*height*3 bytes each, row-major) into a `.anim` file.
 */
export function encodeAnim(frames: Uint8Array[], opts: AnimOptions): Uint8Array {
  const { width, height, fps } = opts;
  if (frames.length === 0) throw new Error('no frames');
  for (const [i, frame] of frames.entries()) {
    if (frame.length !== width * height * 3) {
      throw new Error(`frame ${i}: expected ${width * height * 3} bytes, got ${frame.length}`);
    }
  }

  // Encode frames, folding consecutive identical frames into durations
  const fileFrames: FileFrame[] = [];
  let framesChunkLen = 0;
  let maxEncodedLen = 0;
  let lastPacked: Uint8Array | null = null;

  for (const rgb of frames) {
    const packed = packBgr(rgb);
    const prev = fileFrames[fileFrames.length - 1];
    if (lastPacked && prev && prev.duration < MAX_FRAME_DURATION && framesEqual(packed, lastPacked)) {
      prev.duration++;
      continue;
    }
    lastPacked = packed;

    const rle = rleCompress(packed, BLOCK_SIZE);
    const frame: FileFrame =
      rle.length < packed.length
        ? { encoding: 1, duration: 1, encoded: rle }
        : { encoding: 0, duration: 1, encoded: packed };

    fileFrames.push(frame);
    framesChunkLen += 4 + frame.encoded.length;
    maxEncodedLen = Math.max(maxEncodedLen, frame.encoded.length);
  }

  // Single mandatory "default" section spanning all display frames
  const sectionName = 'default';
  const sectionsChunkLen = 13 + sectionName.length + 1;
  const firstFrame = fileFrames[0]!;

  const out = new Uint8Array(HEADER_LENGTH + sectionsChunkLen + framesChunkLen);
  const view = new DataView(out.buffer);
  let o = 0;

  // Header
  for (let i = 0; i < 8; i++) out[o++] = SIGNATURE.charCodeAt(i);
  out[o++] = 0; // flags
  out[o++] = width;
  out[o++] = height;
  out[o++] = COLOR_MODE_BGR888;
  out[o++] = fps;
  view.setUint16(o, maxEncodedLen, true); o += 2;
  out[o++] = 0; // unused
  view.setUint32(o, sectionsChunkLen, true); o += 4;
  view.setUint32(o, framesChunkLen, true); o += 4;
  view.setUint32(o, 1, true); o += 4; // section_count
  view.setUint32(o, fileFrames.length, true); o += 4;
  view.setUint32(o, frames.length, true); o += 4;

  // "default" section
  view.setUint32(o, 0, true); o += 4; // start
  view.setUint32(o, frames.length - 1, true); o += 4; // end
  view.setUint32(o, HEADER_LENGTH + sectionsChunkLen, true); o += 4; // frame_offs
  out[o++] = firstFrame.duration; // duration_override
  for (const ch of sectionName) out[o++] = ch.charCodeAt(0);
  out[o++] = 0;

  // Frames
  for (const frame of fileFrames) {
    out[o++] = frame.encoding;
    out[o++] = frame.duration;
    view.setUint16(o, frame.encoded.length, true); o += 2;
    out.set(frame.encoded, o);
    o += frame.encoded.length;
  }

  return out;
}
