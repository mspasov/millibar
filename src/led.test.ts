import { afterEach, describe, expect, test } from 'bun:test';
import { fadeLed, pulseLed, SKIP_OFF_FRAME } from './led';
import { restoreFetch, stubFetch, type CapturedRequest } from './test-util';

// Wire-level: capture the led_notification_color of every draw the pulse
// sends. The light itself is unobservable (no endpoint, not in the
// framebuffer), so the sent frames are the only assertable truth.
afterEach(restoreFetch);

const ledFrames = (calls: CapturedRequest[]): string[] =>
  calls.map((c) => JSON.parse(String(c.body)).led_notification_color);

describe('pulseLed', () => {
  test('a single cycle peaks at full colour exactly once and ends off', async () => {
    const calls = stubFetch();
    await pulseLed({ color: '#FF3322', durationMs: 400, cycles: 1, framesPerSecond: 30 });
    const frames = ledFrames(calls);
    // One blink = one full-intensity frame (the raised cosine's midpoint).
    expect(frames.filter((f) => f === '#ff3322FF')).toHaveLength(1);
    expect(frames[frames.length - 1]).toBe('#000000FF');
  });

  test('a preempted pulse stops early and still ends with the light off', async () => {
    const calls = stubFetch();
    const controller = new AbortController();
    const run = pulseLed({ color: '#FF3322', durationMs: 5000, cycles: 1, signal: controller.signal });
    await Bun.sleep(80);
    controller.abort();
    await run;
    const frames = ledFrames(calls);
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.length).toBeLessThan(20); // nowhere near the full 150 frames
    expect(frames[frames.length - 1]).toBe('#000000FF');
  });

  test('an abort with SKIP_OFF_FRAME sends no cleanup draw', async () => {
    // The cleanup frame is itself a display draw. When the host pauses all
    // drawing (selector switch away from OFF), it aborts the pulse with this
    // reason so not even the light-off frame lands on the system menu.
    const calls = stubFetch();
    const controller = new AbortController();
    const run = pulseLed({ color: '#FF3322', durationMs: 5000, cycles: 1, signal: controller.signal });
    await Bun.sleep(80);
    const framesBefore = calls.length;
    expect(framesBefore).toBeGreaterThan(0); // mid-pulse, frames were lit
    controller.abort(SKIP_OFF_FRAME);
    await run;
    expect(calls.length).toBe(framesBefore); // and nothing after the abort
  });

  test('a pulse aborted before its first frame sends nothing at all', async () => {
    // The cleanup draw must not go out either: it would land after the host's
    // shutdown display clear and re-register the application on the device.
    const calls = stubFetch();
    const controller = new AbortController();
    controller.abort();
    await pulseLed({ color: '#FF3322', signal: controller.signal });
    expect(calls).toHaveLength(0);
  });
});

describe('fadeLed', () => {
  const frameRgb = (hex: string): [number, number, number] => [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];

  test('hsv travels red -> green through vivid yellow, not muddy olive', async () => {
    // The point of the hsv space: an rgb lerp's midpoint is (128,128,0) —
    // desaturated olive — while the hue arc keeps full value, peaking near
    // (255,255,0). A real hue-interpolation bug shipped once; this pins the
    // arc by the frames on the wire.
    const calls = stubFetch();
    await fadeLed({
      colors: ['#FF0000', '#00FF00'],
      durationMs: 300,
      framesPerSecond: 30,
      space: 'hsv',
      fadeOutMs: 0,
    });
    const frames = ledFrames(calls);
    expect(frames[frames.length - 1]).toBe('#000000FF'); // returned to off
    const mid = frames.slice(1, -1).map(frameRgb);
    const yellow = mid.find(([r, g, b]) => r > 200 && g > 200 && b < 40);
    expect(yellow).toBeDefined();
    // No frame collapses toward the olive midpoint an rgb lerp would give.
    for (const [r, g, b] of mid) {
      expect(Math.max(r, g, b)).toBeGreaterThan(200);
      expect(b).toBeLessThan(40);
    }
  });

  test('the shortest hue arc crosses zero: magenta-red -> orange never sweeps backwards', async () => {
    // 350° -> 25° must pass through 0°/red (short way), not back through
    // green and blue. A wrong-direction arc shows up as green/blue frames.
    const calls = stubFetch();
    await fadeLed({
      colors: ['#FF0033', '#FF6A00'],
      durationMs: 300,
      framesPerSecond: 30,
      space: 'hsv',
      fadeOutMs: 0,
    });
    for (const [r, g, b] of ledFrames(calls).slice(0, -1).map(frameRgb)) {
      expect(r).toBeGreaterThan(200); // red stays dominant the whole way
      expect(g).toBeLessThan(130); // never detours through green…
      expect(b).toBeLessThan(60); // …or blue
    }
  });
});
