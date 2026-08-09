/**
 * Captures a BUSY Bar display and writes it as a scaled-up PNG.
 *
 * Usage: bun run tools/screenshot.ts [out.png] [front|back] [scale]
 *
 * `GET /api/screen` returns a base64-encoded **BGR888** framebuffer — the
 * OpenAPI spec claims `image/bmp` and the channel order is not RGB. Reading it
 * as RGB silently swaps red and blue, which looks plausible enough to go
 * unnoticed (greens and greys are unaffected). The official library does the
 * same swap in Global/utils/frameData.ts:bgrToRgba.
 */
import { httpBase } from '../src/config';
import { DISPLAYS } from '../src/display';
import { encodePng } from '../src/png';

const [outPath = 'screen.png', displayName = 'front', scaleArg] = process.argv.slice(2);
const display = DISPLAYS[displayName as keyof typeof DISPLAYS];
if (!display) throw new Error(`display must be one of: ${Object.keys(DISPLAYS).join(', ')}`);
const scale = Number(scaleArg ?? 10);
if (!Number.isInteger(scale) || scale < 1) throw new Error(`scale must be a positive integer, got '${scaleArg}'`);

const response = await fetch(`${httpBase()}/api/screen?display=${display.index}`, {
  signal: AbortSignal.timeout(10_000),
});
if (!response.ok) throw new Error(`screen capture failed: HTTP ${response.status}`);

const bgr = Buffer.from((await response.text()).trim(), 'base64');
const { width, height } = display;
const expected = width * height * 3;
if (bgr.length < expected) {
  throw new Error(`short framebuffer: got ${bgr.length} bytes, expected ${expected}`);
}

const rgb = new Uint8Array(expected);
for (let i = 0; i < expected; i += 3) {
  rgb[i] = bgr[i + 2]!;
  rgb[i + 1] = bgr[i + 1]!;
  rgb[i + 2] = bgr[i]!;
}

await Bun.write(outPath, encodePng(rgb, width, height, scale));
const lit = Array.from({ length: width * height }, (_, i) => bgr.readUIntBE(i * 3, 3)).filter(Boolean).length;
console.log(`Wrote ${outPath} (${width}x${height} @ ${scale}x, ${lit}/${width * height} pixels lit)`);
