/**
 * Renders the README's screen mockups locally — no device — by running the
 * real modules' render() on curated fixture data and rasterizing the element
 * lists with the firmware's own fonts, then drawing the frame as a glowing
 * LED matrix.
 *
 * Usage:
 *   bun run tools/readme-shots.ts generate [--fw <busybar-firmware>]
 *   bun run tools/readme-shots.ts validate <real-gauge.png> [--fw <path>]
 *
 * The firmware checkout supplies the fonts (assets/shared/fonts/*.font):
 *   git clone --depth 1 https://github.com/busy-app/busybar-firmware
 * The path can also come from BUSYBAR_FW.
 *
 * Fidelity rests on porting the firmware's exact text semantics — see
 * DEVICE.md, "Text element fonts". `validate` proves the port: it renders
 * the data behind a *real* `/api/screen` capture of the gauge (5H at 13%,
 * 3:25 to reset, 7D at 31% — `git show d273866:docs/img/gauge.png` is such
 * a baseline) and diffs the local raster against the device's framebuffer.
 * At last check the two matched pixel-for-pixel.
 *
 * `generate` overwrites docs/img/*.png with the curated showcase set.
 */
import { inflateSync } from 'node:zlib';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodePng } from '../src/png';
import type { ModuleContext, MonitorModule } from '../src/module';
import { claudeGaugeModule } from '../src/modules/claude-gauge';
import { claudeDashModule } from '../src/modules/claude-dash';
import { grokGaugeModule } from '../src/modules/grok-gauge';
import { cpuModule } from '../src/modules/cpu';
import { claudeHistoryModule, paintBars, paintHeatmap, windowDays, SCREENS } from '../src/modules/claude-history';
import type { DayTokens } from '../src/stats';
import type { Usage } from '../src/usage';
import type { GrokWeeklyUsage } from '../src/grok-usage';

const W = 72;
const H = 16;
const OUT_DIR = join(import.meta.dir, '../docs/img');

// ---------------------------------------------------------------- binfont --
// LVGL binary font (lv_binfont_loader.c): 'head' metrics, 'cmap' subtables,
// 'loca' offsets, 'glyf' bit-packed glyph descriptors + 1bpp bitmaps.

interface Glyph {
  advPx: number;
  ofsX: number;
  ofsY: number;
  boxW: number;
  boxH: number;
  bits: Uint8Array; // boxW*boxH, 1 = ink
}

interface Font {
  lineHeight: number;
  baseLine: number;
  glyphs: (cp: number) => Glyph | null;
}

class BitReader {
  private pos: number;
  constructor(
    private buf: Buffer,
    byteOffset: number
  ) {
    this.pos = byteOffset * 8;
  }
  read(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const byte = this.buf[this.pos >> 3]!;
      v = (v << 1) | ((byte >> (7 - (this.pos & 7))) & 1);
      this.pos++;
    }
    return v;
  }
  readSigned(n: number): number {
    const v = this.read(n);
    return v & (1 << (n - 1)) ? v - (1 << n) : v;
  }
}

export function parseBinfont(buf: Buffer): Font {
  const label = (start: number, tag: string): number => {
    if (buf.toString('ascii', start + 4, start + 8) !== tag) {
      throw new Error(`expected '${tag}' table at offset ${start}`);
    }
    return buf.readUInt32LE(start);
  };

  const headLen = label(0, 'head');
  const h = {
    ascent: buf.readUInt16LE(0x10),
    descent: buf.readInt16LE(0x12),
    defaultAdvance: buf.readUInt16LE(0x1e),
    indexToLocFormat: buf[0x22]!,
    advanceFormat: buf[0x24]!,
    bpp: buf[0x25]!,
    xyBits: buf[0x26]!,
    whBits: buf[0x27]!,
    advBits: buf[0x28]!,
    compression: buf[0x29]!,
  };
  if (h.bpp !== 1 || h.compression !== 0) {
    throw new Error(`only 1bpp raw supported, got bpp=${h.bpp} compression=${h.compression}`);
  }

  const cmapStart = headLen;
  const cmapLen = label(cmapStart, 'cmap');
  const subCount = buf.readUInt32LE(cmapStart + 8);
  const subs = Array.from({ length: subCount }, (_, i) => {
    const o = cmapStart + 12 + i * 16;
    return {
      dataOffset: buf.readUInt32LE(o),
      rangeStart: buf.readUInt32LE(o + 4),
      rangeLength: buf.readUInt16LE(o + 8),
      glyphIdStart: buf.readUInt16LE(o + 10),
      entries: buf.readUInt16LE(o + 12),
      format: buf[o + 14]!,
    };
  });

  // LV_FONT_FMT_TXT_CMAP_: 0 FORMAT0_FULL, 1 SPARSE_FULL, 2 FORMAT0_TINY,
  // 3 SPARSE_TINY (enum order in lv_font_fmt_txt.h).
  const glyphIdFor = (cp: number): number | null => {
    for (const s of subs) {
      if (cp < s.rangeStart || cp >= s.rangeStart + s.rangeLength) continue;
      const rel = cp - s.rangeStart;
      const data = cmapStart + s.dataOffset;
      if (s.format === 0) return s.glyphIdStart + buf[data + rel]!;
      if (s.format === 2) return s.glyphIdStart + rel;
      for (let i = 0; i < s.entries; i++) {
        if (buf.readUInt16LE(data + i * 2) === rel) {
          if (s.format === 1) return s.glyphIdStart + buf.readUInt16LE(data + s.entries * 2 + i * 2);
          return s.glyphIdStart + i;
        }
      }
      return null;
    }
    return null;
  };

  const locaStart = cmapStart + cmapLen;
  const locaLen = label(locaStart, 'loca');
  const locaCount = buf.readUInt32LE(locaStart + 8);
  const offsets = Array.from({ length: locaCount }, (_, i) =>
    h.indexToLocFormat === 0 ? buf.readUInt16LE(locaStart + 12 + i * 2) : buf.readUInt32LE(locaStart + 12 + i * 4)
  );

  const glyfStart = locaStart + locaLen;
  label(glyfStart, 'glyf');
  const cache = new Map<number, Glyph>();
  const glyphAt = (id: number): Glyph => {
    let g = cache.get(id);
    if (g) return g;
    const r = new BitReader(buf, glyfStart + offsets[id]!);
    let adv = h.advBits === 0 ? h.defaultAdvance : r.read(h.advBits);
    // advance_width_format 0 stores integer pixels; the loader scales to FP4
    // and lv_font_get_glyph_dsc_fmt_txt rounds back with (adv + 8) >> 4.
    if (h.advanceFormat === 0) adv *= 16;
    const ofsX = r.readSigned(h.xyBits);
    const ofsY = r.readSigned(h.xyBits);
    const boxW = r.read(h.whBits);
    const boxH = r.read(h.whBits);
    const bits = new Uint8Array(boxW * boxH);
    for (let i = 0; i < boxW * boxH; i++) bits[i] = r.read(1);
    g = { advPx: (adv + 8) >> 4, ofsX, ofsY, boxW, boxH, bits };
    cache.set(id, g);
    return g;
  };

  return {
    lineHeight: h.ascent - h.descent,
    baseLine: -h.descent,
    glyphs: (cp) => {
      const id = glyphIdFor(cp);
      return id === null ? null : glyphAt(id);
    },
  };
}

// ------------------------------------------------------------- rasterizer --

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

function parseColor(hex: string): Rgba {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})?$/i.exec(hex);
  if (!m) throw new Error(`bad colour '${hex}'`);
  return {
    r: parseInt(m[1]!, 16),
    g: parseInt(m[2]!, 16),
    b: parseInt(m[3]!, 16),
    a: m[4] ? parseInt(m[4], 16) / 255 : 1,
  };
}

/** Top-left of a w×h box whose align-named anchor sits at (x, y) — the
 * firmware's canvas_widget_reanchor plus LVGL object alignment, integer
 * division and all. */
function anchor(x: number, y: number, w: number, h: number, align: string): { x0: number; y0: number } {
  const [v, hz] = (
    {
      top_left: ['top', 'left'],
      top_mid: ['top', 'mid'],
      top_right: ['top', 'right'],
      mid_left: ['mid', 'left'],
      center: ['mid', 'mid'],
      mid_right: ['mid', 'right'],
      bottom_left: ['bottom', 'left'],
      bottom_mid: ['bottom', 'mid'],
      bottom_right: ['bottom', 'right'],
    } as Record<string, [string, string]>
  )[align] ?? ['top', 'left'];
  return {
    x0: hz === 'left' ? x : hz === 'mid' ? x - (w >> 1) : x - w,
    y0: v === 'top' ? y : v === 'mid' ? y - (h >> 1) : y - h,
  };
}

/** Rasterizes a draw-element list to a 72×16 RGB frame, matching the
 * firmware: `small`/`normal` text (LVGL label placement: glyph top =
 * box_top + (line_height - base_line) - box_h - ofs_y, advances FP4-rounded,
 * letter_space 0) and solid radius-0 rectangles, alpha src-over on black. */
export function rasterize(elements: unknown[], fonts: Record<string, Font>, base?: Uint8Array): Uint8Array {
  const frame = new Uint8Array(W * H * 3);
  if (base) frame.set(base);
  const blend = (x: number, y: number, c: Rgba): void => {
    if (x < 0 || x >= W || y < 0 || y >= H || c.a <= 0) return;
    const o = (y * W + x) * 3;
    frame[o] = Math.round(c.r * c.a + frame[o]! * (1 - c.a));
    frame[o + 1] = Math.round(c.g * c.a + frame[o + 1]! * (1 - c.a));
    frame[o + 2] = Math.round(c.b * c.a + frame[o + 2]! * (1 - c.a));
  };

  for (const raw of elements) {
    const el = raw as Record<string, any>;
    if (el.display === 'back') continue;
    if (el.type === 'animation') {
      // The history chart: its content is the painted frame passed as `base`
      // (the module bakes paintBars/paintHeatmap output into the asset), so
      // the element itself has nothing left to contribute.
      if (el.x !== 0 || el.y !== 0) throw new Error('animation elements are only supported at 0,0');
      continue;
    }
    if (el.type === 'text') {
      const font = fonts[el.font ?? 'normal'];
      if (!font) throw new Error(`unsupported font '${el.font}'`);
      const colour = parseColor(el.color ?? '#FFFFFF');
      let width = 0;
      for (const ch of el.text as string) width += font.glyphs(ch.codePointAt(0)!)?.advPx ?? 0;
      const { x0, y0 } = anchor(el.x ?? 0, el.y ?? 0, width, font.lineHeight, el.align ?? 'top_left');
      let pen = x0;
      for (const ch of el.text as string) {
        const g = font.glyphs(ch.codePointAt(0)!);
        if (!g) continue;
        const gy = y0 + (font.lineHeight - font.baseLine) - g.boxH - g.ofsY;
        for (let by = 0; by < g.boxH; by++) {
          for (let bx = 0; bx < g.boxW; bx++) {
            if (g.bits[by * g.boxW + bx]) blend(pen + g.ofsX + bx, gy + by, colour);
          }
        }
        pen += g.advPx;
      }
    } else if (el.type === 'rectangle') {
      if (el.radius) throw new Error(`radius ${el.radius} not supported`);
      if (el.fill && el.fill !== 'solid') throw new Error(`fill '${el.fill}' not supported`);
      const colour = parseColor(el.fill_colors?.[0] ?? '#FFFFFF');
      const { x0, y0 } = anchor(el.x ?? 0, el.y ?? 0, el.width, el.height, el.align ?? 'top_left');
      for (let y = y0; y < y0 + el.height; y++) {
        for (let x = x0; x < x0 + el.width; x++) blend(x, y, colour);
      }
    } else {
      throw new Error(`unsupported element type '${el.type}'`);
    }
  }
  return frame;
}

// ------------------------------------------------------------ glow output --

/** Draws a 1× frame as an LED panel: round dots with the unlit matrix
 * faintly visible, plus additive bloom around lit pixels. The user picked
 * this style over flat squares and stronger glow variants. */
export function renderGlow(fb: Uint8Array): { rgb: Uint8Array; width: number; height: number } {
  const cell = 12;
  const pad = 18;
  const width = W * cell + pad * 2;
  const height = H * cell + pad * 2;
  const acc = new Float64Array(width * height * 3);
  const BG = [8, 8, 10] as const;
  const UNLIT = [22, 23, 25] as const;
  for (let i = 0; i < width * height; i++) {
    acc[i * 3] = BG[0];
    acc[i * 3 + 1] = BG[1];
    acc[i * 3 + 2] = BG[2];
  }
  const r = cell * 0.38;
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      const src = (py * W + px) * 3;
      const lit = fb[src]! | fb[src + 1]! | fb[src + 2]!;
      const colour = lit ? [fb[src]!, fb[src + 1]!, fb[src + 2]!] : UNLIT;
      const cx = pad + px * cell + cell / 2;
      const cy = pad + py * cell + cell / 2;
      for (let y = Math.floor(cy - r - 1); y <= Math.ceil(cy + r + 1); y++) {
        for (let x = Math.floor(cx - r - 1); x <= Math.ceil(cx + r + 1); x++) {
          if (x < 0 || x >= width || y < 0 || y >= height) continue;
          const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
          const cov = Math.min(1, Math.max(0, r + 0.5 - d));
          if (cov <= 0) continue;
          const o = (y * width + x) * 3;
          for (let c = 0; c < 3; c++) acc[o + c] = acc[o + c]! * (1 - cov) + colour[c]! * cov;
        }
      }
    }
  }
  // Bloom: gaussian splat per lit pixel. Tuned so glyphs stay crisp and the
  // bar's fill/track contrast survives (sigma 0.55 cells, gain 0.32).
  const sigma = cell * 0.55;
  const radius = Math.ceil(sigma * 2.5);
  const gain = 0.32;
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      const src = (py * W + px) * 3;
      if ((fb[src]! + fb[src + 1]! + fb[src + 2]!) / 3 < 4) continue;
      const cx = pad + px * cell + cell / 2;
      const cy = pad + py * cell + cell / 2;
      for (let dy = -radius; dy <= radius; dy++) {
        const y = Math.round(cy) + dy;
        if (y < 0 || y >= height) continue;
        for (let dx = -radius; dx <= radius; dx++) {
          const x = Math.round(cx) + dx;
          if (x < 0 || x >= width) continue;
          const g = Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma)) * gain;
          const o = (y * width + x) * 3;
          acc[o] = acc[o]! + fb[src]! * g;
          acc[o + 1] = acc[o + 1]! + fb[src + 1]! * g;
          acc[o + 2] = acc[o + 2]! + fb[src + 2]! * g;
        }
      }
    }
  }
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0; i < rgb.length; i++) rgb[i] = Math.min(255, Math.round(acc[i]!));
  return { rgb, width, height };
}

// ---------------------------------------------------------- module driving --

const nullContext = (): ModuleContext => ({
  applicationName: 'readme_shots',
  requestRender: () => {},
  pulseActivity: () => {},
  log: () => {},
  warn: () => {},
  signal: new AbortController().signal,
});

async function renderModule(module: MonitorModule, fonts: Record<string, Font>): Promise<Uint8Array> {
  module.init?.(nullContext());
  await module.poll();
  return rasterize(module.render({ refreshing: false }), fonts);
}

async function loadFonts(fwPath: string): Promise<Record<string, Font>> {
  // The draw API's font-name table (api_display.c): small = busy_regular_5,
  // normal = busy_regular_7.
  const dir = join(fwPath, 'assets/shared/fonts');
  const load = async (name: string) => {
    const file = Bun.file(join(dir, name));
    if (!(await file.exists())) {
      throw new Error(
        `${join(dir, name)} not found — pass --fw (or set BUSYBAR_FW) to a checkout of\n` +
          `  git clone --depth 1 https://github.com/busy-app/busybar-firmware`
      );
    }
    return parseBinfont(Buffer.from(await file.arrayBuffer()));
  };
  return { small: await load('busy_regular_5.font'), normal: await load('busy_regular_7.font') };
}

const hours = (n: number) => new Date(Date.now() + n * 3_600_000).toISOString();

async function validate(baselinePath: string, fonts: Record<string, Font>): Promise<number> {
  // The data behind the real capture at d273866: 5H at 13%, 3:25 to reset.
  // +40s keeps the countdown text stable across the render.
  const usage: Usage = {
    fiveHour: { utilization: 13, resetsAt: new Date(Date.now() + (3 * 60 + 25) * 60_000 + 40_000).toISOString() },
    sevenDay: { utilization: 31, resetsAt: hours(3 * 24) },
    models: [],
    fetchedAt: new Date(),
  };
  const module = claudeGaugeModule({
    pollIntervalMs: 600_000,
    refreshCooldownMs: 5_000,
    sweepMs: 0,
    sweepCoolMs: 0,
    cachePath: null,
    fetchUsageImpl: async () => usage,
  });
  module.init?.(nullContext());
  await module.poll();
  const local = rasterize(module.render({ refreshing: false }), fonts);

  // Decode the baseline (written by src/png.ts: filter-0 truecolour) to 1×.
  const png = Buffer.from(await Bun.file(baselinePath).arrayBuffer());
  let off = 8;
  let width = 0;
  const idat: Buffer[] = [];
  while (off < png.length) {
    const len = png.readUInt32BE(off);
    const type = png.toString('ascii', off + 4, off + 8);
    if (type === 'IHDR') width = png.readUInt32BE(off + 8);
    if (type === 'IDAT') idat.push(png.subarray(off + 8, off + 8 + len));
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const factor = width / W;
  if (!Number.isInteger(factor)) throw new Error(`baseline width ${width} is not a multiple of ${W}`);
  const stride = width * 3 + 1;
  const art = (fb: Uint8Array, name: string): void => {
    console.log(
      `${name}:\n` +
        Array.from({ length: H }, (_, y) =>
          Array.from({ length: W }, (_, x) => {
            const o = (y * W + x) * 3;
            return fb[o]! | fb[o + 1]! | fb[o + 2]! ? '#' : '.';
          }).join('')
        ).join('\n')
    );
  };

  const real = new Uint8Array(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const src = y * factor * stride + 1 + x * factor * 3;
      real.set(raw.subarray(src, src + 3), (y * W + x) * 3);
    }
  }

  let mismatches = 0;
  for (let i = 0; i < W * H * 3; i += 3) {
    if (local[i] !== real[i] || local[i + 1] !== real[i + 1] || local[i + 2] !== real[i + 2]) mismatches++;
  }
  console.log(`mismatched pixels: ${mismatches}`);
  if (mismatches > 0) {
    art(local, 'LOCAL');
    art(real, 'REAL');
  }
  return mismatches;
}

async function generate(fonts: Record<string, Font>): Promise<void> {
  const shots: Record<string, Uint8Array> = {};

  // Claude limits — one fixture serving both modules: 5H 67% amber and over
  // pace, 7D 42% green, FABLE 88% red, so the dashboard shows every severity.
  const usage: Usage = {
    fiveHour: { utilization: 67, resetsAt: new Date(Date.now() + (2 * 60 + 41) * 60_000 + 40_000).toISOString() },
    sevenDay: { utilization: 42, resetsAt: hours(2.6 * 24) },
    models: [{ model: 'Fable', utilization: 88, resetsAt: hours(4.2 * 24) }],
    fetchedAt: new Date(),
  };
  const usageOptions = {
    pollIntervalMs: 600_000,
    refreshCooldownMs: 5_000,
    sweepMs: 0, // settled values, not the first frame of the arrival sweep
    sweepCoolMs: 0,
    fetchUsageImpl: async () => usage,
  };
  shots['gauge'] = await renderModule(claudeGaugeModule({ ...usageOptions, cachePath: null }), fonts);
  shots['dash'] = await renderModule(claudeDashModule({ ...usageOptions, quiet: true, persist: false }), fonts);

  // History — ~5 months with a weekday rhythm, the model mix drifting from
  // sonnet-heavy to fable-heavy, occasional spike days and skipped days.
  // Deterministic LCG so regeneration is reproducible.
  let seed = 42;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const days: DayTokens[] = [];
  const DAY_MS = 86_400_000;
  const start = Date.now() - 150 * DAY_MS;
  for (let i = 0; i < 151; i++) {
    const date = new Date(start + i * DAY_MS).toISOString().slice(0, 10);
    const weekday = new Date(start + i * DAY_MS).getUTCDay();
    const weekend = weekday === 0 || weekday === 6;
    const ramp = 0.4 + (0.6 * i) / 150;
    const base = (weekend ? 14e6 : 60e6) * ramp * (0.55 + rand() * 0.9);
    const spike = rand() > 0.955 ? 1.8 : 1;
    const fableShare = 0.15 + (0.65 * i) / 150;
    const total = base * spike;
    const tokensByModel: Record<string, number> = {
      'claude-fable-5': Math.round(total * fableShare),
      'claude-sonnet-5': Math.round(total * (1 - fableShare) * 0.8),
      'claude-haiku-4-5': Math.round(total * (1 - fableShare) * 0.2),
    };
    if (rand() > 0.12 || spike > 1) {
      days.push({ date, tokensByModel, total: Object.values(tokensByModel).reduce((a, b) => a + b, 0) });
    }
  }
  // Drive the real module (label, total, and age text live in its render(),
  // not in the painted chart); the painted frames stand in for the uploaded
  // asset the chart element references.
  const statsDir = mkdtempSync(join(tmpdir(), 'readme-shots-'));
  try {
    const statsPath = join(statsDir, 'stats-cache.json');
    writeFileSync(
      statsPath,
      JSON.stringify({
        version: 5,
        dailyModelTokens: days.map((d) => ({ date: d.date, tokensByModel: d.tokensByModel })),
      })
    );
    const history = claudeHistoryModule({
      statsPath,
      todayImpl: () => days.at(-1)!.date, // fresh data: the age mark stays hidden
      uploadImpl: async () => {},
      scheduleImpl: () => () => {}, // no timers to keep the process alive
      intros: false,
    });
    history.init?.(nullContext());
    await history.poll();
    const bars = SCREENS.find((s) => s.days === 30) ?? SCREENS[0]!;
    shots['history-30d'] = rasterize(history.render({ refreshing: false }), fonts, paintBars(windowDays(days, bars.days), bars));
    history.onEncoder?.(2); // 30D -> 7D -> ALL
    shots['history-heatmap'] = rasterize(history.render({ refreshing: false }), fonts, paintHeatmap(days));
  } finally {
    rmSync(statsDir, { recursive: true, force: true });
  }

  // Grok weekly — 38%, 4 days 8 hours to the weekly reset.
  const grok: GrokWeeklyUsage = {
    usedPercent: 38,
    remainingPercent: 62,
    periodStart: hours(-(2 * 24 + 16)),
    resetsAt: hours(4 * 24 + 8.2),
    periodType: 'USAGE_PERIOD_TYPE_WEEKLY',
    fetchedAt: new Date(),
  };
  shots['grok'] = await renderModule(
    grokGaugeModule({
      pollIntervalMs: 600_000,
      refreshCooldownMs: 5_000,
      sweepMs: 0,
      sweepCoolMs: 0,
      cachePath: null,
      fetchUsageImpl: async () => grok,
    }),
    fonts
  );

  // CPU — 5.2 load on 10 cores: 52% one-minute pressure, amber.
  shots['cpu'] = await renderModule(cpuModule({ sweepMs: 0, sweepCoolMs: 0, cores: 10, loadavg: () => [5.2, 3.8, 2.9] }), fonts);

  for (const [name, fb] of Object.entries(shots)) {
    const { rgb, width, height } = renderGlow(fb);
    await Bun.write(join(OUT_DIR, `${name}.png`), encodePng(rgb, width, height, 1));
    console.log(`wrote docs/img/${name}.png`);
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  let fwPath = process.env['BUSYBAR_FW'];
  const fwFlag = argv.indexOf('--fw');
  if (fwFlag !== -1) {
    fwPath = argv[fwFlag + 1];
    argv.splice(fwFlag, 2);
  }
  const [mode, baseline] = argv;
  if (!fwPath || (mode !== 'generate' && mode !== 'validate') || (mode === 'validate' && !baseline)) {
    console.error('usage: bun run tools/readme-shots.ts generate|validate <real-gauge.png> [--fw <busybar-firmware>]');
    console.error('       (--fw defaults to BUSYBAR_FW; see the header for the validate baseline)');
    process.exit(1);
  }
  const fonts = await loadFonts(fwPath);
  if (mode === 'generate') await generate(fonts);
  else process.exit((await validate(baseline!, fonts)) === 0 ? 0 : 1);
}
