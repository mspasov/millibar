/**
 * Reads Claude Code's local stats cache — the per-day token history behind its
 * own `/usage` Stats-tab graphs. There is no server endpoint for history (see
 * docs/USAGE-GRAPH.md): Claude Code computes it from session transcripts and
 * persists it to `<config dir>/stats-cache.json`, so that file is the source.
 *
 * The file is undocumented and version-gated (`version: 5` at time of
 * writing), so parsing is entry-wise and liberal: any dailyModelTokens entry
 * with a plausible date and numeric token counts is kept, anything else is
 * skipped — a future version bump degrades to "whatever still parses" rather
 * than to a blank screen.
 *
 * Two properties callers must design around:
 * - Days are UTC buckets (Claude Code buckets by `toISOString()`), so "today"
 *   in this module is UTC today, not local.
 * - The cache only advances when Claude Code itself recomputes it (opening
 *   its stats panel); it is routinely days stale. `newestDate` is exposed so
 *   callers can anchor and label around the gap instead of rendering the
 *   missing days as false zeroes.
 */
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface DayTokens {
  /** UTC day, `YYYY-MM-DD`. */
  date: string;
  /** Total tokens per model id (input + output + both cache kinds — Claude
   * Code's own formula, so numbers match its chart). */
  tokensByModel: Record<string, number>;
  /** Sum across models, precomputed once at parse. */
  total: number;
}

export interface StatsHistory {
  /** Ascending by date, deduplicated. Never empty (the load returns null
   * instead — a history with nothing renderable is simply no history). */
  days: DayTokens[];
  /** When Claude Code last rewrote the cache (file mtime) — cheap change
   * detection for pollers. */
  modifiedAtMs: number;
}

/** Same resolution as the credentials lookup in src/usage.ts, so both Claude
 * artefacts follow CLAUDE_CONFIG_DIR together. */
export function statsCachePath(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
  return join(dir, 'stats-cache.json');
}

const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

/** Entry-wise extraction of `dailyModelTokens`. Exported for tests. */
export function parseStatsHistory(raw: unknown): DayTokens[] {
  const entries = (raw as { dailyModelTokens?: unknown } | null)?.dailyModelTokens;
  if (!Array.isArray(entries)) return [];

  const byDate = new Map<string, DayTokens>();
  for (const entry of entries) {
    const { date, tokensByModel } = (entry ?? {}) as Record<string, unknown>;
    if (typeof date !== 'string' || !DATE_SHAPE.test(date)) continue;
    if (!tokensByModel || typeof tokensByModel !== 'object') continue;
    const models: Record<string, number> = {};
    let total = 0;
    for (const [model, tokens] of Object.entries(tokensByModel)) {
      if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens < 0) continue;
      models[model] = tokens;
      total += tokens;
    }
    // Last write wins on a duplicate date — not observed in real caches, but a
    // map keeps it well-defined either way.
    byDate.set(date, { date, tokensByModel: models, total });
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/** Null when the file is absent, unreadable, corrupt, or holds no days. */
export function loadStatsHistory(path = statsCachePath()): StatsHistory | null {
  let raw: unknown;
  let modifiedAtMs: number;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
    modifiedAtMs = statSync(path).mtimeMs;
  } catch {
    return null;
  }
  const days = parseStatsHistory(raw);
  if (days.length === 0) return null;
  return { days, modifiedAtMs };
}

/** UTC today as a cache-shaped date string — the calendar the cache's day
 * buckets live in. */
export function utcToday(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` (both `YYYY-MM-DD`); negative if reversed. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
}

if (import.meta.main) {
  const history = loadStatsHistory();
  if (!history) {
    console.error(`no readable history at ${statsCachePath()}`);
    process.exit(1);
  }
  console.log(JSON.stringify(history.days.slice(-14), null, 2));
}
