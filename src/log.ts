/**
 * Timestamped, scoped logging for the long-running monitor.
 *
 * Every line is `HH:MM:SS [scope] message` — routine lines to stdout,
 * failures to stderr. Scopes name the subsystem ('draw', 'input', 'led',
 * 'host', or a module id), because a bare "fetch failed" hours later doesn't
 * say whether the display, the input socket, or a data source broke.
 *
 * `logError` coalesces repeats: the input stream reconnects every 2 s while
 * the device is unreachable and the heartbeat repaint fails once a minute, so
 * verbatim logging turns an overnight outage into thousands of identical
 * lines. The first failure logs immediately; identical repeats are counted
 * and surface as a "still failing" summary once per window. A quiet gap
 * longer than the window starts a fresh incident, so state never needs to be
 * reset for the next outage to log immediately.
 */

const REPEAT_WINDOW_MS = 10 * 60_000;

interface Incident {
  message: string;
  count: number;
  firstAt: number;
  lastAt: number;
  lastEmittedAt: number;
}

const incidents = new Map<string, Incident>();

/** Local wall-clock `HH:MM:SS`. */
export function clockTime(epochMs: number = Date.now()): string {
  const d = new Date(epochMs);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Rough human duration: "45s", "14m", "2h 05m". */
export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
}

export function log(scope: string, message: string): void {
  console.log(`${clockTime()} [${scope}] ${message}`);
}

export function logError(scope: string, message: string): void {
  const now = Date.now();
  const incident = incidents.get(scope);
  const isRepeat =
    incident && incident.message === message && now - incident.lastAt <= REPEAT_WINDOW_MS;
  if (!isRepeat) {
    incidents.set(scope, { message, count: 1, firstAt: now, lastAt: now, lastEmittedAt: now });
    console.error(`${clockTime(now)} [${scope}] ${message}`);
    return;
  }
  incident.count += 1;
  incident.lastAt = now;
  if (now - incident.lastEmittedAt >= REPEAT_WINDOW_MS) {
    incident.lastEmittedAt = now;
    console.error(
      `${clockTime(now)} [${scope}] still failing (${incident.count}x since ${clockTime(incident.firstAt)}): ${message}`
    );
  }
}

/**
 * Mark a scope healthy again. Ends the open incident and, when repeats were
 * being coalesced, logs the one recovery line that says the outage is over —
 * without it, a suppressed failure stream just goes silent. A single blip
 * stays a single line: its recovery is implied by the errors stopping.
 */
export function logResolved(scope: string): void {
  const incident = incidents.get(scope);
  if (!incident) return;
  incidents.delete(scope);
  if (incident.count > 1) {
    log(scope, `recovered after ${incident.count} failures (first at ${clockTime(incident.firstAt)})`);
  }
}
