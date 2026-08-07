/**
 * The percentage-change animation shared by the monitor modules: the value
 * sweeps to its new position with ease-out cubic, the severity colour lerps
 * instead of band-flipping, and a white-hot 1px leading edge rides the bar's
 * fill edge, cooling to the fill colour once the sweep lands. Prototyped and
 * measured with tools/sweep.ts.
 *
 * The tween is time-based, not step-based: `current()` computes the eased
 * position from the wall clock, so however fast the device actually draws,
 * the animation lands on schedule and merely drops frames under backpressure
 * (DisplaySession serialises draws). `onFrame` is the repaint driver —
 * a module's `ctx.requestRender`, which the host no-ops while the module is
 * hidden — ticking from `to()` until the head has cooled.
 */
import { HIDDEN, mixRgb, type DrawElement } from './display';

/** Sweep length. Ease-out covers most of the distance early, so the tail end
 * reads as settling rather than dragging. */
const SWEEP_MS = 500;
/** Settle: the head cools from white-hot to the fill colour, then hides. */
const COOL_MS = 160;
/** Repaint cadence while animating — an upper bound; the device's draw
 * latency is the real ceiling. */
const TICK_MS = 33;
/** How far the leading edge is blended toward white. */
const HEAD_WHITE = 0.75;
const WHITE = '#FFFFFFFF';

export interface SweepFrame {
  /** Fractional mid-sweep: round for text, scale for bar widths. */
  pct: number;
  color: string;
  /** Leading-edge colour; null once settled. */
  headColor: string | null;
}

export interface PctSweepOptions {
  /** 0 disables animation entirely — to() behaves as set(). */
  durationMs?: number;
  coolMs?: number;
  tickMs?: number;
  /** Repaint driver, called every tick from to() until settled. */
  onFrame?: () => void;
  /** Injectable clock for tests. */
  now?: () => number;
}

export class PctSweep {
  private readonly durationMs: number;
  private readonly coolMs: number;
  private readonly tickMs: number;
  private readonly onFrame?: () => void;
  private readonly now: () => number;

  private fromPct = 0;
  private fromColor = '#000000FF';
  private toPct = 0;
  private toColor = '#000000FF';
  /** null = nothing animating or cooling; current() just reports the target. */
  private startedAt: number | null = null;
  private ticker: ReturnType<typeof setInterval> | null = null;

  constructor(options: PctSweepOptions = {}) {
    this.durationMs = options.durationMs ?? SWEEP_MS;
    this.coolMs = options.coolMs ?? COOL_MS;
    this.tickMs = options.tickMs ?? TICK_MS;
    this.onFrame = options.onFrame;
    this.now = options.now ?? Date.now;
  }

  /** Jump without animating — first data, or deltas too small to sweep. */
  set(pct: number, color: string): void {
    this.stop();
    this.startedAt = null;
    this.toPct = pct;
    this.toColor = color;
  }

  /** Animate from whatever is showing now to the target. A retarget mid-
   * sweep starts from the current eased position; re-sending the current
   * target is a no-op, so a poll that returns an unchanged value cannot
   * restart the head flash. */
  to(pct: number, color: string): void {
    if (pct === this.toPct && color === this.toColor) return;
    if (this.durationMs <= 0) {
      this.set(pct, color);
      return;
    }
    const shown = this.current();
    this.fromPct = shown.pct;
    this.fromColor = shown.color;
    this.toPct = pct;
    this.toColor = color;
    this.startedAt = this.now();
    this.startTicker();
  }

  current(): SweepFrame {
    if (this.startedAt === null) return { pct: this.toPct, color: this.toColor, headColor: null };
    const elapsed = this.now() - this.startedAt;
    if (elapsed >= this.durationMs) {
      const coolT = (elapsed - this.durationMs) / this.coolMs;
      // coolT is NaN when coolMs is 0 and the sweep just ended; !(NaN < 1)
      // correctly skips the cooling frame.
      const headColor =
        coolT < 1 ? mixRgb(mixRgb(this.toColor, WHITE, HEAD_WHITE), this.toColor, coolT) : null;
      return { pct: this.toPct, color: this.toColor, headColor };
    }
    const eased = 1 - (1 - elapsed / this.durationMs) ** 3;
    const pct = this.fromPct + (this.toPct - this.fromPct) * eased;
    const color = mixRgb(this.fromColor, this.toColor, eased);
    return { pct, color, headColor: mixRgb(color, WHITE, HEAD_WHITE) };
  }

  /** Stops the repaint ticker (module shutdown); state is left as-is. */
  stop(): void {
    if (this.ticker) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
  }

  private startTicker(): void {
    if (!this.onFrame) return;
    this.stop();
    this.ticker = setInterval(() => {
      // Repaint first: the tick at/after settle renders the hidden head.
      this.onFrame!();
      if (this.startedAt === null || this.now() - this.startedAt >= this.durationMs + this.coolMs) {
        this.stop();
      }
    }, this.tickMs);
  }
}

/** The leading-edge element, pinned to the fill's last column. Always emitted
 * (hidden by alpha once settled) so the id persists instead of tombstoning
 * between animations. Draw it after the bar — and after anything else that
 * shares the bar's rows — so a passing head reads on top. */
export function sweepHead(
  frame: SweepFrame,
  opts: { y: number; height: number; width: number }
): DrawElement {
  const fillWidth = Math.max(1, Math.round((opts.width * frame.pct) / 100));
  const color = frame.headColor && frame.pct > 0 ? frame.headColor : HIDDEN(WHITE);
  return {
    id: 'head',
    type: 'rectangle',
    x: fillWidth - 1,
    y: opts.y,
    width: 1,
    height: opts.height,
    radius: 0,
    fill: 'solid',
    fill_colors: [color],
    border_width: 0,
    border_color: color,
    display: 'front',
  };
}
