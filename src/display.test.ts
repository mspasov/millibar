import { afterEach, describe, expect, test } from 'bun:test';
import type { DisplayDrawParams } from '@busy-app/busy-lib';
import {
  COLORS,
  DisplaySession,
  HIDDEN,
  displayDraw,
  formatResetCompact,
  mixRgb,
  progressBar,
  scaleRgb,
  severityColor,
  textWidth,
  type DrawElement,
} from './display';
import { restoreFetch, stubFetch } from './test-util';

describe('displayDraw', () => {
  afterEach(restoreFetch);

  test('the body on the wire carries exactly what was passed — LED colour included', async () => {
    // The reason displayDraw exists at all: busy-lib's DisplayDraw accepts
    // led_notification_color in its params type, then rebuilds the body
    // from only {application_name, priority, elements} — it type-checked,
    // returned 200, and the light never came on. This is the wire-level
    // assertion that a regression back to the library path cannot pass.
    const calls = stubFetch();
    const body: DisplayDrawParams = {
      application_name: 'test_app',
      priority: 51,
      led_notification_color: '#00CCFFFF',
      elements: [
        {
          id: 'x', type: 'rectangle', x: 0, y: 0, width: 1, height: 1, radius: 0,
          fill: 'solid', fill_colors: ['#FFFFFFFF'], border_width: 0,
          border_color: '#FFFFFFFF', display: 'front',
        },
      ],
    };
    await displayDraw(body);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.pathname).toBe('/api/display/draw');
    expect(calls[0]!.method).toBe('POST');
    expect(JSON.parse(String(calls[0]!.body))).toEqual(body);
  });
});

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

  test('out-of-range factors clamp instead of corrupting the hex', () => {
    // Unclamped, 0xFF * 1.5 is 0x17E — three digits, an eleven-char colour.
    expect(scaleRgb('#FF3322FF', 1.5)).toBe('#ff4d33FF');
    expect(scaleRgb('#FF3322FF', -1)).toBe('#000000FF');
    expect(mixRgb('#33DD66FF', '#FF3322FF', 1.5)).toBe('#ff0000FF');
    expect(mixRgb('#33DD66FF', '#FF3322FF', -0.5)).toBe('#00ff88FF');
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

  test('animation tombstones go opacity 0 — the timeout alone leaves them up for a second', async () => {
    const sent: DisplayDrawParams[] = [];
    const session = makeSession(sent);
    await session.draw([
      { id: 'chart', type: 'animation', path: 'chart.anim', section: '30d', loop: true,
        await_previous_end: false, opacity: 100, x: 0, y: 0, display: 'front' },
    ]);
    await session.draw([text('a')]);
    const tomb = sent[1]!.elements[1] as { type: string; opacity: number; section: string; timeout?: number };
    // Still an animation with its section: a type swap 400s and a missing
    // section would fall back to playing the whole file for its last second.
    expect(tomb).toMatchObject({ type: 'animation', section: '30d', opacity: 0, timeout: 1 });
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

  /** A send that completes only when the test says so — the device is slow. */
  function gatedSession(sent: DisplayDrawParams[]) {
    const gates: Array<() => void> = [];
    const session = new DisplaySession({
      applicationName: 'test_app',
      priority: 50,
      timeoutS: 90,
      send: (body) =>
        new Promise<void>((resolve) => {
          sent.push(body);
          gates.push(resolve);
        }),
      clear: async () => { sent.push({ application_name: 'clear', priority: 0, elements: [] }); },
    });
    const release = () => gates.shift()?.();
    return { session, release };
  }
  const settle = () => new Promise<void>((r) => setTimeout(r, 0));

  test('frames issued while one is in flight collapse to the newest', async () => {
    const sent: DisplayDrawParams[] = [];
    const { session, release } = gatedSession(sent);
    const first = session.draw([text('a')]);
    await settle(); // 'a' is on the wire
    const b = session.draw([text('b')]);
    const c = session.draw([text('c')]);
    const d = session.draw([text('d')]);
    release();
    await first;
    await settle();
    release();
    await Promise.all([b, c, d]);
    // 'a', then 'd' — 'b' and 'c' were superseded before they were sent…
    expect(sent.map((body) => body.elements[0]!.id)).toEqual(['a', 'd']);
    // …so 'a' is scrubbed by the frame that replaced it, and 'b'/'c' owe nothing.
    expect(sent[1]!.elements.map((el) => el.id)).toEqual(['d', 'a']);
  });

  test('a burst of animation ticks and a press ends in exactly two more requests', async () => {
    const sent: DisplayDrawParams[] = [];
    const { session, release } = gatedSession(sent);
    void session.draw([rect('fill')]);
    await settle();
    // Twenty sweep ticks land during the in-flight draw, then the dial press.
    for (let i = 0; i < 20; i++) void session.draw([{ ...rect('fill'), x: i }]);
    const press = session.draw([text('next-module')]);
    release();
    await settle();
    release();
    await press;
    expect(sent).toHaveLength(2);
    expect(sent[1]!.elements[0]!.id).toBe('next-module');
  });

  test('a draw issued after clear() lands after it, not folded into the frame ahead', async () => {
    const sent: DisplayDrawParams[] = [];
    const { session, release } = gatedSession(sent);
    const a = session.draw([text('a')]);
    await settle();
    const b = session.draw([text('b')]);
    const cleared = session.clear();
    const c = session.draw([text('c')]);
    release();
    await a;
    await settle();
    release();
    await Promise.all([b, cleared]);
    await settle();
    release();
    await c;
    expect(sent.map((body) => body.application_name === 'clear' ? 'clear' : body.elements[0]!.id)).toEqual([
      'a', 'b', 'clear', 'c',
    ]);
    // The clear forgot 'b', so 'c' owes it no tombstone.
    expect(sent[3]!.elements.map((el) => el.id)).toEqual(['c']);
  });

  test('an injected clear keeps the whole session off the network', async () => {
    const sent: DisplayDrawParams[] = [];
    let cleared = 0;
    const session = new DisplaySession({
      applicationName: 'test_app',
      priority: 50,
      timeoutS: 90,
      send: async (body) => { sent.push(body); },
      clear: async () => { cleared++; },
    });
    await session.draw([text('a')]);
    await session.clear();
    expect(cleared).toBe(1);
    // The clear forgot 'a': redrawing nothing afterwards owes no tombstone.
    await session.draw([text('b')]);
    expect(sent[1]!.elements.map((el) => el.id)).toEqual(['b']);
  });
});
