/**
 * Drives the BUSY Bar's status light as a smooth fade.
 *
 * The only exposed LED control is `led_notification_color` on a draw request,
 * which runs the firmware's `notification` preset: blink on/off at 500ms for 6
 * ticks. Two firmware details make a real fade possible anyway
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
 * Usage: bun run src/led.ts [#RRGGBB] [durationMs] [cycles]
 */

export interface PulseOptions {
  /** `#RRGGBB` or `#RRGGBBAA`; any alpha is ignored by the LED. */
  color?: string;
  durationMs?: number;
  /** Fade in-and-out repetitions across the duration. */
  cycles?: number;
  framesPerSecond?: number;
  addr?: string;
  /** Draws are attributed to this app, so priority behaves like any other draw. */
  applicationName?: string;
  priority?: number;
  signal?: AbortSignal;
}

/** Perceptual correction: PWM output is linear in the component value, so a
 * linear ramp reads as a hard flash at the top and nothing at the bottom. */
const PERCEPTUAL_GAMMA = 2.2;

function parseRgb(color: string): [number, number, number] {
  const hex = color.replace('#', '');
  if (hex.length < 6) throw new Error(`bad colour: ${color}`);
  return [
    parseInt(hex.slice(0, 2), 16),
    parseInt(hex.slice(2, 4), 16),
    parseInt(hex.slice(4, 6), 16),
  ];
}

function scaled(rgb: [number, number, number], intensity: number): string {
  const k = Math.max(0, Math.min(1, intensity)) ** PERCEPTUAL_GAMMA;
  const hex = rgb.map((c) => Math.round(c * k).toString(16).padStart(2, '0')).join('');
  return `#${hex}FF`;
}

/**
 * Fade the status light in and out. Resolves when the pulse has finished and
 * the light has been returned to off.
 */
export async function pulseLed(options: PulseOptions = {}): Promise<void> {
  const {
    color = '#00CCFF',
    durationMs = 1400,
    cycles = 2,
    framesPerSecond = 30,
    applicationName = 'claude_usage',
    priority = 50,
    signal,
  } = options;

  const addr = options.addr ?? process.env.BUSY_BAR_ADDR ?? '10.0.4.20';
  const baseUrl = addr.startsWith('http') ? addr : `http://${addr}`;
  const rgb = parseRgb(color);
  const frameCount = Math.max(2, Math.round((durationMs / 1000) * framesPerSecond));
  const frameMs = durationMs / frameCount;

  // A 1x1 fully transparent pixel: `elements` is required and must be non-empty,
  // but elements merge by id, so this leaves whatever is on screen untouched.
  const filler = {
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

  async function send(ledColor: string): Promise<void> {
    try {
      await fetch(`${baseUrl}/api/display/draw`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          application_name: applicationName,
          priority,
          led_notification_color: ledColor,
          elements: [filler],
        }),
        signal: AbortSignal.timeout(2000),
      });
    } catch {
      // A dropped frame just makes the fade slightly coarser; never let it
      // interrupt the caller.
    }
  }

  for (let i = 0; i < frameCount; i++) {
    if (signal?.aborted) break;
    const phase = (i / frameCount) * cycles * 2 * Math.PI;
    // Raised cosine: starts and ends at zero, peaks mid-cycle.
    const intensity = (1 - Math.cos(phase)) / 2;
    const startedAt = Date.now();
    await send(scaled(rgb, intensity));
    const remaining = frameMs - (Date.now() - startedAt);
    if (remaining > 0) await Bun.sleep(remaining);
  }

  // Without this the notification preset keeps blinking the last colour for the
  // remainder of its ~3s run. A black colour blinks black-on-black, i.e. off.
  await send('#000000FF');
}

if (import.meta.main) {
  const [color = '#00CCFF', duration = '1400', cycles = '2'] = process.argv.slice(2);
  console.log(`Pulsing ${color} for ${duration}ms over ${cycles} cycle(s)...`);
  await pulseLed({ color, durationMs: Number(duration), cycles: Number(cycles) });
  console.log('done');
}
