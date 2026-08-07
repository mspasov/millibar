/**
 * Generates a looping rainbow-plasma animation, encodes it as a `.anim` file,
 * uploads it to the BUSY Bar, and plays it on the front display.
 *
 * Usage: bun run tools/plasma.ts [seconds]
 */
import { BusyBar } from '@busy-app/busy-lib';
import { encodeAnim } from '../src/anim';

const WIDTH = 72;
const HEIGHT = 16;
const FPS = 30;
const FRAME_COUNT = 90; // 3s perfect loop
const APP_NAME = 'claude_anim';
const FILE_NAME = 'plasma.anim';

const playSeconds = Number(process.argv[2] ?? 30);

function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  const [r, g, b] = [
    [v, t, p],
    [q, v, p],
    [p, v, t],
    [p, q, v],
    [t, p, v],
    [v, p, q],
  ][i % 6]!;
  return [Math.round(r! * 255), Math.round(g! * 255), Math.round(b! * 255)];
}

function generateFrames(): Uint8Array[] {
  const frames: Uint8Array[] = [];
  for (let t = 0; t < FRAME_COUNT; t++) {
    // Every time-dependent term is an integer multiple of `phase`,
    // so the animation loops seamlessly after FRAME_COUNT frames.
    const phase = (2 * Math.PI * t) / FRAME_COUNT;
    const frame = new Uint8Array(WIDTH * HEIGHT * 3);
    for (let y = 0; y < HEIGHT; y++) {
      for (let x = 0; x < WIDTH; x++) {
        const v =
          Math.sin(x * 0.28 + phase) +
          Math.sin(y * 0.5 - phase) +
          Math.sin((x * 0.22 + y * 0.35) + 2 * phase);
        const hue = ((v + 3) / 6 + t / FRAME_COUNT) % 1;
        const [r, g, b] = hsvToRgb(hue, 1, 1);
        const o = (y * WIDTH + x) * 3;
        frame[o] = r;
        frame[o + 1] = g;
        frame[o + 2] = b;
      }
    }
    frames.push(frame);
  }
  return frames;
}

const bar = new BusyBar({ addr: process.env.BUSY_BAR_ADDR ?? '10.0.4.20' });

console.log(`Generating ${FRAME_COUNT} frames of ${WIDTH}x${HEIGHT} plasma...`);
const anim = encodeAnim(generateFrames(), { width: WIDTH, height: HEIGHT, fps: FPS });
console.log(`Encoded ${FILE_NAME}: ${(anim.length / 1024).toFixed(1)} KiB`);

await bar.AssetsUpload(
  { application_name: APP_NAME, file: FILE_NAME, data: new Blob([anim.buffer as ArrayBuffer]) },
  { timeout: 30000 }
);
console.log('Uploaded to device');

await bar.DisplayDraw({
  application_name: APP_NAME,
  priority: 50,
  elements: [
    {
      id: 'plasma',
      type: 'animation',
      path: FILE_NAME,
      loop: true,
      await_previous_end: false,
      opacity: 100,
      timeout: playSeconds,
      x: 0,
      y: 0,
      display: 'front',
    },
  ],
});
console.log(`Playing on front display for ${playSeconds}s`);
