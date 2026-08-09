/**
 * Test bench for the percentage-change animation proposed for the monitor
 * modules: an eased sweep of the bar with a white-hot 1px leading edge that
 * cools after landing, the number rolling through intermediate values, and the
 * severity colour lerped (green→amber→red) instead of flipping when the sweep
 * crosses a band boundary.
 *
 * The tween is time-based: each frame computes its position from the wall
 * clock, so if the device draws slower than the tick the animation drops
 * frames and still lands on schedule — the per-sweep stats line reports the
 * frame rate actually achieved, which is the number that decides what the
 * modules can afford.
 *
 * Usage:
 *   bun run tools/sweep.ts 10 47 85 30    # play a sequence, then clear and exit
 *   bun run tools/sweep.ts                # interactive: type targets on stdin
 *   bun run tools/sweep.ts --demo         # random targets until Ctrl-C
 * Flags: --duration <ms> (sweep length, default 500; interactive: 'd 800')
 * Env: BUSY_BAR_ADDR, BUSY_PRIORITY
 *
 * If the millibar host is running it holds the display at priority 50, and the
 * device rejects same-priority draws from a different application_name — run
 * with BUSY_PRIORITY=51 to draw over it. Exiting clears this app's elements;
 * mbar will not repaint on its own until a button press or its next heartbeat.
 */
import { deviceAddr, envNumber } from '../src/config';
import {
  COLORS,
  DISPLAYS,
  DisplaySession,
  HIDDEN,
  mixRgb,
  progressBar,
  severityColor,
  type DrawElement,
} from '../src/display';

const WIDTH = DISPLAYS.front.width;
const BAR_Y = 12;
const BAR_HEIGHT = 3;
const LABEL_X = 2;

/** Target frame cadence. The real ceiling is the device's draw latency; the
 * stats line reports what was actually achieved. */
const TICK_MS = 33;
const DEFAULT_DURATION_MS = 500;
/** How far the leading edge is blended toward white. */
const HEAD_WHITE = 0.75;
/** Settle: the head cools from white-hot to the fill colour, then hides. */
const COOL_MS = 160;
const COOL_STEPS = 4;
/** Beat between scripted-sequence targets. */
const PAUSE_MS = 700;

const WHITE = '#FFFFFFFF';
const APP_NAME = 'sweep_test';
const PRIORITY = envNumber('BUSY_PRIORITY', 50, 1);
const ADDR = deviceAddr();
/** Refreshed by every draw; the screen self-clears if the process dies. */
const DRAW_TIMEOUT_S = 60;
const KEEPALIVE_MS = 20_000;

const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;
const clampPct = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

/** One full frame in the modules' visual language: label, rolling number,
 * bar, and the leading-edge head pinned to the fill's last column. The head
 * element is always emitted (hidden by alpha) so its id never tombstones. */
function frame(pct: number, color: string, headColor: string): DrawElement[] {
  const fillWidth = Math.max(1, Math.round((WIDTH * pct) / 100));
  const head = pct > 0 ? headColor : HIDDEN(headColor);
  return [
    {
      id: 'label',
      type: 'text',
      text: 'SWEEP',
      font: 'small',
      color: COLORS.label,
      align: 'mid_left',
      x: LABEL_X,
      y: 5,
      display: 'front',
    },
    {
      id: 'pct',
      type: 'text',
      text: `${Math.round(pct)}%`,
      font: 'normal',
      color,
      align: 'mid_right',
      x: WIDTH - 2,
      y: 5,
      display: 'front',
    },
    ...progressBar({ pct, color, y: BAR_Y, width: WIDTH, height: BAR_HEIGHT }),
    {
      id: 'head',
      type: 'rectangle',
      x: fillWidth - 1,
      y: BAR_Y,
      width: 1,
      height: BAR_HEIGHT,
      radius: 0,
      fill: 'solid',
      fill_colors: [head],
      border_width: 0,
      border_color: head,
      display: 'front',
    },
  ];
}

async function main() {
  let durationMs = DEFAULT_DURATION_MS;
  let demo = false;
  const targets: number[] = [];
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--duration' || arg === '-d') durationMs = Number(args[++i]) || durationMs;
    else if (arg === '--demo') demo = true;
    else if (Number.isFinite(Number(arg))) targets.push(clampPct(Number(arg)));
    else throw new Error(`unrecognised argument: ${arg}`);
  }

  const session = new DisplaySession({
    applicationName: APP_NAME,
    priority: PRIORITY,
    timeoutS: DRAW_TIMEOUT_S,
  });

  // What is currently on screen; sweeps start from here, so a colour lerp
  // begun mid-band starts at the exact shade being shown.
  let shown = { pct: 0, color: severityColor(0) };
  let sweeping = false;

  async function sweep(target: number): Promise<void> {
    const from = shown.pct;
    const fromColor = shown.color;
    const to = clampPct(target);
    const toColor = severityColor(to);
    sweeping = true;
    const drawTimes: number[] = [];
    const start = performance.now();
    try {
      while (true) {
        const t = Math.min(1, (performance.now() - start) / durationMs);
        const eased = easeOutCubic(t);
        const pct = from + (to - from) * eased;
        const color = mixRgb(fromColor, toColor, eased);
        shown = { pct, color };
        const drawStart = performance.now();
        await session.draw(frame(pct, color, mixRgb(color, WHITE, HEAD_WHITE)));
        drawTimes.push(performance.now() - drawStart);
        if (t >= 1) break;
        const wait = TICK_MS - (performance.now() - drawStart);
        if (wait > 0) await Bun.sleep(wait);
      }
      const sweepMs = performance.now() - start;

      for (let i = 1; i <= COOL_STEPS; i++) {
        await Bun.sleep(COOL_MS / COOL_STEPS);
        const cooled =
          i === COOL_STEPS
            ? HIDDEN(shown.color)
            : mixRgb(mixRgb(shown.color, WHITE, HEAD_WHITE), shown.color, i / COOL_STEPS);
        await session.draw(frame(shown.pct, shown.color, cooled));
      }

      const avg = drawTimes.reduce((a, b) => a + b, 0) / drawTimes.length;
      const max = Math.max(...drawTimes);
      console.log(
        `${Math.round(from)}% -> ${to}%: ${drawTimes.length} frames in ${Math.round(sweepMs)}ms ` +
          `(${((drawTimes.length * 1000) / sweepMs).toFixed(1)} fps; ` +
          `draw avg ${avg.toFixed(0)}ms, max ${max.toFixed(0)}ms)`
      );
    } finally {
      sweeping = false;
    }
  }

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void session
        .clear()
        .catch(() => {})
        .finally(() => process.exit(0));
    });
  }

  console.log(`sweep test on ${ADDR} — duration ${durationMs}ms, tick ${TICK_MS}ms`);
  await session.draw(frame(shown.pct, shown.color, HIDDEN(WHITE)));

  if (targets.length > 0) {
    for (const target of targets) {
      await sweep(target);
      await Bun.sleep(PAUSE_MS);
    }
    await session.clear();
    console.log('Cleared. If the monitor is running, press any button to repaint it.');
    return;
  }

  // Long-lived modes idle between sweeps; keep the element timeouts fresh.
  // Cleared on 'q' — a live interval would keep the process from exiting.
  const keepalive = setInterval(() => {
    if (sweeping) return;
    session
      .draw(frame(shown.pct, shown.color, HIDDEN(WHITE)))
      .catch((e) => console.error(`keepalive: ${(e as Error).message}`));
  }, KEEPALIVE_MS);

  if (demo) {
    console.log('demo mode: random targets until Ctrl-C');
    while (true) {
      let target = clampPct(Math.random() * 101);
      // Small hops don't exercise the effect; re-roll until the move is visible.
      while (Math.abs(target - shown.pct) < 15) target = clampPct(Math.random() * 101);
      console.log(`-> ${target}%`);
      await sweep(target);
      await Bun.sleep(PAUSE_MS * 2);
    }
  }

  console.log("type a target percentage (several run in order: '10 85 30'), 'd 800' to set the sweep duration, 'q' to quit");
  process.stdout.write('> ');
  for await (const line of console) {
    const input = line.trim();
    if (input === 'q' || input === 'quit') break;
    const setDuration = input.match(/^d\s*=?\s*(\d+)$/);
    if (setDuration) {
      durationMs = Number(setDuration[1]);
      console.log(`duration ${durationMs}ms`);
    } else {
      const numbers = input.split(/[\s,]+/).map(Number).filter(Number.isFinite);
      if (numbers.length === 0 && input !== '') console.log("targets are numbers 0-100; 'q' quits");
      for (const target of numbers) await sweep(clampPct(target));
    }
    process.stdout.write('> ');
  }
  clearInterval(keepalive);
  await session.clear();
  console.log('Cleared. If the monitor is running, press any button to repaint it.');
}

if (import.meta.main) await main();
