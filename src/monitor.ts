/**
 * Shows Claude Code usage limits on the BUSY Bar front display.
 *
 * Rotating the device's encoder cycles through the available limit windows
 * (5-hour, 7-day, and any per-model weekly windows such as Fable). Pressing any
 * button refreshes the data immediately instead of waiting for the next poll.
 *
 * Layout (72x16): window label on the left, reset countdown in dark grey and
 * percentage on the right, and a progress bar along the bottom. Colour tracks
 * severity.
 *
 * Usage: bun run src/monitor.ts
 * Env:   BUSY_BAR_ADDR, BUSY_PRIORITY, POLL_INTERVAL_MS, REFRESH_COOLDOWN_MS
 */
import { BusyBar, type DisplayDrawParams } from '@busy-app/busy-lib';
import { listenInput } from './input';
import { pulseLed } from './led';
import { fetchUsage, NoCredentialsError, RateLimitError, type Usage, type UsageWindow } from './usage';

const APP_NAME = 'claude_usage';
const WIDTH = 72;
const BAR_Y = 12;
const BAR_HEIGHT = 3;

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 5 * 60 * 1000);
const PRIORITY = Number(process.env.BUSY_PRIORITY ?? 50);
/** Floor between API fetches, so holding a button can't hammer the endpoint
 * into a 429. */
const REFRESH_COOLDOWN_MS = Number(process.env.REFRESH_COOLDOWN_MS ?? 5000);
/** Outlive one poll so a slow fetch doesn't blank the display, but self-clear
 * within ~2 polls if this process dies. */
const DRAW_TIMEOUT_S = Math.ceil((POLL_INTERVAL_MS * 1.5) / 1000);

const ADDR = process.env.BUSY_BAR_ADDR ?? '10.0.4.20';
const BASE_URL = ADDR.startsWith('http') ? ADDR : `http://${ADDR}`;

const bar = new BusyBar({ addr: ADDR });

/**
 * Posts a draw directly instead of via `bar.DisplayDraw`.
 *
 * The library's `draw()` rebuilds the body from only `application_name`,
 * `priority`, and `elements`, so `led_notification_color` is dropped before the
 * request even though it is part of the library's own `DisplayDrawParams` type
 * — the status light would never fire. Everything else about the call is
 * identical, so this just sends the body as written.
 */
async function displayDraw(body: DisplayDrawParams): Promise<void> {
  const response = await fetch(`${BASE_URL}/api/display/draw`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) {
    throw new Error(`draw failed: HTTP ${response.status} ${await response.text().catch(() => '')}`);
  }
}

const COLORS = {
  ok: '#33DD66FF',
  warn: '#FFAA00FF',
  critical: '#FF3322FF',
  track: '#202020FF',
  label: '#8899AAFF',
  stale: '#555555FF',
  reset: '#555555FF',
  refresh: '#00CCFFFF',
} as const;

/** Elements persist by id until cleared or their timeout expires — a redraw
 * that simply omits one leaves it on screen. Hiding therefore means drawing it
 * with zero alpha, not dropping it from the list. */
const HIDDEN = (color: string) => `${color.slice(0, 7)}00`;

const LABEL_X = 2;
/** `mid_right` renders its last inked column 2px left of the anchor (measured,
 * both fonts), so anchoring at 43 puts the countdown's right edge at column 41
 * — two clear columns before the widest percentage ("100%" starts at 44). */
const RESET_ANCHOR_X = 43;
const RESET_RIGHT_EDGE = RESET_ANCHOR_X - 2;
/** Minimum dark columns between the label and the reset countdown. */
const RESET_GAP = 2;

/** Activity dots, swapped in (by alpha) for the reset countdown while
 * fetching — right-aligned on the same column so they clear the label too. */
const DOT_XS = [RESET_RIGHT_EDGE - 9, RESET_RIGHT_EDGE - 5, RESET_RIGHT_EDGE - 1];
const DOT_Y = 4;
const DOT_SIZE = 2;
/** Floor on how long the dots stay up, so a fast fetch still registers visually. */
const MIN_INDICATOR_MS = 300;

interface View {
  label: string;
  window: UsageWindow;
}

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
  return hours >= 24
    ? `resets in ${Math.floor(hours / 24)}d ${hours % 24}h`
    : `resets in ${hours}h ${minutes}m`;
}

/** Per-glyph ink widths of the small font, measured from `/api/screen`
 * readbacks (firmware 1.1.1) — see DEVICE.md. Glyphs are spaced 1px apart;
 * characters not listed use the common 4px, an overestimate for anything
 * unmeasured, which errs toward shortening the countdown rather than letting
 * text collide. */
const SMALL_GLYPH_WIDTHS: Record<string, number> = {
  I: 1, J: 3, L: 3, M: 5, T: 3, V: 3, W: 5, X: 3, Y: 3, Z: 3,
  '0': 3, '1': 2, '2': 3, '3': 3, '4': 3, '5': 3, '6': 3, '7': 3, '8': 3, '9': 3,
  '?': 3, ':': 1, '.': 1,
};

function textWidth(text: string): number {
  let width = 0;
  for (const ch of text) width += (SMALL_GLYPH_WIDTHS[ch] ?? 4) + 1;
  return Math.max(0, width - 1);
}

/**
 * Compact countdown for the display: the most precise variant that fits
 * `maxWidth` pixels of small font — "4:59" falling back to "4H" under a day,
 * "6D4H" falling back to "6D" above it, "59M" under an hour. Returns '' when
 * no reset is scheduled or nothing fits (a long model label can leave too few
 * columns before the percentage).
 */
function formatResetCompact(resetsAt: string | null, maxWidth: number): string {
  if (!resetsAt) return '';
  const ms = new Date(resetsAt).getTime() - Date.now();
  if (!Number.isFinite(ms)) return '';
  const totalMinutes = Math.max(0, Math.ceil(ms / 60_000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const candidates =
    days > 0
      ? [hours > 0 ? `${days}D${hours}H` : `${days}D`, `${days}D`]
      : hours > 0
        ? [`${hours}:${String(minutes).padStart(2, '0')}`, `${hours}H`]
        : [`${minutes}M`];
  return candidates.find((c) => textWidth(c) <= maxWidth) ?? '';
}

/** The windows available to cycle through, in a stable order. Per-model windows
 * come and go as the API adds or drops them, so this is rebuilt on every poll. */
function buildViews(usage: Usage): View[] {
  const views: View[] = [];
  if (usage.fiveHour) views.push({ label: '5H', window: usage.fiveHour });
  if (usage.sevenDay) views.push({ label: '7D', window: usage.sevenDay });
  for (const model of usage.models) {
    // Fonts are bitmap ASCII; uppercase keeps the label visually consistent.
    views.push({ label: model.model.toUpperCase(), window: model });
  }
  return views;
}

/** Draws are serialised so an encoder spin can't interleave with a poll redraw. */
let drawChain: Promise<unknown> = Promise.resolve();
function serialise<T>(work: () => Promise<T>): Promise<T> {
  const next = drawChain.then(work, work);
  drawChain = next.catch(() => {});
  return next;
}

async function render(view: View, stale: boolean, refreshing: boolean): Promise<void> {
  const pct = Math.max(0, Math.min(100, view.window.utilization));
  const color = stale ? COLORS.stale : severityColor(pct);
  // Width has a floor of 1 (zero is invalid) and is hidden by alpha at 0%,
  // rather than omitted — an omitted element would leave the previous bar up.
  const fillWidth = Math.max(1, Math.round((WIDTH * pct) / 100));
  const fillColor = pct > 0 ? color : HIDDEN(color);
  const dotColor = refreshing ? COLORS.refresh : HIDDEN(COLORS.refresh);
  const labelText = stale ? `${view.label}?` : view.label;
  const labelEnd = LABEL_X + textWidth(labelText) - 1;
  const resetText = formatResetCompact(view.window.resetsAt, RESET_RIGHT_EDGE - labelEnd - RESET_GAP);
  // Hidden while the refresh dots occupy its spot, and when nothing fits.
  const resetColor = resetText && !refreshing ? COLORS.reset : HIDDEN(COLORS.reset);

  await serialise(() =>
    displayDraw({
      application_name: APP_NAME,
      priority: PRIORITY,
      // No led_notification_color here: the status light is driven separately
      // by pulseLed(), and a draw that omits the field leaves the light alone.
      elements: [
        {
          id: 'label',
          type: 'text',
          text: labelText,
          font: 'small',
          color: stale ? COLORS.stale : COLORS.label,
          align: 'mid_left',
          x: LABEL_X,
          y: 5,
          timeout: DRAW_TIMEOUT_S,
          display: 'front',
        },
        {
          id: 'reset',
          type: 'text',
          // Kept non-empty even when hidden: the element persists by id, and a
          // redraw carrying the previous text under zero alpha renders nothing.
          text: resetText || '0',
          font: 'small',
          color: resetColor,
          align: 'mid_right',
          x: RESET_ANCHOR_X,
          y: 5,
          timeout: DRAW_TIMEOUT_S,
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
        {
          id: 'fill',
          type: 'rectangle',
          x: 0,
          y: BAR_Y,
          width: fillWidth,
          height: BAR_HEIGHT,
          radius: 0,
          fill: 'solid',
          fill_colors: [fillColor],
          border_width: 0,
          border_color: fillColor,
          timeout: DRAW_TIMEOUT_S,
          display: 'front',
        },
        ...DOT_XS.map((x, i) => ({
          id: `dot${i}`,
          type: 'rectangle' as const,
          x,
          y: DOT_Y,
          width: DOT_SIZE,
          height: DOT_SIZE,
          radius: 0,
          fill: 'solid' as const,
          fill_colors: [dotColor],
          border_width: 0,
          border_color: dotColor,
          timeout: DRAW_TIMEOUT_S,
          display: 'front' as const,
        })),
      ],
    })
  );
}

let views: View[] = [];
let viewIndex = 0;
let stale = false;
let refreshing = false;

function currentView(): View | null {
  return views[viewIndex] ?? null;
}

async function redraw(): Promise<void> {
  const view = currentView();
  if (view) {
    await render(view, stale, refreshing).catch((e) => console.error((e as Error).message));
  }
}

/** Earliest time the API may be hit again — advanced by a successful fetch and,
 * further, by a 429's Retry-After so a button press cannot bypass the back-off. */
let nextFetchAllowedAt = 0;
/** Set only while the poll loop is sleeping; calling it starts the next fetch
 * early. Null means a fetch is already in flight. */
let wakePoll: (() => void) | null = null;

function sleepUntilDueOrWoken(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      wakePoll = null;
      resolve();
    };
    const timer = setTimeout(finish, ms);
    wakePoll = finish;
  });
}

function requestRefresh(reason: string): void {
  const waitMs = nextFetchAllowedAt - Date.now();
  if (waitMs > 0) {
    // Skip the API call, but still repaint: the press may well be someone
    // reacting to a blank screen (BACK dismissed the canvas, or another app
    // drew over it), and doing nothing for minutes looks broken.
    console.log(`  ${reason}: cooldown ${Math.ceil(waitMs / 1000)}s, repainting without fetching`);
    void redraw();
    return;
  }
  if (!wakePoll) return; // already fetching
  console.log(`  ${reason}: refreshing`);
  wakePoll();
}

/** Clear the activity dots, keeping them up for at least MIN_INDICATOR_MS so a
 * sub-second fetch doesn't flash by unseen. */
async function endRefreshIndicator(startedAt: number): Promise<void> {
  const elapsed = Date.now() - startedAt;
  if (elapsed < MIN_INDICATOR_MS) await Bun.sleep(MIN_INDICATOR_MS - elapsed);
  refreshing = false;
}

async function poll(): Promise<number> {
  const startedAt = Date.now();
  refreshing = true;
  // Fire-and-forget: the fade outlasts a typical fetch and must not delay it.
  void pulseLed({ color: COLORS.refresh, signal: controller.signal });
  await redraw(); // no-op before the first successful fetch, when there is no view yet

  try {
    const usage = await fetchUsage();
    nextFetchAllowedAt = Date.now() + REFRESH_COOLDOWN_MS;
    const previousLabel = currentView()?.label;
    views = buildViews(usage);
    // Keep showing the same window across refreshes even if the list changed.
    const sameView = views.findIndex((v) => v.label === previousLabel);
    viewIndex = sameView >= 0 ? sameView : Math.min(viewIndex, Math.max(views.length - 1, 0));
    stale = false;

    const summary = views.map((v) => `${v.label} ${v.window.utilization}%`).join(' | ');
    const reset = currentView()?.window.resetsAt ?? null;
    console.log(`[${new Date().toLocaleTimeString()}] ${summary} (${currentView()?.label}: ${formatReset(reset)})`);

    await endRefreshIndicator(startedAt);
    await redraw();
    return POLL_INTERVAL_MS;
  } catch (error) {
    if (error instanceof NoCredentialsError) throw error;

    // Keep the last known values on screen, dimmed, rather than blanking.
    console.error(`[${new Date().toLocaleTimeString()}] ${(error as Error).message}`);
    stale = true;
    await endRefreshIndicator(startedAt);
    await redraw();

    const waitMs =
      error instanceof RateLimitError
        ? Math.max(error.retryAfterSeconds * 1000, POLL_INTERVAL_MS)
        : POLL_INTERVAL_MS;
    // Hold button-triggered refreshes off for the whole back-off, not just the
    // usual cooldown, so a 429 isn't immediately provoked again.
    nextFetchAllowedAt = Date.now() + (error instanceof RateLimitError ? waitMs : REFRESH_COOLDOWN_MS);
    return waitMs;
  }
}

const controller = new AbortController();

async function pollLoop(): Promise<void> {
  while (!controller.signal.aborted) {
    const waitMs = await poll();
    if (controller.signal.aborted) break;
    await sleepUntilDueOrWoken(waitMs);
  }
}

async function inputLoop(): Promise<void> {
  await listenInput(
    (event) => {
      if (event.type === 'button') {
        // RELEASE would fire a second time for the same press.
        if (event.action === 'PRESS') requestRefresh(`${event.button} pressed`);
        return;
      }
      if (event.type !== 'encoder' || event.delta === 0 || views.length < 2) return;
      // Encoder deltas can exceed 1 on a fast spin; wrap in both directions.
      viewIndex = (((viewIndex + event.delta) % views.length) + views.length) % views.length;
      const view = currentView();
      if (view) {
        console.log(`  -> ${view.label} ${view.window.utilization}% (${formatReset(view.window.resetsAt)})`);
      }
      void redraw();
    },
    { signal: controller.signal, onError: (e) => console.error(e.message) }
  );
}

/** The reset countdown repaints once a minute between polls — a draw to the
 * device only, never a usage fetch — so "4:59" doesn't sit frozen for five
 * minutes. Skipped mid-refresh; the fetch path redraws on its own. */
const countdownTick = setInterval(() => {
  if (!refreshing) void redraw();
}, 60_000);
controller.signal.addEventListener('abort', () => clearInterval(countdownTick));

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    controller.abort();
    void serialise(() => bar.DisplayClear({ application_name: APP_NAME }))
      .catch(() => {})
      .finally(() => process.exit(0));
  });
}

console.log(
  `Monitoring Claude Code usage on ${process.env.BUSY_BAR_ADDR ?? '10.0.4.20'} ` +
    `every ${Math.round(POLL_INTERVAL_MS / 1000)}s — rotate the encoder to cycle windows, ` +
    'press any button to refresh (Ctrl-C to stop and clear)'
);

await Promise.all([pollLoop(), inputLoop()]);
