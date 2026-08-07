import { afterEach, describe, expect, test } from 'bun:test';
import { pulseLed } from './led';

// Wire-level: capture the led_notification_color of every draw the pulse
// sends. The light itself is unobservable (no endpoint, not in the
// framebuffer), so the sent frames are the only assertable truth.
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function captureLedFrames(): string[] {
  const frames: string[] = [];
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    frames.push(JSON.parse(String(init?.body)).led_notification_color);
    return new Response('{}');
  }) as typeof fetch;
  return frames;
}

describe('pulseLed', () => {
  test('a single cycle peaks at full colour exactly once and ends off', async () => {
    const frames = captureLedFrames();
    await pulseLed({ color: '#FF3322', durationMs: 400, cycles: 1, framesPerSecond: 30 });
    // One blink = one full-intensity frame (the raised cosine's midpoint).
    expect(frames.filter((f) => f === '#ff3322FF')).toHaveLength(1);
    expect(frames[frames.length - 1]).toBe('#000000FF');
  });

  test('a preempted pulse stops early and still ends with the light off', async () => {
    const frames = captureLedFrames();
    const controller = new AbortController();
    const run = pulseLed({ color: '#FF3322', durationMs: 5000, cycles: 1, signal: controller.signal });
    await Bun.sleep(80);
    controller.abort();
    await run;
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.length).toBeLessThan(20); // nowhere near the full 150 frames
    expect(frames[frames.length - 1]).toBe('#000000FF');
  });
});
