/**
 * Shows the Claude Code 5-hour usage limit on the BUSY Bar front display.
 *
 * Layout (72x16): "5H" label on the left, percentage on the right, and a
 * progress bar along the bottom. Colour tracks severity.
 *
 * Usage: bun run src/monitor.ts
 * Env:   BUSY_BAR_ADDR, BUSY_PRIORITY, POLL_INTERVAL_MS
 */
import { BusyBar } from '@busy-app/busy-lib';
import { fetchUsage, NoCredentialsError, RateLimitError, type Usage } from './usage';

const APP_NAME = 'claude_usage';
const WIDTH = 72;
const BAR_Y = 12;
const BAR_HEIGHT = 3;

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 5 * 60 * 1000);
const PRIORITY = Number(process.env.BUSY_PRIORITY ?? 50);
/** Outlive one poll so a slow fetch doesn't blank the display, but self-clear
 * within ~2 polls if this process dies. */
const DRAW_TIMEOUT_S = Math.ceil((POLL_INTERVAL_MS * 1.5) / 1000);

const bar = new BusyBar({ addr: process.env.BUSY_BAR_ADDR ?? '10.0.4.20' });

const COLORS = {
  ok: '#33DD66FF',
  warn: '#FFAA00FF',
  critical: '#FF3322FF',
  track: '#202020FF',
  label: '#8899AAFF',
  stale: '#555555FF',
} as const;

function severityColor(pct: number): string {
  if (pct >= 80) return COLORS.critical;
  if (pct >= 50) return COLORS.warn;
  return COLORS.ok;
}

function formatReset(resetsAt: string | null): string {
  if (!resetsAt) return 'no reset scheduled';
  const ms = new Date(resetsAt).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return 'resetting now';
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.round((ms % 3_600_000) / 60_000);
  return `resets in ${hours}h ${minutes}m`;
}

async function render(pct: number, stale: boolean): Promise<void> {
  const clamped = Math.max(0, Math.min(100, pct));
  const color = stale ? COLORS.stale : severityColor(clamped);
  const fillWidth = Math.round((WIDTH * clamped) / 100);

  await bar.DisplayDraw({
    application_name: APP_NAME,
    priority: PRIORITY,
    elements: [
      {
        id: 'label',
        type: 'text',
        text: stale ? '5H?' : '5H',
        font: 'small',
        color: stale ? COLORS.stale : COLORS.label,
        align: 'mid_left',
        x: 2,
        y: 5,
        timeout: DRAW_TIMEOUT_S,
        display: 'front',
      },
      {
        id: 'pct',
        type: 'text',
        text: `${Math.round(clamped)}%`,
        font: 'normal',
        color,
        align: 'mid_right',
        x: WIDTH - 2,
        y: 5,
        timeout: DRAW_TIMEOUT_S,
        display: 'front',
      },
      {
        id: 'track',
        type: 'rectangle',
        x: 0,
        y: BAR_Y,
        width: WIDTH,
        height: BAR_HEIGHT,
        radius: 0,
        fill: 'solid',
        fill_colors: [COLORS.track],
        border_width: 0,
        border_color: COLORS.track,
        timeout: DRAW_TIMEOUT_S,
        display: 'front',
      },
      // A zero-width rectangle is invalid, so the fill is omitted entirely at 0%.
      ...(fillWidth > 0
        ? [
            {
              id: 'fill',
              type: 'rectangle' as const,
              x: 0,
              y: BAR_Y,
              width: fillWidth,
              height: BAR_HEIGHT,
              radius: 0,
              fill: 'solid' as const,
              fill_colors: [color],
              border_width: 0,
              border_color: color,
              timeout: DRAW_TIMEOUT_S,
              display: 'front' as const,
            },
          ]
        : []),
    ],
  });
}

function describe(usage: Usage): string {
  const parts = [`5h ${usage.fiveHour?.utilization ?? 0}% (${formatReset(usage.fiveHour?.resetsAt ?? null)})`];
  if (usage.sevenDay) parts.push(`7d ${usage.sevenDay.utilization}%`);
  for (const model of usage.models) parts.push(`${model.model} ${model.utilization}%`);
  return parts.join(' | ');
}

let lastKnownPct: number | null = null;
let running = true;

async function poll(): Promise<number> {
  try {
    const usage = await fetchUsage();
    const pct = usage.fiveHour?.utilization ?? 0;
    lastKnownPct = pct;
    console.log(`[${new Date().toLocaleTimeString()}] ${describe(usage)}`);
    await render(pct, false);
    return POLL_INTERVAL_MS;
  } catch (error) {
    if (error instanceof NoCredentialsError) throw error;

    // Keep the last known value on screen, dimmed, rather than blanking it.
    console.error(`[${new Date().toLocaleTimeString()}] ${(error as Error).message}`);
    if (lastKnownPct !== null) {
      await render(lastKnownPct, true).catch(() => {});
    }
    return error instanceof RateLimitError
      ? Math.max(error.retryAfterSeconds * 1000, POLL_INTERVAL_MS)
      : POLL_INTERVAL_MS;
  }
}

async function clearDisplay(): Promise<void> {
  await bar.DisplayClear({ application_name: APP_NAME }).catch(() => {});
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    running = false;
    void clearDisplay().then(() => process.exit(0));
  });
}

console.log(
  `Monitoring Claude Code 5h limit on ${process.env.BUSY_BAR_ADDR ?? '10.0.4.20'} ` +
    `every ${Math.round(POLL_INTERVAL_MS / 1000)}s (Ctrl-C to stop and clear)`
);

while (running) {
  const waitMs = await poll();
  if (!running) break;
  await Bun.sleep(waitMs);
}
