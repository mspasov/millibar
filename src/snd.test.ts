import { describe, expect, test } from 'bun:test';
import { pcm16 } from './snd';

describe('pcm16', () => {
  test('scales so the loudest sample lands on the requested peak', () => {
    const pcm = pcm16(Float64Array.from([0.1, -0.2]), 0.5);
    // Loudest is |-0.2| -> 0.5 full scale; the rest keep their ratio.
    expect(pcm[1]).toBe(-16383); // round(-0.5 * 32767)
    expect(pcm[0]).toBe(8192); // round(0.25 * 32767)
  });

  test('peak 1 reaches full scale', () => {
    expect(pcm16(Float64Array.from([0.25]), 1)[0]).toBe(32767);
  });

  test('silence stays silence instead of dividing by zero', () => {
    expect([...pcm16(new Float64Array(3))]).toEqual([0, 0, 0]);
  });
});
