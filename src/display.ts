/**
 * Shared display kit for BUSY Bar monitor apps: the raw draw transport, colour
 * and text helpers measured against the real firmware, and `DisplaySession` —
 * the one object through which a process should touch the display.
 *
 * `DisplaySession` serialises draws, stamps element timeouts, and scrubs
 * elements whose ids disappear between consecutive draws ("tombstoning").
 * Elements persist by id on the device, so a redraw that omits one leaves it
 * on screen; the session turns that firmware behaviour into a non-issue for
 * callers that simply stop drawing an element.
 */
import type { DisplayDrawParams } from '@busy-app/busy-lib';
import { httpBase } from './config';

export type DrawElement = DisplayDrawParams['elements'][number];

/** Panel geometry and `/api/screen` capture indices. The front bar is the
 * canvas every monitor layout is sized against. */
export const DISPLAYS = {
  front: { index: 0, width: 72, height: 16 },
  back: { index: 1, width: 160, height: 80 },
} as const;

/**
 * Posts a draw directly instead of via `bar.DisplayDraw`.
 *
 * The library's `draw()` rebuilds the body from only `application_name`,
 * `priority`, and `elements`, so `led_notification_color` is dropped before the
 * request even though it is part of the library's own `DisplayDrawParams` type
 * — the status light would never fire. Everything else about the call is
 * identical, so this just sends the body as written.
 */
export async function displayDraw(body: DisplayDrawParams): Promise<void> {
  const response = await fetch(`${httpBase()}/api/display/draw`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) {
    throw new Error(`draw failed: HTTP ${response.status} ${await response.text().catch(() => '')}`);
  }
}

/** Clears every element the application has on the display. The screen stays
 * blank until someone draws again — nothing reverts on its own. */
export async function displayClear(applicationName: string): Promise<void> {
  const response = await fetch(
    `${httpBase()}/api/display/draw?application_name=${encodeURIComponent(applicationName)}`,
    { method: 'DELETE', signal: AbortSignal.timeout(5000) }
  );
  if (!response.ok) {
    throw new Error(`clear failed: HTTP ${response.status}`);
  }
}

export const COLORS = {
  ok: '#33DD66FF',
  warn: '#FFAA00FF',
  critical: '#FF3322FF',
  track: '#202020FF',
  label: '#8899AAFF',
  stale: '#555555FF',
  reset: '#555555FF',
  refresh: '#00CCFFFF',
  /** Pace tick over the empty track — just lighter than the #202020 track. */
  pace: '#404040FF',
} as const;

/** Elements persist by id until cleared or their timeout expires — a redraw
 * that simply omits one leaves it on screen. Hiding therefore means drawing it
 * with zero alpha, not dropping it from the list. */
export const HIDDEN = (color: string) => `${color.slice(0, 7)}00`;

export function severityColor(pct: number): string {
  if (pct >= 80) return COLORS.critical;
  if (pct >= 50) return COLORS.warn;
  return COLORS.ok;
}

/** Alpha doesn't dim the LEDs (only r/g/b are read), so "darker" means scaling
 * the components themselves. Keeps the input's `#RRGGBBAA` shape, alpha FF. */
export function scaleRgb(color: string, factor: number): string {
  let out = '#';
  for (let i = 1; i < 7; i += 2) {
    out += Math.round(parseInt(color.slice(i, i + 2), 16) * factor)
      .toString(16)
      .padStart(2, '0');
  }
  return `${out}FF`;
}

/** Per-channel RGB lerp between two `#RRGGBBAA` colours: t=0 gives `a`, t=1
 * gives `b`. Alpha is pinned to FF for the same reason as scaleRgb — partial
 * alpha renders at full brightness, so it can't carry a fade. */
export function mixRgb(a: string, b: string, t: number): string {
  let out = '#';
  for (let i = 1; i < 7; i += 2) {
    const va = parseInt(a.slice(i, i + 2), 16);
    const vb = parseInt(b.slice(i, i + 2), 16);
    out += Math.round(va + (vb - va) * t)
      .toString(16)
      .padStart(2, '0');
  }
  return `${out}FF`;
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

export function textWidth(text: string): number {
  let width = 0;
  for (const ch of text) width += (SMALL_GLYPH_WIDTHS[ch] ?? 4) + 1;
  return Math.max(0, width - 1);
}

/**
 * Compact countdown for the display: the most precise variant that fits
 * `maxWidth` pixels of small font — "4:59" falling back to "4H" under a day,
 * "6D4H" falling back to "6D" above it, "59M" under an hour. Returns '' when
 * no reset is scheduled or nothing fits (a long label can leave too few
 * columns before the percentage).
 */
export function formatResetCompact(resetsAt: string | null, maxWidth: number): string {
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

/** Track + fill rectangle pair for a horizontal progress bar. The fill width
 * has a floor of 1 (zero is invalid) and is hidden by alpha at 0% rather than
 * omitted — an omitted element would leave the previous bar up. */
export function progressBar(opts: {
  pct: number;
  color: string;
  y: number;
  width: number;
  height: number;
  x?: number;
  trackColor?: string;
  idPrefix?: string;
}): DrawElement[] {
  const { pct, color, y, width, height, x = 0, trackColor = COLORS.track, idPrefix = '' } = opts;
  const fillWidth = Math.max(1, Math.round((width * pct) / 100));
  const fillColor = pct > 0 ? color : HIDDEN(color);
  const shape = { y, height, radius: 0, fill: 'solid', border_width: 0, display: 'front' } as const;
  return [
    { id: `${idPrefix}track`, type: 'rectangle', x, width, fill_colors: [trackColor], border_color: trackColor, ...shape },
    { id: `${idPrefix}fill`, type: 'rectangle', x, width: fillWidth, fill_colors: [fillColor], border_color: fillColor, ...shape },
  ];
}

/**
 * An invisible replacement for an element that should no longer be on screen.
 *
 * Redrawing an id as a *different* element type is rejected by the firmware
 * (HTTP 400 — and the 400 is not atomic: elements earlier in the request still
 * land), so a tombstone must re-emit the element it replaces: zero-alpha colour
 * fields where the type has them, and a 1-second timeout as the universal
 * fallback for types that don't (image, animation). Both verified on-device.
 */
function tombstone(el: DrawElement): DrawElement {
  const expiring = { ...el, timeout: 1, display_until: undefined };
  switch (expiring.type) {
    case 'text':
    case 'countdown':
      return { ...expiring, color: HIDDEN(expiring.color) };
    case 'rectangle':
      return {
        ...expiring,
        fill_colors: expiring.fill_colors.map(HIDDEN),
        border_color: HIDDEN(expiring.border_color),
      };
    default:
      return expiring;
  }
}

export interface DisplaySessionOptions {
  applicationName: string;
  priority: number;
  /** Stamped onto every element so the screen self-clears if the process dies. */
  timeoutS: number;
  /** Transport, injectable for tests. Defaults to the real device. */
  send?: (body: DisplayDrawParams) => Promise<void>;
}

export class DisplaySession {
  private chain: Promise<unknown> = Promise.resolve();
  /** Elements believed to be on screen from the last draw, by id. */
  private last = new Map<string, DrawElement>();
  /** Tombstones owed to the device — kept across failed draws so a vanished
   * element cannot escape scrubbing when the draw carrying it is dropped. */
  private pending = new Map<string, DrawElement>();

  constructor(private readonly options: DisplaySessionOptions) {}

  /** Draws are serialised so concurrent callers (an encoder spin during a poll
   * redraw) can't interleave requests. */
  private serialise<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work, work);
    this.chain = next.catch(() => {});
    return next;
  }

  draw(elements: DrawElement[], ledColor?: string): Promise<void> {
    return this.serialise(async () => {
      const stamped = elements.map((el) => {
        if (!el.id) throw new Error('every element needs an id — ids drive persistence and scrubbing');
        return { ...el, timeout: this.options.timeoutS, display_until: undefined };
      });
      const ids = new Set(stamped.map((el) => el.id));
      for (const [id, el] of this.last) {
        if (!ids.has(id)) this.pending.set(id, el);
      }
      for (const id of ids) this.pending.delete(id);
      this.last = new Map(stamped.map((el) => [el.id, el]));
      if (stamped.length === 0 && this.pending.size === 0) return;
      await (this.options.send ?? displayDraw)({
        application_name: this.options.applicationName,
        priority: this.options.priority,
        ...(ledColor ? { led_notification_color: ledColor } : {}),
        elements: [...stamped, ...[...this.pending.values()].map(tombstone)],
      });
      this.pending.clear();
    });
  }

  clear(): Promise<void> {
    return this.serialise(() => {
      this.last.clear();
      this.pending.clear();
      return displayClear(this.options.applicationName);
    });
  }
}
