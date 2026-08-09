/**
 * Knob-controlled flame: fire rises from the bottom of the front display, and
 * the rotary encoder steps its intensity through 16 levels — from a few embers
 * to a full-height blaze. Prototype for a CPU usage monitor, where load would
 * set the level instead of the dial.
 *
 * All levels are pre-rendered into ONE `.anim` file and uploaded once. Each
 * level's loop is stored twice back-to-back, so a full-length loop starting at
 * ANY phase is a contiguous frame range — encoded as one named section per
 * (level, phase). A level change reads the current playback phase off
 * /api/screen (readback matches the encoded frames byte-exactly, so one
 * capture frame-matched against the level's loop pins it), then immediately
 * draws the target level's section at that same phase: the switch lands
 * mid-loop in step with what was playing, and with all levels sharing one
 * noise stream it reads as the fire growing or shrinking, not cutting.
 * Large dial moves glide one level at a time. (Rejected alternatives: an
 * immediate same-phase-0 switch jumps; `await_previous_end` switches lag up
 * to a full loop and stack — see DEVICE.md.)
 *
 * Usage:
 *   bun run tools/flame.ts [start-level]        # on device; dial changes level
 *   bun run tools/flame.ts --preview [out.png]  # local contact sheet, no device
 *
 * Env: BUSY_BAR_ADDR, BUSY_PRIORITY
 */
import { BusyBar } from '@busy-app/busy-lib';
import { encodeAnim, type AnimSection } from '../src/anim';
import { deviceAddr, envNumber, httpBase } from '../src/config';
import { DISPLAYS } from '../src/display';
import { listenInput } from '../src/input';
import { encodePng } from '../src/png';

const WIDTH = DISPLAYS.front.width;
const HEIGHT = DISPLAYS.front.height;
const FPS = 20;
const LEVELS = 16;
const MAX_LEVEL = LEVELS - 1;
// The sim runs at FPS/SMOOTH and display frames are interpolated between
// consecutive sim states: motion at half speed, fluidity of the full rate.
const SMOOTH = 2;
const STATES = 20; // sim states per loop: 2s at 20fps / SMOOTH
const FRAMES = STATES * SMOOTH; // per-level display frames
const CROSSFADE = 5; // sim states blended across the loop seam
const WARMUP = 40; // sim steps before capture, so flames reach full height

/** Each level's loop is stored twice, so phase-rotated loops are contiguous. */
const BLOCK = FRAMES * 2;
/** Cadence of the one-level-at-a-time glide toward the dial's target. */
const STEP_MS = 150;
/** Frames the animation advances between the phase capture and the redraw
 * taking effect (capture ~60ms + draw ~15ms + a render tick, at 20fps). */
const PHASE_LEAD = 3;

const APP_NAME = 'claude_flame';
const FILE_NAME = 'flame.anim';
const PRIORITY = envNumber('BUSY_PRIORITY', 50, 1);
const ADDR = deviceAddr();
const BASE_URL = httpBase();

/** Redraws refresh this; the display self-clears if the process dies. */
const DRAW_TIMEOUT_S = 90;
const KEEPALIVE_MS = 30_000;

// ---------------------------------------------------------------------------
// Flame simulation (doom-fire style: heat rises from a source row below the
// screen, losing a random amount per row; palette maps heat to colour).
// ---------------------------------------------------------------------------

/** Seeded PRNG so every run produces byte-identical frames — reruns upload the
 * exact same file, and a device-side glitch can't be blamed on new random data. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Heat 0..1 → RGB. Stops chosen for LEDs: the low end stays a visibly glowing
 * red rather than dropping into invisible near-black. */
const PALETTE: [number, [number, number, number]][] = [
  [0.0, [0, 0, 0]],
  [0.1, [40, 0, 0]],
  [0.3, [170, 24, 0]],
  [0.55, [255, 96, 0]],
  [0.8, [255, 200, 32]],
  [1.0, [255, 250, 190]],
];

function heatToRgb(heat: number): [number, number, number] {
  const h = Math.min(1, Math.max(0, heat));
  for (let i = 1; i < PALETTE.length; i++) {
    const [h1, c1] = PALETTE[i]!;
    if (h > h1) continue;
    const [h0, c0] = PALETTE[i - 1]!;
    const t = (h - h0) / (h1 - h0);
    return [
      Math.round(c0[0] + (c1[0] - c0[0]) * t),
      Math.round(c0[1] + (c1[1] - c0[1]) * t),
      Math.round(c0[2] + (c1[2] - c0[2]) * t),
    ];
  }
  return PALETTE[PALETTE.length - 1]![1];
}

/** One level's loop as heat fields (WIDTH*HEIGHT floats, row 0 = top). */
function simulateLevel(level: number): Float32Array[] {
  // Same seed (and rand() call count) for every level: frame k of level N is
  // then a scaled twin of frame k of level M — same tongues, different height.
  // Level switches happen at the loop wrap (await_previous_end), i.e. always
  // land on frame 0, so correlated frames make a switch read as the fire
  // growing or shrinking rather than cutting to an unrelated fire.
  const rand = mulberry32(0xf1a3e);
  const t = level / MAX_LEVEL;
  // Tips should only reach the top row near max level; heat lost per row is
  // what limits height, since the source heat also feeds the palette's colour.
  const targetHeight = 1.5 + t * 15.5;
  const sourceHeat = 0.55 + 0.45 * t;
  // Deep wave valleys break a low fire into separate embers; a raging one
  // burns along the whole width, so its floor rises with level.
  const waveFloor = 0.2 + 0.55 * t;
  // Height ≈ meanSource / decayMean, so divide the *average* fed heat (wave
  // midpoint × sputter midpoint) — sizing decay from peak heat leaves the
  // flame well short of targetHeight.
  const meanSource = sourceHeat * (waveFloor + (1 - waveFloor) * 0.5);
  const decayMean = meanSource / targetHeight;

  const heat = new Float32Array(WIDTH * HEIGHT);
  const source = new Float32Array(WIDTH);

  const step = (frame: number) => {
    // Source row below the screen: two drifting waves make hot spots wander
    // sideways; the random factor adds per-frame sputter.
    for (let x = 0; x < WIDTH; x++) {
      const ripple =
        0.5 + 0.5 * Math.sin(x * 0.31 + frame * 0.09) * Math.sin(x * 0.117 - frame * 0.055);
      const wave = waveFloor + (1 - waveFloor) * ripple;
      source[x] = sourceHeat * wave * (0.9 + 0.2 * rand());
    }
    // Top-down, in place: row y reads row y+1 before this pass overwrites it,
    // so heat climbs one row per frame — which reads as flames licking upward.
    // Averaging the three cells below (rather than sampling one at a jittered
    // offset) keeps tongues coherent instead of dissolving into pixel noise.
    for (let y = 0; y < HEIGHT; y++) {
      const rowBelow = (y + 1) * WIDTH;
      for (let x = 0; x < WIDTH; x++) {
        const xm = x > 0 ? x - 1 : 0;
        const xp = x < WIDTH - 1 ? x + 1 : WIDTH - 1;
        const below =
          y === HEIGHT - 1
            ? source[xm]! * 0.25 + source[x]! * 0.5 + source[xp]! * 0.25
            : heat[rowBelow + xm]! * 0.25 + heat[rowBelow + x]! * 0.5 + heat[rowBelow + xp]! * 0.25;
        // Mean stays decayMean (height calibration); the narrow 0.6–1.4 spread
        // flickers gently where the old 0–2 spread strobed.
        heat[y * WIDTH + x] = Math.max(0, below - decayMean * (0.6 + 0.8 * rand()));
      }
    }
  };

  const mix = (a: Float32Array, b: Float32Array, w: number): Float32Array => {
    const mixed = new Float32Array(WIDTH * HEIGHT);
    for (let k = 0; k < mixed.length; k++) mixed[k] = a[k]! * (1 - w) + b[k]! * w;
    return mixed;
  };

  for (let i = 0; i < WARMUP; i++) step(i);
  const captured: Float32Array[] = [];
  for (let i = 0; i < STATES + CROSSFADE; i++) {
    step(WARMUP + i);
    captured.push(heat.slice());
  }

  // Make the loop seamless: the first CROSSFADE states blend the states that
  // *followed* the loop's end back into the loop's start, in heat space
  // (blending after palette mapping would grey out the mix).
  const states: Float32Array[] = [];
  for (let i = 0; i < STATES; i++) {
    states.push(
      i < CROSSFADE ? mix(captured[STATES + i]!, captured[i]!, (i + 1) / (CROSSFADE + 1)) : captured[i]!
    );
  }

  // Interpolate SMOOTH display frames between consecutive states, wrapping at
  // the end so the interpolation is seamless across the loop point too.
  const out: Float32Array[] = [];
  for (let i = 0; i < FRAMES; i++) {
    const k = (i / SMOOTH) | 0;
    const t = (i % SMOOTH) / SMOOTH;
    out.push(t === 0 ? states[k]! : mix(states[k]!, states[(k + 1) % STATES]!, t));
  }
  return out;
}

function heatToFrame(heat: Float32Array): Uint8Array {
  const rgb = new Uint8Array(WIDTH * HEIGHT * 3);
  for (let i = 0; i < heat.length; i++) {
    const [r, g, b] = heatToRgb(heat[i]!);
    rgb[i * 3] = r;
    rgb[i * 3 + 1] = g;
    rgb[i * 3 + 2] = b;
  }
  return rgb;
}

export function renderAllLevels(): { frames: Uint8Array[]; sections: AnimSection[] } {
  const frames: Uint8Array[] = [];
  const sections: AnimSection[] = [];
  for (let level = 0; level < LEVELS; level++) {
    const block = simulateLevel(level).map(heatToFrame);
    const base = frames.length;
    // Twice back-to-back: section l<level>p<J> = a full loop entered at phase
    // J, playable as the contiguous range [base+J .. base+J+FRAMES-1].
    frames.push(...block, ...block);
    for (let j = 0; j < FRAMES; j++) {
      sections.push({ name: `l${level}p${j}`, start: base + j, end: base + j + FRAMES - 1 });
    }
  }
  return { frames, sections };
}

// ---------------------------------------------------------------------------
// Preview: contact sheet of every level (rows) at a few loop points (columns),
// for tuning the look without occupying the shared display.
// ---------------------------------------------------------------------------

function writePreview(frames: Uint8Array[], outPath: string): Promise<number> {
  const sampleFrames = [0, 1, 2, 3].map((i) => ((i * FRAMES) / 4) | 0);
  const gap = 2;
  const sheetW = sampleFrames.length * (WIDTH + gap) - gap;
  const sheetH = LEVELS * (HEIGHT + gap) - gap;
  const sheet = new Uint8Array(sheetW * sheetH * 3);
  for (let level = 0; level < LEVELS; level++) {
    for (const [col, f] of sampleFrames.entries()) {
      const frame = frames[level * BLOCK + f]!;
      const ox = col * (WIDTH + gap);
      const oy = level * (HEIGHT + gap);
      for (let y = 0; y < HEIGHT; y++) {
        for (let x = 0; x < WIDTH; x++) {
          const src = (y * WIDTH + x) * 3;
          const dst = ((oy + y) * sheetW + ox + x) * 3;
          sheet[dst] = frame[src]!;
          sheet[dst + 1] = frame[src + 1]!;
          sheet[dst + 2] = frame[src + 2]!;
        }
      }
    }
  }
  return Bun.write(outPath, encodePng(sheet, sheetW, sheetH, 4));
}

// ---------------------------------------------------------------------------
// Device
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  console.log(`Rendering ${LEVELS} levels x ${FRAMES} frames...`);
  const { frames, sections } = renderAllLevels();

  if (args[0] === '--preview') {
    const outPath = args[1] ?? 'flame-preview.png';
    await writePreview(frames, outPath);
    console.log(`Wrote ${outPath} (levels top to bottom, loop samples left to right)`);
    return;
  }

  const anim = encodeAnim(frames, { width: WIDTH, height: HEIGHT, fps: FPS, sections });
  console.log(`Encoded ${FILE_NAME}: ${(anim.length / 1024).toFixed(0)} KiB, ${sections.length + 1} sections`);

  const bar = new BusyBar({ addr: ADDR });
  await bar.AssetsUpload(
    { application_name: APP_NAME, file: FILE_NAME, data: new Blob([anim.buffer as ArrayBuffer]) },
    { timeout: 120_000 }
  );
  console.log('Uploaded to device');

  let targetLevel = Math.min(MAX_LEVEL, Math.max(0, Number(args[0] ?? 8) || 0));
  let shownLevel = -1;
  let stepping = false;

  async function draw(section: string): Promise<void> {
    await bar.DisplayDraw({
      application_name: APP_NAME,
      priority: PRIORITY,
      elements: [
        {
          id: 'flame',
          type: 'animation',
          path: FILE_NAME,
          section,
          loop: true,
          // Immediate switch: the section itself encodes the playback phase,
          // so continuity comes from choosing the right section, not from
          // waiting for the wrap (awaited draws queue and lag a full loop).
          await_previous_end: false,
          opacity: 100,
          timeout: DRAW_TIMEOUT_S,
          x: 0,
          y: 0,
          display: 'front',
        },
      ],
    });
  }

  /** Current playback phase (0..FRAMES-1), by frame-matching one screen
   * capture against the level's loop — readback is byte-exact against the
   * uploaded frames, so a clean match has error ~0. Null when the screen
   * shows something else (display stolen, blanked, mid-switch transient). */
  async function capturePhase(level: number): Promise<number | null> {
    try {
      const r = await fetch(`${BASE_URL}/api/screen?display=0`, {
        signal: AbortSignal.timeout(2000),
      });
      if (!r.ok) return null;
      const bgr = Buffer.from((await r.text()).trim(), 'base64');
      if (bgr.length < WIDTH * HEIGHT * 3) return null;
      let best = 0;
      let bestErr = Infinity;
      for (let f = 0; f < FRAMES; f++) {
        const ref = frames[level * BLOCK + f]!;
        let err = 0;
        // Every 5th pixel; readback is BGR while frames are RGB.
        for (let p = 0; p < ref.length; p += 15) {
          err += Math.abs(ref[p]! - bgr[p + 2]!) + Math.abs(ref[p + 1]! - bgr[p + 1]!);
        }
        if (err < bestErr) {
          bestErr = err;
          best = f;
        }
      }
      // ~2.4 per sampled channel: same-loop mismatches score far higher.
      return bestErr < WIDTH * HEIGHT * 0.3 ? best : null;
    } catch {
      return null;
    }
  }

  /** Walk one level per STEP_MS toward the dial's latest target, each step a
   * phase-matched immediate draw — a spin from 15 to 0 glides down through
   * every level instead of cutting. Phase is re-read from the device before
   * every step, so there is no clock to drift. */
  async function stepTowards(): Promise<void> {
    if (stepping) return;
    stepping = true;
    try {
      while (shownLevel !== targetLevel) {
        const stepStart = Date.now();
        const next =
          shownLevel < 0 ? targetLevel : shownLevel + Math.sign(targetLevel - shownLevel);
        const phase = shownLevel < 0 ? null : await capturePhase(shownLevel);
        const entry = phase === null ? 0 : (phase + PHASE_LEAD) % FRAMES;
        await draw(`l${next}p${entry}`);
        shownLevel = next;
        const wait = STEP_MS - (Date.now() - stepStart);
        if (wait > 0 && shownLevel !== targetLevel) await Bun.sleep(wait);
      }
    } catch (error) {
      console.error(`draw failed: ${(error as Error).message}`);
    } finally {
      stepping = false;
    }
    if (shownLevel !== targetLevel) void stepTowards();
  }

  await stepTowards();
  console.log(
    `Flame at level ${targetLevel}/${MAX_LEVEL} on ${ADDR} — ` +
      'rotate the dial to change it (Ctrl-C to stop and clear)'
  );

  // Phase-matched same-level redraw: refreshes the element timeout without a
  // visible hitch. Also what recovers the screen after BACK blanks it.
  const keepalive = setInterval(async () => {
    if (stepping || shownLevel < 0) return;
    const phase = await capturePhase(shownLevel);
    if (stepping) return;
    const entry = phase === null ? 0 : (phase + PHASE_LEAD) % FRAMES;
    draw(`l${shownLevel}p${entry}`).catch((e) => console.error(`keepalive: ${e.message}`));
  }, KEEPALIVE_MS);

  const controller = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      clearInterval(keepalive);
      controller.abort();
      void bar
        .DisplayClear({ application_name: APP_NAME })
        .catch(() => {})
        .finally(() => process.exit(0));
    });
  }

  await listenInput(
    (event) => {
      if (event.type !== 'encoder') return;
      const next = Math.min(MAX_LEVEL, Math.max(0, targetLevel + event.delta));
      if (next === targetLevel) return;
      targetLevel = next;
      console.log(`  -> level ${targetLevel}/${MAX_LEVEL}`);
      void stepTowards();
    },
    { signal: controller.signal, onError: (e) => console.error(e.message) }
  );
}

if (import.meta.main) await main();
