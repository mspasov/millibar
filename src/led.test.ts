import { afterEach, describe, expect, test } from 'bun:test';
import { pulseLed, SKIP_OFF_FRAME } from './led';
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
