/**
 * System load as a monitor module — the minimal second module that proves the
 * host's switching and element scrubbing.
 *
 * Shows the machine's load average normalised by core count, in the same
 * visual language as the Claude module: label left, percentage right,
 * progress bar along the bottom. Rotating the encoder cycles the 1/5/15-minute
 * windows. Load average is what the OS actually publishes (os.loadavg), so the
 * label says which window it is rather than pretending to be instantaneous
 * CPU%. No activity indicator and no LED pulse: sampling is local and
 * instant, and a pulse every two seconds would strobe.
 *
 * Changes animate (src/sweep.ts), with a floor so ±1–2% sampling jitter jumps
 * silently instead of flashing the bar's leading edge every poll.
 */
import os from 'node:os';
import { COLORS, progressBar, severityColor, type DrawElement } from '../display';
import { wrapIndex, type ModuleContext, type MonitorModule, type PollResult } from '../module';
import { PctSweep, sweepHead } from '../sweep';

const WIDTH = 72;
const BAR_Y = 12;
const BAR_HEIGHT = 3;
const LABEL_X = 2;

const WINDOWS = [
  { label: 'CPU 1M', index: 0 },
  { label: 'CPU 5M', index: 1 },
  { label: 'CPU 15M', index: 2 },
] as const;

/** loadavg only moves every ~5s; 2s keeps the bar lively without draw spam. */
const POLL_MS = 2000;

/** Load jitters a point or two on every poll, and a white-hot head flash each
 * 2s would strobe — moves smaller than this (≤2px of bar) jump instead. */
const MIN_SWEEP_DELTA = 3;

export interface CpuOptions {
  /** Sweep timings, overridable so tests can run instant (0). */
  sweepMs?: number;
  sweepCoolMs?: number;
}

export function cpuModule(options: CpuOptions = {}): MonitorModule {
  const cores = os.cpus().length;
  let ctx: ModuleContext | null = null;
  let viewIndex = 0;
  let loads: number[] = [0, 0, 0];

  const sweep = new PctSweep({
    durationMs: options.sweepMs,
    coolMs: options.sweepCoolMs,
    onFrame: () => ctx?.requestRender(),
  });
  sweep.set(0, severityColor(0));

  const pctFor = (window: number): number =>
    Math.min(100, Math.round(((loads[window] ?? 0) / cores) * 100));

  const retarget = (minSweepDelta = 0): void => {
    const pct = pctFor(WINDOWS[viewIndex]!.index);
    const color = severityColor(pct);
    if (Math.abs(pct - sweep.current().pct) < minSweepDelta) sweep.set(pct, color);
    else sweep.to(pct, color);
  };

  return {
    id: 'cpu',
    title: 'CPU load',

    init(context) {
      ctx = context;
      context.signal.addEventListener('abort', () => sweep.stop());
    },

    async poll(): Promise<PollResult> {
      loads = os.loadavg();
      retarget(MIN_SWEEP_DELTA);
      // Local sampling cannot fail or be rate-limited: no refresh hold at all.
      return { nextPollMs: POLL_MS, holdRefreshMs: 0 };
    },

    render(): DrawElement[] {
      const view = WINDOWS[viewIndex]!;
      const shown = sweep.current();
      const { pct, color } = shown;
      return [
        {
          id: 'label',
          type: 'text',
          text: view.label,
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
        sweepHead(shown, { y: BAR_Y, height: BAR_HEIGHT, width: WIDTH }),
      ];
    },

    onEncoder(delta) {
      viewIndex = wrapIndex(viewIndex, delta, WINDOWS.length);
      // View switches always sweep — the head flash doubles as feedback that
      // the rotation registered, even when the windows' values sit close.
      retarget();
    },
  };
}
