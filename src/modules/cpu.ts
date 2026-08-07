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
 */
import os from 'node:os';
import { COLORS, progressBar, severityColor, type DrawElement } from '../display';
import { wrapIndex, type MonitorModule, type PollResult } from '../module';

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

export function cpuModule(): MonitorModule {
  const cores = os.cpus().length;
  let viewIndex = 0;
  let loads: number[] = [0, 0, 0];

  return {
    id: 'cpu',
    title: 'CPU load',

    async poll(): Promise<PollResult> {
      loads = os.loadavg();
      // Local sampling cannot fail or be rate-limited: no refresh hold at all.
      return { nextPollMs: POLL_MS, holdRefreshMs: 0 };
    },

    render(): DrawElement[] {
      const view = WINDOWS[viewIndex]!;
      const load = loads[view.index] ?? 0;
      const pct = Math.min(100, Math.round((load / cores) * 100));
      const color = severityColor(pct);
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
          text: `${pct}%`,
          font: 'normal',
          color,
          align: 'mid_right',
          x: WIDTH - 2,
          y: 5,
          display: 'front',
        },
        ...progressBar({ pct, color, y: BAR_Y, width: WIDTH, height: BAR_HEIGHT }),
      ];
    },

    onEncoder(delta) {
      viewIndex = wrapIndex(viewIndex, delta, WINDOWS.length);
    },
  };
}
