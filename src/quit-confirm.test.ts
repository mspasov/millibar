import { afterEach, describe, expect, test } from 'bun:test';
import { COLORS, textWidth, type DrawElement } from './display';
import { QuitConfirm, ensureTurnOffAsset } from './quit-confirm';
import { restoreFetch, stubFetch, type CapturedRequest } from './test-util';

function fakeClock(startMs = 1000) {
  let t = startMs;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function collector() {
  const frames: DrawElement[][] = [];
  return { frames, draw: (elements: DrawElement[]) => frames.push(elements) };
}

function fillWidth(frame: DrawElement[]): number {
  const fill = frame.find((el) => el.id === 'quit.fill');
  if (!fill || fill.type !== 'rectangle') throw new Error('no quit.fill rectangle in frame');
  return fill.width;
}

describe('QuitConfirm', () => {
  test('arm() draws the prompt immediately: centred text and a full bar', () => {
    const clock = fakeClock();
    const { frames, draw } = collector();
    const quit = new QuitConfirm({ draw, onExpire: () => {}, now: clock.now, tickMs: 60_000 });
    expect(quit.armed).toBe(false);
    quit.arm();
    expect(quit.armed).toBe(true);
    expect(frames.length).toBe(1);

    const frame = frames[0]!;
    expect(frame.map((el) => el.id)).toEqual(['quit.text', 'quit.track', 'quit.fill']);
    const text = frame[0]!;
    if (text.type !== 'text') throw new Error('expected a text element');
    expect(text.text).toBe('AGAIN = QUIT');
    expect(text.color).toBe(COLORS.warn);
    // mid_left centring: first inked column at x, so x splits the slack.
    expect(text.x).toBe(Math.floor((72 - textWidth('AGAIN = QUIT')) / 2));
    expect(fillWidth(frame)).toBe(72);
    quit.disarm();
  });

  test('the bar drains with the clock', () => {
    const clock = fakeClock();
    const { draw } = collector();
    const quit = new QuitConfirm({ draw, onExpire: () => {}, now: clock.now, tickMs: 60_000 });
    quit.arm();
    clock.advance(2500);
    expect(fillWidth(quit.render())).toBe(36);
    clock.advance(2500);
    // progressBar floors the fill at 1px; it's hidden by alpha, not width.
    expect(fillWidth(quit.render())).toBe(1);
    quit.disarm();
  });

  test('animate: false pins the bar full and never ticks', async () => {
    const clock = fakeClock();
    const { frames, draw } = collector();
    const quit = new QuitConfirm({
      draw,
      onExpire: () => {},
      now: clock.now,
      windowMs: 1000,
      tickMs: 5,
      animate: false,
    });
    quit.arm();
    clock.advance(600);
    expect(fillWidth(quit.render())).toBe(72);
    await Bun.sleep(40);
    expect(frames.length).toBe(1);
    quit.disarm();
  });

  test('the ticker redraws until the window closes, then onExpire fires once', async () => {
    let expired = 0;
    const { frames, draw } = collector();
    const quit = new QuitConfirm({
      draw,
      onExpire: () => {
        expired += 1;
      },
      windowMs: 60,
      tickMs: 10,
    });
    quit.arm();
    await Bun.sleep(150);
    expect(expired).toBe(1);
    expect(quit.armed).toBe(false);
    expect(frames.length).toBeGreaterThan(2);
    // Frames only ever drain — and none arrive after expiry.
    const widths = frames.map(fillWidth);
    expect(widths).toEqual([...widths].sort((a, b) => b - a));
    const drawn = frames.length;
    await Bun.sleep(30);
    expect(frames.length).toBe(drawn);
  });

  test('disarm() cancels the window and reports whether one was open', async () => {
    let expired = 0;
    const { draw } = collector();
    const quit = new QuitConfirm({
      draw,
      onExpire: () => {
        expired += 1;
      },
      windowMs: 40,
      tickMs: 60_000,
    });
    expect(quit.disarm()).toBe(false);
    quit.arm();
    expect(quit.disarm()).toBe(true);
    expect(quit.armed).toBe(false);
    await Bun.sleep(80);
    expect(expired).toBe(0);
  });

  test('a second arm while armed keeps the original deadline', () => {
    const clock = fakeClock();
    const { frames, draw } = collector();
    const quit = new QuitConfirm({ draw, onExpire: () => {}, now: clock.now, tickMs: 60_000 });
    quit.arm();
    clock.advance(2500);
    quit.arm();
    expect(frames.length).toBe(1);
    expect(fillWidth(quit.render())).toBe(36);
    quit.disarm();
  });
});

describe('ensureTurnOffAsset', () => {
  afterEach(restoreFetch);

  const SOURCE_BYTES = new Uint8Array([0x62, 0x69, 0x63, 0x79, 0x63, 0x6c, 0x65, 0x30]);

  /** The device: soft_off holds the source; `appFiles` is our asset dir
   * (null = directory missing, which the firmware reports as a 400). */
  function respond(appFiles: { name: string; size: number }[] | null) {
    return ({ url }: CapturedRequest): Response => {
      const path = url.searchParams.get('path');
      if (url.pathname === '/api/storage/list') {
        if (path === '/ext/apps_assets/soft_off/animations') {
          return Response.json({
            list: [{ type: 'file', name: 'turn_off_72x16.anim', size: SOURCE_BYTES.length }],
          });
        }
        if (appFiles && path === '/ext/user_assets/mbar_test') {
          return Response.json({ list: appFiles });
        }
        return Response.json({ error: 'Bad Request' }, { status: 400 });
      }
      if (url.pathname === '/api/storage/read') return new Response(SOURCE_BYTES);
      if (url.pathname === '/api/assets/upload') return Response.json({ result: 'OK' });
      throw new Error(`unexpected request: ${url.pathname}`);
    };
  }

  test('copies the firmware asset when the app has no copy yet', async () => {
    const calls = stubFetch(respond(null));
    const logs: string[] = [];
    expect(await ensureTurnOffAsset('mbar_test', (m) => logs.push(m))).toBe(true);

    const upload = calls.find((c) => c.url.pathname === '/api/assets/upload');
    expect(upload).toBeDefined();
    expect(upload!.url.searchParams.get('application_name')).toBe('mbar_test');
    expect(upload!.url.searchParams.get('file')).toBe('turn_off.anim');
    // The uploaded body is the bytes read from the firmware asset, verbatim.
    expect(new Uint8Array(upload!.body as Uint8Array)).toEqual(SOURCE_BYTES);
    expect(logs.some((m) => m.includes('turn-off animation'))).toBe(true);
  });

  test('skips the copy when the existing asset matches by size', async () => {
    const calls = stubFetch(respond([{ name: 'turn_off.anim', size: SOURCE_BYTES.length }]));
    expect(await ensureTurnOffAsset('mbar_test', () => {})).toBe(true);
    expect(calls.some((c) => c.url.pathname === '/api/storage/read')).toBe(false);
    expect(calls.some((c) => c.url.pathname === '/api/assets/upload')).toBe(false);
  });

  test('re-copies when the firmware asset changed size', async () => {
    const calls = stubFetch(respond([{ name: 'turn_off.anim', size: 1 }]));
    expect(await ensureTurnOffAsset('mbar_test', () => {})).toBe(true);
    expect(calls.some((c) => c.url.pathname === '/api/assets/upload')).toBe(true);
  });

  test('resolves false instead of throwing when storage fails', async () => {
    stubFetch(() => Response.json({ error: 'Bad Request' }, { status: 400 }));
    const logs: string[] = [];
    expect(await ensureTurnOffAsset('mbar_test', (m) => logs.push(m))).toBe(false);
    expect(logs.length).toBe(1);
  });
});
