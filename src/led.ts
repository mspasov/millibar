/**
 * Drives the BUSY Bar's status light: intensity pulses and colour crossfades.
 *
 * The only exposed LED control is `led_notification_color` on a draw request,
 * which runs the firmware's `notification` preset: blink on/off at 500ms for 6
 * ticks. Two firmware details make smooth animation possible anyway
 * (`applications/services/status_lights/`):
 *
 *   1. `status_lights_do_run_preset` frees any running preset and calls
 *      `run_pattern` *immediately*, and `blink` starts in its on-phase — so a
 *      new colour takes effect at once rather than on the next 500ms tick.
 *   2. Re-issuing faster than the 500ms period therefore keeps the light
 *      continuously lit while the colour changes under it.
 *
 * **Alpha does not control intensity.** `status_lights_set_output` reads only
 * `color.r/g/b`, and the notification preset sets `override_brightness = true`,
 * so the device brightness setting is bypassed too. Intensity comes from
 * scaling the RGB components themselves.
 *
 * Each frame is one small HTTP draw (~11ms round trip on the wire).
 *
 * Usage:
 *   bun run src/led.ts pulse [#RRGGBB] [ms] [cycles]
 *   bun run src/led.ts fade  [#A,#B,...] [ms] [rgb|hsv]
 */

import { httpBase } from './config';
import { deviceFetch } from './connection';

type Rgb = [number, number, number];

export type ColorSpace = 'rgb' | 'hsv';

interface TransportOptions {
  addr?: string;
  /** Draws are attributed to this app, so priority behaves like any other draw. */
  applicationName?: string;
  priority?: number;
  signal?: AbortSignal;
}

export interface PulseOptions extends TransportOptions {
  /** `#RRGGBB` or `#RRGGBBAA`; any alpha is ignored by the LED. */
  color?: string;
  durationMs?: number;
  /** Fade in-and-out repetitions across the duration. */
  cycles?: number;
  framesPerSecond?: number;
}

/** The subset of PulseOptions a caller may override per pulse — named once so
 * module.ts and host.ts don't each hand-write the same literal. */
export type PulseShape = Pick<PulseOptions, 'durationMs' | 'cycles'>;

export interface FadeOptions extends TransportOptions {
  /** Two or more stops to travel through, in order. */
  colors: string[];
  durationMs?: number;
  framesPerSecond?: number;
  /**
   * `rgb` interpolates channels directly. `hsv` travels the shortest way round
   * the hue wheel, which keeps saturation up — red→green stays vivid instead of
   * passing through muddy olive.
   */
  space?: ColorSpace;
  /** Run the whole sequence this many times. */
  loop?: number;
  /** After the last stop, walk back through the stops to the first. */
  pingPong?: boolean;
  /** Trailing fade to black. 0 snaps off instead. */
  fadeOutMs?: number;
}

/** Perceptual correction: PWM output is linear in the component value, so a
 * linear ramp reads as a hard flash at the top and nothing at the bottom. */
const PERCEPTUAL_GAMMA = 2.2;
/** Must stay under the preset's 500ms blink period or the light starts flashing. */
const MAX_FRAME_GAP_MS = 400;

function parseRgb(color: string): Rgb {
  const hex = color.replace('#', '').trim();
  if (hex.length < 6) throw new Error(`bad colour: ${color}`);
  return [
    parseInt(hex.slice(0, 2), 16),
    parseInt(hex.slice(2, 4), 16),
    parseInt(hex.slice(4, 6), 16),
  ];
}

function toHex(rgb: Rgb, intensity: number): string {
  const k = Math.max(0, Math.min(1, intensity)) ** PERCEPTUAL_GAMMA;
  const hex = rgb
    .map((c) => Math.round(Math.max(0, Math.min(255, c)) * k).toString(16).padStart(2, '0'))
    .join('');
  return `#${hex}FF`;
}

function rgbToHsv([r, g, b]: Rgb): [number, number, number] {
  const [rn, gn, bn] = [r / 255, g / 255, b / 255];
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;

  let hue = 0;
  if (delta !== 0) {
    if (max === rn) hue = ((gn - bn) / delta) % 6;
    else if (max === gn) hue = (bn - rn) / delta + 2;
    else hue = (rn - gn) / delta + 4;
  }
  hue = (hue * 60 + 360) % 360;
  return [hue, max === 0 ? 0 : delta / max, max];
}

function hsvToRgb([h, s, v]: [number, number, number]): Rgb {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  const sector = Math.floor(h / 60) % 6;
  const [r, g, b] = [
    [c, x, 0],
    [x, c, 0],
    [0, c, x],
    [0, x, c],
    [x, 0, c],
    [c, 0, x],
  ][sector]!;
  return [Math.round((r! + m) * 255), Math.round((g! + m) * 255), Math.round((b! + m) * 255)];
}

function mix(from: Rgb, to: Rgb, t: number, space: ColorSpace): Rgb {
  if (space === 'rgb') {
    return [
      from[0] + (to[0] - from[0]) * t,
      from[1] + (to[1] - from[1]) * t,
      from[2] + (to[2] - from[2]) * t,
    ];
  }

  let [hueFrom, satFrom, valFrom] = rgbToHsv(from);
  let [hueTo, satTo, valTo] = rgbToHsv(to);

  // Degenerate endpoints carry no usable hue (and black no usable saturation),
  // so they borrow the other end's. Resolve this *before* measuring the hue
  // distance — doing it after leaves the distance based on a hue that is no
  // longer in play, which sends black -> cyan sweeping backwards through red.
  if (valFrom === 0) [hueFrom, satFrom] = [hueTo, satTo];
  else if (satFrom === 0) hueFrom = hueTo;
  if (valTo === 0) [hueTo, satTo] = [hueFrom, satFrom];
  else if (satTo === 0) hueTo = hueFrom;

  // Shortest way round the wheel, so 350° -> 10° crosses zero rather than
  // sweeping backwards through every other hue.
  let deltaHue = hueTo - hueFrom;
  if (deltaHue > 180) deltaHue -= 360;
  if (deltaHue < -180) deltaHue += 360;

  return hsvToRgb([
    (hueFrom + deltaHue * t + 360) % 360,
    satFrom + (satTo - satFrom) * t,
    valFrom + (valTo - valFrom) * t,
  ]);
}

/** A 1x1 fully transparent pixel: `elements` is required and must be non-empty,
 * but elements merge by id, so this leaves whatever is on screen untouched. */
const FILLER_ELEMENT = {
  id: 'ledpulse',
  type: 'rectangle',
  x: 0,
  y: 0,
  width: 1,
  height: 1,
  radius: 0,
  fill: 'solid',
  fill_colors: ['#00000000'],
  border_width: 0,
  border_color: '#00000000',
  timeout: 1,
  display: 'front',
};

function createSender(options: TransportOptions) {
  // An explicit addr bypasses the connection config, like everywhere else.
  const explicitBase = options.addr ? httpBase(options.addr) : undefined;
  const applicationName = options.applicationName ?? 'claude_usage';
  const priority = options.priority ?? 50;

  /** `signal` cancels an in-flight frame at once — without it an abort is only
   * observed at the next frame boundary, which on a degraded network delays
   * the pulse that preempted this one by up to the 2s frame timeout. The final
   * cleanup frame passes no signal: an aborted pulse must still turn the
   * light off. */
  return async function send(ledColor: string, signal?: AbortSignal): Promise<void> {
    const init: RequestInit = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        application_name: applicationName,
        priority,
        led_notification_color: ledColor,
        elements: [FILLER_ELEMENT],
      }),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(2000)])
        : AbortSignal.timeout(2000),
    };
    try {
      if (explicitBase) await fetch(`${explicitBase}/api/display/draw`, init);
      else await deviceFetch('/api/display/draw', init);
    } catch {
      // A dropped frame just makes the animation slightly coarser; never let it
      // interrupt the caller.
    }
  };
}

/** Run `frameCount` frames at a fixed cadence, compensating for request time.
 * Returns how many frames actually ran before completion or abort. */
async function animate(
  frameCount: number,
  frameMs: number,
  signal: AbortSignal | undefined,
  onFrame: (index: number) => Promise<void>
): Promise<number> {
  for (let i = 0; i < frameCount; i++) {
    if (signal?.aborted) return i;
    const startedAt = Date.now();
    await onFrame(i);
    const remaining = frameMs - (Date.now() - startedAt);
    if (remaining > 0) await Bun.sleep(remaining);
  }
  return frameCount;
}

/**
 * Fade the status light in and out. Resolves once the pulse has finished and
 * the light has been returned to off.
 */
export async function pulseLed(options: PulseOptions = {}): Promise<void> {
  const { color = '#00CCFF', durationMs = 1400, cycles = 2, framesPerSecond = 30 } = options;
  const send = createSender(options);
  const rgb = parseRgb(color);
  const frameCount = Math.max(2, Math.round((durationMs / 1000) * framesPerSecond));

  const ran = await animate(frameCount, durationMs / frameCount, options.signal, async (i) => {
    const phase = (i / frameCount) * cycles * 2 * Math.PI;
    // Raised cosine: starts and ends at zero, peaks mid-cycle.
    await send(toHex(rgb, (1 - Math.cos(phase)) / 2), options.signal);
  });

  // Without this the notification preset keeps blinking the last colour for the
  // remainder of its ~3s run. A black colour blinks black-on-black, i.e. off.
  // A pulse aborted before its first frame lit nothing and sends nothing: its
  // late cleanup draw would land after the host's shutdown display clear and
  // re-register the application on the device.
  if (ran > 0) await send('#000000FF');
}

/**
 * Crossfade the status light through a list of colours. Resolves once the
 * sequence has finished and the light has been returned to off.
 */
export async function fadeLed(options: FadeOptions): Promise<void> {
  const {
    colors,
    durationMs = 2000,
    framesPerSecond = 30,
    space = 'hsv',
    loop = 1,
    pingPong = false,
    fadeOutMs = 400,
  } = options;

  if (colors.length < 2) throw new Error('fadeLed needs at least two colours');

  const send = createSender(options);
  let stops = colors.map(parseRgb);
  if (pingPong) stops = [...stops, ...stops.slice(0, -1).reverse()];

  const frameMs = 1000 / framesPerSecond;
  if (frameMs > MAX_FRAME_GAP_MS) {
    throw new Error(`framesPerSecond must be at least ${Math.ceil(1000 / MAX_FRAME_GAP_MS)}`);
  }

  const frameCount = Math.max(2, Math.round((durationMs / 1000) * framesPerSecond));
  const segments = stops.length - 1;
  let last: Rgb = stops[0]!;
  let ran = 0;

  for (let pass = 0; pass < loop; pass++) {
    ran += await animate(frameCount, frameMs, options.signal, async (i) => {
      // Position along the whole stop list, then which segment that lands in.
      const position = (i / (frameCount - 1)) * segments;
      const index = Math.min(Math.floor(position), segments - 1);
      last = mix(stops[index]!, stops[index + 1]!, position - index, space);
      await send(toHex(last, 1), options.signal);
    });
    if (options.signal?.aborted) break;
  }

  if (fadeOutMs > 0 && !options.signal?.aborted) {
    const outFrames = Math.max(2, Math.round((fadeOutMs / 1000) * framesPerSecond));
    ran += await animate(outFrames, frameMs, options.signal, async (i) => {
      await send(toHex(last, 1 - (i + 1) / outFrames), options.signal);
    });
  }

  // Same rule as pulseLed: nothing lit means nothing to put out.
  if (ran > 0) await send('#000000FF');
}

if (import.meta.main) {
  const [mode = 'pulse', ...rest] = process.argv.slice(2);

  if (mode === 'fade') {
    const [list = '#FF0000,#00FF00,#0000FF', duration = '2000', space = 'hsv'] = rest;
    const colors = list.split(',').map((c) => c.trim());
    console.log(`Fading ${colors.join(' -> ')} over ${duration}ms in ${space} space...`);
    await fadeLed({
      colors,
      durationMs: Number(duration),
      space: space as ColorSpace,
    });
  } else {
    const [color = '#00CCFF', duration = '1400', cycles = '2'] = rest;
    console.log(`Pulsing ${color} for ${duration}ms over ${cycles} cycle(s)...`);
    await pulseLed({ color, durationMs: Number(duration), cycles: Number(cycles) });
  }
  console.log('done');
}
