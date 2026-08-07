import { describe, expect, test } from 'bun:test';
import { COLORS, mixRgb } from './display';
import { PctSweep, sweepHead, type SweepFrame } from './sweep';

const GREEN = COLORS.ok;
const RED = COLORS.critical;
const WHITE = '#FFFFFFFF';
const HOT_RED = mixRgb(RED, WHITE, 0.75);

function fakeClock(startMs = 1000) {
  let t = startMs;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function makeSweep(clock = fakeClock()) {
  return new PctSweep({ durationMs: 100, coolMs: 50, now: clock.now });
}

describe('PctSweep', () => {
  test('set() jumps to the value with no head', () => {
    const sweep = makeSweep();
    sweep.set(40, GREEN);
    expect(sweep.current()).toEqual({ pct: 40, color: GREEN, headColor: null });
  });

  test('to() eases toward the target and lands on the exact band colour', () => {
    const clock = fakeClock();
    const sweep = makeSweep(clock);
    sweep.set(0, GREEN);
    sweep.to(80, RED);
    expect(sweep.current().pct).toBe(0);

    clock.advance(50);
    const mid = sweep.current();
    // Ease-out cubic at t=0.5 has covered 87.5% of the distance.
    expect(mid.pct).toBeCloseTo(70, 5);
    expect(mid.color).not.toBe(GREEN);
    expect(mid.color).not.toBe(RED);
    expect(mid.headColor).toBe(mixRgb(mid.color, WHITE, 0.75));

    clock.advance(50);
    const done = sweep.current();
    expect(done.pct).toBe(80);
    expect(done.color).toBe(RED);
  });

  test('the head cools from white-hot to the fill colour, then hides', () => {
    const clock = fakeClock();
    const sweep = makeSweep(clock);
    sweep.set(0, GREEN);
    sweep.to(80, RED);
    clock.advance(100);
    expect(sweep.current().headColor).toBe(HOT_RED);
    clock.advance(25);
    expect(sweep.current().headColor).toBe(mixRgb(HOT_RED, RED, 0.5));
    clock.advance(25);
    expect(sweep.current().headColor).toBeNull();
  });

  test('a retarget mid-sweep starts from the eased position', () => {
    const clock = fakeClock();
    const sweep = makeSweep(clock);
    sweep.set(0, GREEN);
    sweep.to(80, RED);
    clock.advance(50); // shown: 70
    sweep.to(0, GREEN);
    expect(sweep.current().pct).toBeCloseTo(70, 5);
    clock.advance(150); // duration + cool
    expect(sweep.current()).toEqual({ pct: 0, color: GREEN, headColor: null });
  });

  test('re-sending the settled target neither moves nor reflashes the head', () => {
    const clock = fakeClock();
    const sweep = makeSweep(clock);
    sweep.set(0, GREEN);
    sweep.to(80, RED);
    clock.advance(200);
    sweep.to(80, RED);
    expect(sweep.current()).toEqual({ pct: 80, color: RED, headColor: null });
  });

  test('durationMs 0 makes to() behave as set()', () => {
    const sweep = new PctSweep({ durationMs: 0, coolMs: 0, now: fakeClock().now });
    sweep.to(55, RED);
    expect(sweep.current()).toEqual({ pct: 55, color: RED, headColor: null });
  });

  test('onFrame ticks while animating, then stops once the head has cooled', async () => {
    let frames = 0;
    const sweep = new PctSweep({ durationMs: 60, coolMs: 30, tickMs: 5, onFrame: () => frames++ });
    sweep.to(50, RED);
    await Bun.sleep(150);
    const settled = frames;
    expect(settled).toBeGreaterThan(3);
    await Bun.sleep(50);
    expect(frames).toBe(settled);
  });
});

describe('sweepHead', () => {
  const geometry = { y: 12, height: 3, width: 72 };
  const el = (frame: SweepFrame) => sweepHead(frame, geometry) as { x: number; fill_colors: string[] };

  test('pins to the last fill column', () => {
    expect(el({ pct: 50, color: RED, headColor: HOT_RED }).x).toBe(35);
    expect(el({ pct: 100, color: RED, headColor: HOT_RED }).x).toBe(71);
    expect(el({ pct: 50, color: RED, headColor: HOT_RED }).fill_colors).toEqual([HOT_RED]);
  });

  test('hides by alpha when settled and at zero', () => {
    expect(el({ pct: 50, color: RED, headColor: null }).fill_colors[0]!.endsWith('00')).toBe(true);
    expect(el({ pct: 0, color: GREEN, headColor: HOT_RED }).fill_colors[0]!.endsWith('00')).toBe(true);
  });
});
