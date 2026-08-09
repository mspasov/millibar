/**
 * Preview and on-device demo for claude-history's appearance intros, which
 * live in src/modules/claude-history.ts (introBarsFrames / introHeatFrames /
 * encodeHistoryAsset). This tool renders them from the real stats cache —
 * as looping APNGs in an HTML page, and as a live demo that plays each
 * screen's intro on the device, verifies the frames on the wire, and cleans
 * up after itself.
 *
 * Usage:
 *   bun tools/history-intro.ts preview [--out <dir>]   # APNG + HTML preview, no device
 *   bun tools/history-intro.ts play                    # upload, demo one cycle, clean up
 *
 * `play` refuses to run over an active BUSY session, draws as its own
 * application at priority 60 (above the monitor's 50 — mbar's heartbeat
 * reclaims the screen within a minute of the cleanup), and verifies by
 * matching `/api/screen` captures against the locally rendered intro frames
 * while they play.
 */
import { deflateSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { deviceFetch } from '../src/connection';
import { COLORS, DISPLAYS, displayClear, displayDraw, type DrawElement } from '../src/display';
import {
  encodeHistoryAsset,
  formatTokensCompact,
  formatTokensShort,
  heatSpan,
  introBarsFrames,
  introHeatFrames,
  SCREENS,
  windowDays,
  type HistoryScreen,
} from '../src/modules/claude-history';
import { encodePng } from '../src/png';
import { loadStatsHistory, statsCachePath, type DayTokens } from '../src/stats';
import { assetsDelete, assetsUpload } from '../src/store';

const WIDTH = DISPLAYS.front.width;
const HEIGHT = DISPLAYS.front.height;
const APP_NAME = 'history-intro';
const FILE_NAME = 'history-intro.anim';
const LABEL_X = 2;
const TEXT_Y = 3;

interface DemoScreen {
  screen: HistoryScreen;
  frames: Uint8Array[];
  introMs: number;
}

function buildDemo(days: DayTokens[]): { bytes: Uint8Array; screens: DemoScreen[] } {
  const { bytes, introMs } = encodeHistoryAsset(days);
  const screens = SCREENS.map((screen) => ({
    screen,
    frames: screen.kind === 'bars' ? introBarsFrames(windowDays(days, screen.days), screen) : introHeatFrames(days),
    introMs: introMs[screen.section]!,
  }));
  return { bytes, screens };
}

// --- APNG preview ------------------------------------------------------------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function pngChunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  let c = 0xffffffff;
  for (const byte of body) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE((c ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, body, crc]);
}

/** Nearest-neighbour-scaled scanlines with the leading filter byte, the same
 * shape src/png.ts builds for stills. */
function scanlines(rgb: Uint8Array, scale: number): Buffer {
  const rowBytes = WIDTH * scale * 3;
  const raw = Buffer.alloc((rowBytes + 1) * HEIGHT * scale);
  let o = 0;
  for (let y = 0; y < HEIGHT; y++) {
    const rowStart = o;
    raw[o++] = 0;
    for (let x = 0; x < WIDTH; x++) {
      const src = (y * WIDTH + x) * 3;
      for (let s = 0; s < scale; s++) {
        raw[o++] = rgb[src]!;
        raw[o++] = rgb[src + 1]!;
        raw[o++] = rgb[src + 2]!;
      }
    }
    for (let s = 1; s < scale; s++) {
      raw.copyWithin(o, rowStart, rowStart + rowBytes + 1);
      o += rowBytes + 1;
    }
  }
  return raw;
}

/** Animated PNG: same truecolour stream as src/png.ts per frame, wrapped in
 * acTL/fcTL/fdAT so browsers loop it. Delays are per frame in ms. */
export function encodeApng(frames: Uint8Array[], scale: number, delaysMs: number[]): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(WIDTH * scale, 0);
  ihdr.writeUInt32BE(HEIGHT * scale, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const actl = Buffer.alloc(8);
  actl.writeUInt32BE(frames.length, 0);
  actl.writeUInt32BE(0, 4); // loop forever

  const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk('IHDR', ihdr), pngChunk('acTL', actl)];
  let seq = 0;
  frames.forEach((frame, i) => {
    const fctl = Buffer.alloc(26);
    fctl.writeUInt32BE(seq++, 0);
    fctl.writeUInt32BE(WIDTH * scale, 4);
    fctl.writeUInt32BE(HEIGHT * scale, 8);
    fctl.writeUInt16BE(delaysMs[i]!, 20);
    fctl.writeUInt16BE(1000, 22);
    parts.push(pngChunk('fcTL', fctl));
    const data = deflateSync(scanlines(frame, scale));
    if (i === 0) {
      parts.push(pngChunk('IDAT', data));
    } else {
      const head = Buffer.alloc(4);
      head.writeUInt32BE(seq++, 0);
      parts.push(pngChunk('fdAT', Buffer.concat([head, data])));
    }
  });
  parts.push(pngChunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

/** A filmstrip grid of every frame, for eyeballing motion in one still. */
function filmstrip(frames: Uint8Array[], cols: number, scale: number): { rgb: Uint8Array; w: number; h: number } {
  const rows = Math.ceil(frames.length / cols);
  const cellW = WIDTH + 2;
  const cellH = HEIGHT + 2;
  const w = cols * cellW;
  const h = rows * cellH;
  const rgb = new Uint8Array(w * h * 3);
  frames.forEach((frame, i) => {
    const cx = (i % cols) * cellW + 1;
    const cy = Math.floor(i / cols) * cellH + 1;
    for (let y = 0; y < HEIGHT; y++) {
      for (let x = 0; x < WIDTH; x++) {
        const s = (y * WIDTH + x) * 3;
        const d = ((cy + y) * w + cx + x) * 3;
        rgb[d] = frame[s]!;
        rgb[d + 1] = frame[s + 1]!;
        rgb[d + 2] = frame[s + 2]!;
      }
    }
  });
  const out = new Uint8Array(w * scale * h * scale * 3);
  for (let y = 0; y < h * scale; y++) {
    for (let x = 0; x < w * scale; x++) {
      const s = (Math.floor(y / scale) * w + Math.floor(x / scale)) * 3;
      const d = (y * w * scale + x) * 3;
      out[d] = rgb[s]!;
      out[d + 1] = rgb[s + 1]!;
      out[d + 2] = rgb[s + 2]!;
    }
  }
  return { rgb: out, w: w * scale, h: h * scale };
}

async function writePreview(screens: DemoScreen[], outDir: string): Promise<void> {
  const panels: string[] = [];
  for (const { screen, introMs, frames } of screens) {
    const frameDelay = Math.round(introMs / frames.length);
    const delays = frames.map((_, i) => (i === frames.length - 1 ? 1500 : frameDelay));
    const apng = encodeApng(frames, 8, delays);
    await Bun.write(`${outDir}/intro-${screen.section}.png`, apng);
    const strip = filmstrip(frames, 6, 2);
    await Bun.write(`${outDir}/strip-${screen.section}.png`, encodePng(strip.rgb, strip.w, strip.h));
    panels.push(`
      <section>
        <h2>${screen.label} <span>intro ${introMs}ms · ${frames.length} frames</span></h2>
        <div class="panel"><img alt="${screen.label} intro" src="data:image/png;base64,${apng.toString('base64')}"></div>
      </section>`);
  }
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>claude-history intro prototype</title>
<style>
  body { background: #0d0e12; color: #cfd6e0; font: 15px/1.55 -apple-system, system-ui, sans-serif;
         max-width: 720px; margin: 0 auto; padding: 40px 24px; }
  h1 { font-size: 20px; } h2 { font-size: 15px; margin: 28px 0 10px; }
  h2 span { color: #6b7684; font-weight: normal; font-size: 13px; }
  .panel { background: #000; border-radius: 12px; padding: 20px 24px; display: inline-block; }
  img { image-rendering: pixelated; width: 576px; height: 128px; display: block; }
  p { color: #8b95a3; font-size: 13px; }
</style></head><body>
<h1>claude-history — appearance intros</h1>
<p>Real data from the local stats cache, rendered by the module's own intro painters. Each
animation holds its final frame 1.5s, then replays. On the device the intro plays once and
settles; the labels/totals are text elements composited on top by the firmware and are not
part of this pixel layer.</p>
${panels.join('\n')}
</body></html>`;
  await Bun.write(`${outDir}/preview.html`, html);
  console.log(`preview written to ${outDir}`);
}

// --- device demo -------------------------------------------------------------

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function textElements(screen: HistoryScreen, days: DayTokens[]): DrawElement[] {
  const text = (id: string, value: string, align: 'mid_left' | 'mid_right', x: number, y = TEXT_Y): DrawElement => ({
    id,
    type: 'text',
    text: value,
    font: 'small',
    color: COLORS.label,
    align,
    x,
    y,
    timeout: 30,
    display: 'front',
  });
  if (screen.kind === 'heat') {
    const span = heatSpan(days);
    const total = days.reduce((a, d) => (span && Date.parse(d.date) >= span.startMs ? a + d.total : a), 0);
    return [text('label', screen.label, 'mid_left', LABEL_X), text('total', formatTokensShort(total), 'mid_left', LABEL_X, 8)];
  }
  const total = windowDays(days, screen.days).reduce((a, d) => a + d.total, 0);
  return [text('label', screen.label, 'mid_left', LABEL_X), text('total', formatTokensCompact(total), 'mid_right', WIDTH - 2)];
}

function chartElement(section: string): DrawElement {
  return {
    id: 'chart',
    type: 'animation',
    path: FILE_NAME,
    section,
    loop: true,
    await_previous_end: false,
    opacity: 100,
    timeout: 30,
    x: 0,
    y: 0,
    display: 'front',
  };
}

async function captureFront(): Promise<Uint8Array> {
  const response = await deviceFetch('/api/screen?display=0', { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`screen capture failed: HTTP ${response.status}`);
  const bgr = Buffer.from((await response.text()).trim(), 'base64');
  const rgb = new Uint8Array(WIDTH * HEIGHT * 3);
  for (let i = 0; i < rgb.length; i += 3) {
    rgb[i] = bgr[i + 2]!;
    rgb[i + 1] = bgr[i + 1]!;
    rgb[i + 2] = bgr[i]!;
  }
  return rgb;
}

/** Region untouched by the text elements, per screen kind: bar stacks live in
 * rows 6..15 (small text ends at row 5); the heat grid starts at x=20. */
function matchFrame(capture: Uint8Array, frames: Uint8Array[], kind: 'bars' | 'heat'): number {
  const x0 = kind === 'bars' ? 0 : 20;
  const y0 = kind === 'bars' ? 6 : 0;
  outer: for (let i = frames.length - 1; i >= 0; i--) {
    for (let y = y0; y < HEIGHT; y++) {
      for (let x = x0; x < WIDTH; x++) {
        const o = (y * WIDTH + x) * 3;
        if (
          capture[o] !== frames[i]![o] ||
          capture[o + 1] !== frames[i]![o + 1] ||
          capture[o + 2] !== frames[i]![o + 2]
        ) {
          continue outer;
        }
      }
    }
    return i;
  }
  return -1;
}

async function play(bytes: Uint8Array, screens: DemoScreen[], days: DayTokens[]): Promise<void> {
  const snapshot = (await (await deviceFetch('/api/busy/snapshot', { signal: AbortSignal.timeout(5000) })).json()) as {
    snapshot?: { type?: string };
  };
  const state = snapshot.snapshot?.type ?? 'unknown';
  if (state !== 'NOT_STARTED') {
    console.error(`busy timer is ${state} — not drawing over a session. Try again when it's idle.`);
    process.exitCode = 1;
    return;
  }

  console.log(`uploading ${FILE_NAME} (${(bytes.length / 1024).toFixed(1)} KiB)...`);
  await assetsUpload(APP_NAME, FILE_NAME, bytes);

  try {
    for (const { screen, introMs, frames } of screens) {
      await displayDraw({
        application_name: APP_NAME,
        priority: 60,
        elements: [chartElement(`intro-${screen.section}`), ...textElements(screen, days)],
      });
      // Verify on the wire: match captures against the local frames while the
      // intro plays. Any hit past frame 0 proves the appearance is animating.
      const seen = new Set<number>();
      const deadline = Date.now() + introMs;
      while (Date.now() < deadline) {
        seen.add(matchFrame(await captureFront(), frames, screen.kind));
      }
      await sleep(300);
      await displayDraw({ application_name: APP_NAME, priority: 60, elements: [chartElement(screen.section)] });
      const hits = [...seen].filter((i) => i >= 0).sort((a, b) => a - b);
      const misses = [...seen].filter((i) => i < 0).length;
      console.log(
        `${screen.label}: intro ${introMs}ms, matched frames [${hits.join(', ')}]` +
          (misses ? ` (+${misses} captures mid-update)` : '')
      );
      await sleep(2000);
    }
  } finally {
    await displayClear(APP_NAME).catch((e) => console.error(`cleanup draw: ${(e as Error).message}`));
    await assetsDelete(APP_NAME).catch((e) => console.error(`cleanup asset: ${(e as Error).message}`));
    console.log('cleaned up: display cleared, asset removed (mbar repaints on its next heartbeat or any button press)');
  }
}

// --- main --------------------------------------------------------------------

if (import.meta.main) {
  const args = process.argv.slice(2);
  const mode = args.find((a) => !a.startsWith('--')) ?? 'preview';
  const outFlag = args.indexOf('--out');
  const outDir = outFlag >= 0 ? args[outFlag + 1]! : `${tmpdir()}/history-intro`;

  const history = loadStatsHistory();
  if (!history) {
    console.error(`no readable stats cache at ${statsCachePath()}`);
    process.exit(1);
  }
  const { bytes, screens } = buildDemo(history.days);
  console.log(
    `built ${FILE_NAME}: ${(bytes.length / 1024).toFixed(1)} KiB, ` +
      screens.map((s) => `${s.screen.label} ${s.frames.length}f/${s.introMs}ms`).join(', ')
  );

  if (mode === 'preview') {
    await writePreview(screens, outDir);
  } else if (mode === 'play') {
    await play(bytes, screens, history.days);
  } else {
    console.error(`unknown mode '${mode}' — use preview or play`);
    process.exit(1);
  }
}
