/**
 * Runs a set of monitor modules against one BUSY Bar: one display session,
 * one input stream, one status-light owner, one process.
 *
 * Interaction: pressing the dial (a button event — there is no dedicated
 * encoder-press; see DEVICE.md) cycles to the next module, START refreshes
 * the active module, rotating the encoder is forwarded to the active module,
 * and every button press ends in a repaint so a screen blanked by BACK (or
 * overdrawn by another app) is always recoverable.
 */
import { envNumber } from './config';
import { describeConnection, resolveConnection } from './connection';
import { DisplaySession } from './display';
import { listenInput, type Button, type InputEvent } from './input';
import { pulseLed, type PulseShape } from './led';
import { log, logError, logResolved } from './log';
import { ModuleRunner, wrapIndex, type MonitorModule } from './module';

const BUTTONS: readonly Button[] = ['OK', 'BACK', 'START'];

/** Domain errors (NoCredentialsError, …) set a custom `name` and carry their
 * advice in the message; an error still wearing a built-in name is a bug,
 * where the stack is the part worth keeping. */
const BUILTIN_ERROR_NAMES = new Set(['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError']);

export interface HostOptions {
  /** Kept as the historical 'claude_usage' by default: the device rejects
   * same-priority draws from a different application_name while another app
   * holds the display, so renaming mid-flight risks losing the screen. */
  applicationName?: string;
  priority?: number;
  /** Cadence of the keep-fresh repaint (countdowns, pace ticks) — also the
   * base of the element timeout, so the screen self-clears within
   * ~1.5 heartbeats if the process dies. */
  heartbeatMs?: number;
  /** Which button the dial press reports as. */
  switchButton?: Button;
}

function envSwitchButton(): Button | undefined {
  const value = process.env.SWITCH_BUTTON;
  if (!value) return undefined;
  const button = value.toUpperCase() as Button;
  if (!BUTTONS.includes(button)) {
    throw new Error(`SWITCH_BUTTON must be one of ${BUTTONS.join(', ')}, got '${value}'`);
  }
  return button;
}

export async function runHost(modules: MonitorModule[], options: HostOptions = {}): Promise<void> {
  if (modules.length === 0) throw new Error('runHost needs at least one module');
  const applicationName = options.applicationName ?? 'claude_usage';
  const priority = options.priority ?? envNumber('BUSY_PRIORITY', 50, 1);
  const heartbeatMs = options.heartbeatMs ?? 60_000;
  const switchButton = options.switchButton ?? envSwitchButton() ?? 'OK';

  const controller = new AbortController();
  const session = new DisplaySession({
    applicationName,
    priority,
    timeoutS: Math.ceil((heartbeatMs * 1.5) / 1000),
  });

  let activeIndex = 0;
  const active = () => runners[activeIndex]!;

  function repaint(): void {
    const runner = active();
    const module = runner.module;
    const elements = module
      .render({ refreshing: runner.refreshing })
      .map((el) => ({ ...el, id: `${module.id}.${el.id}` }));
    void session.draw(elements).then(
      // A success closes any open draw incident — during a device outage the
      // heartbeat fails once a minute, and the recovery line is the only
      // signal that the display is back.
      () => logResolved('draw'),
      (e) => logError('draw', (e as Error).message)
    );
  }

  const runners = modules.map(
    (module) =>
      new ModuleRunner(
        module,
        () => {
          if (active().module === module) repaint();
        },
        (message) => log(module.id, message)
      )
  );

  /** One LED pulse at a time: the red failure blink can arrive while the cyan
   * fetch pulse is still fading, and interleaving their frames would flicker
   * both colours. Abort the running pulse and chain the new one behind its
   * cleanup, so the old run's final black frame cannot land mid-blink. */
  let ledAbort: AbortController | null = null;
  let ledChain = Promise.resolve();
  function pulseStatusLight(color: string, shape?: PulseShape, stillWanted: () => boolean = () => true): void {
    ledAbort?.abort();
    const abort = new AbortController();
    ledAbort = abort;
    const signal = AbortSignal.any([abort.signal, controller.signal]);
    // Fire-and-forget: the fade outlasts a typical fetch and must not delay it.
    // `stillWanted` re-runs when the chain drains — a module switched away
    // while the previous pulse wound down must not start its pulse late.
    ledChain = ledChain
      .then(() => {
        if (signal.aborted || !stillWanted()) return;
        return pulseLed({ color, ...shape, applicationName, priority, signal });
      })
      // Load-bearing: an uncaught rejection would skip every later pulse. Log
      // instead of swallowing — the light is otherwise unobservable, so this
      // is the only trace of a pulse that never ran (e.g. a bad colour).
      .catch((e) => logError('led', (e as Error).message));
  }

  // A dead device at startup is not fatal: every draw and the input stream
  // re-resolve on their own, so the monitor comes up and waits for it.
  const conn = await resolveConnection().catch((error) => {
    logError('host', (error as Error).message);
    return undefined;
  });

  // Before init: modules may log from init (e.g. the cached-usage seed), and
  // the banner is the session-start marker those lines should follow.
  log(
    'host',
    `millibar: ${modules.map((m) => m.title).join(', ')} via ${conn ? describeConnection(conn) : 'no reachable route yet — still probing'} — ` +
      `press ${switchButton} (the dial) for the next module, START to refresh, ` +
      'rotate the encoder to cycle views (Ctrl-C to stop and clear)'
  );

  modules.forEach((module, index) => {
    module.init?.({
      applicationName,
      requestRender: () => {
        if (activeIndex === index) repaint();
      },
      pulseActivity: (color, shape) => {
        if (activeIndex === index) pulseStatusLight(color, shape, () => activeIndex === index);
      },
      log: (message) => log(module.id, message),
      warn: (message) => logError(module.id, message),
      signal: controller.signal,
    });
  });

  function handleInput(event: InputEvent): void {
    if (event.type === 'button') {
      // RELEASE would fire a second time for the same press.
      if (event.action !== 'PRESS') return;
      if (event.button === switchButton && modules.length > 1) {
        activeIndex = wrapIndex(activeIndex, 1, modules.length);
        log('host', `-> ${active().module.title}`);
        repaint();
      } else if (event.button === 'START') {
        active().requestRefresh('START pressed');
      } else {
        // Repaint on any other press: recovers a screen blanked by BACK or
        // overdrawn by another app.
        repaint();
      }
      return;
    }
    if (event.type !== 'encoder' || event.delta === 0) return;
    active().module.onEncoder?.(event.delta);
    repaint();
  }

  /** Countdowns and pace ticks repaint once a heartbeat between polls — a
   * draw to the device only, never a fetch — so "4:59" doesn't sit frozen.
   * Skipped mid-refresh; the poll path repaints on its own. */
  const heartbeat = setInterval(() => {
    if (!active().refreshing) repaint();
  }, heartbeatMs);
  controller.signal.addEventListener('abort', () => clearInterval(heartbeat));

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      controller.abort();
      // Drain the LED chain first: an aborted pulse still sends its light-off
      // frame, and that draw must land before the clear — after it, it would
      // re-register the application on the device.
      void ledChain
        .then(() => session.clear())
        .catch(() => {})
        .finally(() => process.exit(0));
    });
  }

  try {
    await Promise.all([
      ...runners.map((runner) => runner.run(controller.signal)),
      listenInput(handleInput, {
        signal: controller.signal,
        onError: (e) => logError('input', e.message),
        // The socket erroring every 2 s reconnect is coalesced above; a
        // successful reconnect is the moment to say the outage ended.
        onConnect: () => logResolved('input'),
      }),
    ]);
  } catch (error) {
    // A module poll() throw is fatal by contract (e.g. NoCredentialsError):
    // stop everything, leave the display clean, and exit non-zero. As on
    // SIGINT, the LED chain drains before the clear.
    controller.abort();
    const expected = error instanceof Error && !BUILTIN_ERROR_NAMES.has(error.name);
    logError('host', expected ? (error as Error).message : ((error as Error)?.stack ?? String(error)));
    await ledChain.catch(() => {});
    await session.clear().catch(() => {});
    process.exitCode = 1;
  }
}
