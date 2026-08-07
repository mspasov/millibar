import { describe, expect, test } from 'bun:test';
import type { DisplayDrawParams } from '@busy-app/busy-lib';
import {
  COLORS,
  DisplaySession,
  HIDDEN,
  formatResetCompact,
  mixRgb,
  progressBar,
  scaleRgb,
  severityColor,
  textWidth,
  type DrawElement,
} from './display';

describe('severityColor', () => {
  test('green below 50, amber from 50, red from 80', () => {
    expect(severityColor(0)).toBe(COLORS.ok);
    expect(severityColor(49)).toBe(COLORS.ok);
    expect(severityColor(50)).toBe(COLORS.warn);
    expect(severityColor(79)).toBe(COLORS.warn);
    expect(severityColor(80)).toBe(COLORS.critical);
    expect(severityColor(100)).toBe(COLORS.critical);
  });
});

describe('colour helpers', () => {
  test('HIDDEN zeroes the alpha channel only', () => {
    expect(HIDDEN('#33DD66FF')).toBe('#33DD6600');
    expect(HIDDEN('#33DD66')).toBe('#33DD6600');
  });

  test('scaleRgb scales components and keeps alpha FF', () => {
    expect(scaleRgb('#FF3322FF', 0.35)).toBe('#59120cFF');
    expect(scaleRgb('#000000FF', 0.5)).toBe('#000000FF');
  });

  test('mixRgb lerps per channel, endpoints exact, alpha pinned FF', () => {
    expect(mixRgb('#33DD66FF', '#FF3322FF', 0)).toBe('#33dd66FF');
    expect(mixRgb('#33DD66FF', '#FF3322FF', 1)).toBe('#ff3322FF');
    expect(mixRgb('#00000000', '#FFFFFF00', 0.5)).toBe('#808080FF');
  });
});

describe('textWidth', () => {
  test('uses measured glyph widths with 1px spacing', () => {
    expect(textWidth('5H')).toBe(8); // 3 + 1 + 4
    expect(textWidth('I')).toBe(1);
    expect(textWidth('')).toBe(0);
  });
});

describe('formatResetCompact', () => {
  const inMs = (ms: number) => new Date(Date.now() + ms).toISOString();

  test('no reset scheduled', () => {
    expect(formatResetCompact(null, 30)).toBe('');
  });

  test('hours:minutes when it fits, hours fallback when not', () => {
    expect(formatResetCompact(inMs(2 * 3_600_000), 30)).toBe('2:00');
    expect(formatResetCompact(inMs(2 * 3_600_000), 8)).toBe('2H');
  });

  test('days with and without hours above a day', () => {
    expect(formatResetCompact(inMs(6 * 86_400_000 + 4 * 3_600_000), 30)).toBe('6D4H');
    expect(formatResetCompact(inMs(6 * 86_400_000 + 4 * 3_600_000), 9)).toBe('6D');
  });

  test('minutes under an hour, empty when nothing fits', () => {
    expect(formatResetCompact(inMs(59 * 60_000), 30)).toBe('59M');
    expect(formatResetCompact(inMs(2 * 3_600_000), 3)).toBe('');
  });
});

describe('progressBar', () => {
  test('track spans the width, fill is proportional', () => {
    const [track, fill] = progressBar({ pct: 50, color: COLORS.ok, y: 12, width: 72, height: 3 });
    expect(track).toMatchObject({ id: 'track', type: 'rectangle', width: 72, fill_colors: [COLORS.track] });
    expect(fill).toMatchObject({ id: 'fill', type: 'rectangle', width: 36, fill_colors: [COLORS.ok] });
  });

  test('at 0% the fill keeps a 1px floor but is hidden by alpha', () => {
    const [, fill] = progressBar({ pct: 0, color: COLORS.ok, y: 12, width: 72, height: 3 });
    expect(fill).toMatchObject({ width: 1, fill_colors: [HIDDEN(COLORS.ok)] });
  });
});

const text = (id: string): DrawElement => ({
  id, type: 'text', text: 'X', font: 'small', color: '#FFFFFFFF',
  align: 'mid_left', x: 0, y: 5, display: 'front',
});
const rect = (id: string): DrawElement => ({
  id, type: 'rectangle', x: 0, y: 12, width: 10, height: 3, radius: 0,
  fill: 'solid', fill_colors: ['#33DD66FF'], border_width: 0, border_color: '#33DD66FF',
  display: 'front',
});

function makeSession(sent: DisplayDrawParams[], sendImpl?: (body: DisplayDrawParams) => Promise<void>) {
  return new DisplaySession({
    applicationName: 'test_app',
    priority: 50,
    timeoutS: 90,
    send: sendImpl ?? (async (body) => { sent.push(body); }),
  });
}

describe('DisplaySession', () => {
  test('stamps the session timeout onto every element', async () => {
    const sent: DisplayDrawParams[] = [];
    const session = makeSession(sent);
    await session.draw([text('a'), rect('b')]);
    expect(sent[0]!.elements.map((el) => el.timeout)).toEqual([90, 90]);
  });

  test('an id that disappears is tombstoned once, invisibly and expiring', async () => {
    const sent: DisplayDrawParams[] = [];
    const session = makeSession(sent);
    await session.draw([text('a'), rect('b')]);
    await session.draw([rect('b')]);
    const second = sent[1]!.elements;
    expect(second.map((el) => el.id)).toEqual(['b', 'a']);
    const tomb = second[1]!;
    // Same type as the original — a type swap is rejected by the firmware.
    expect(tomb.type).toBe('text');
    expect((tomb as { color: string }).color).toBe('#FFFFFF00');
    expect(tomb.timeout).toBe(1);

    await session.draw([rect('b')]);
    expect(sent[2]!.elements.map((el) => el.id)).toEqual(['b']);
  });

  test('rectangle tombstones zero-alpha their fill and border', async () => {
    const sent: DisplayDrawParams[] = [];
    const session = makeSession(sent);
    await session.draw([rect('b')]);
    await session.draw([text('a')]);
    const tomb = sent[1]!.elements[1] as { fill_colors: string[]; border_color: string };
    expect(tomb.fill_colors).toEqual(['#33DD6600']);
    expect(tomb.border_color).toBe('#33DD6600');
  });

  test('a tombstone lost to a failed draw is retried on the next one', async () => {
    const sent: DisplayDrawParams[] = [];
    let failNext = false;
    const session = makeSession(sent, async (body) => {
      if (failNext) {
        failNext = false;
        throw new Error('boom');
      }
      sent.push(body);
    });
    await session.draw([text('a')]);
    failNext = true;
    await expect(session.draw([rect('b')])).rejects.toThrow('boom');
    await session.draw([rect('b')]);
    expect(sent[1]!.elements.map((el) => el.id)).toEqual(['b', 'a']);
  });

  test('redrawing an id cancels its pending tombstone', async () => {
    const sent: DisplayDrawParams[] = [];
    const session = makeSession(sent);
    await session.draw([text('a')]);
    await session.draw([rect('b')]); // 'a' tombstoned here
    await session.draw([text('a')]); // 'a' is back — must be drawn visibly, once
    expect(sent[2]!.elements.map((el) => el.id)).toEqual(['a', 'b']);
    expect((sent[2]!.elements[0] as { color: string }).color).toBe('#FFFFFFFF');
  });

  test('an empty frame with nothing to scrub sends no request', async () => {
    const sent: DisplayDrawParams[] = [];
    const session = makeSession(sent);
    await session.draw([]);
    expect(sent).toHaveLength(0);
  });

  test('an empty frame still scrubs vanished elements', async () => {
    const sent: DisplayDrawParams[] = [];
    const session = makeSession(sent);
    await session.draw([text('a')]);
    await session.draw([]);
    expect(sent[1]!.elements.map((el) => el.id)).toEqual(['a']);
    expect(sent[1]!.elements[0]!.timeout).toBe(1);
  });

  test('elements without an id are rejected', async () => {
    const session = makeSession([]);
    await expect(session.draw([text('')])).rejects.toThrow(/needs an id/);
  });
});
