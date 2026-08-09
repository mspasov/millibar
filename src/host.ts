/**
 * Runs a set of monitor modules against one BUSY Bar: one display session,
 * one input stream, one status-light owner, one process.
 *
 * Interaction: pressing the dial (a button event — there is no dedicated
 * encoder-press; see DEVICE.md) cycles to the next module, START refreshes
 * the active module, rotating the encoder is forwarded to the active module,
 * and BACK twice within 5 s quits (the first press paints a confirm prompt).
 * Every press still ends in a draw, so a screen blanked by BACK or overdrawn
 * by another app is always recoverable. Moving the selector switch away from
 * OFF pauses all drawing (and input handling) until it returns — the system
 * screens own the display there, and our draws would land on top of them.
 */
import { envNumber } from './config';
import { describeConnection, resolveConnection } from './connection';
import { DisplaySession, type DrawElement } from './display';
import { listenInput, type Button, type InputEvent } from './input';
import { pulseLed, type PulseShape } from './led';
import { log, logError, logResolved } from './log';
import { ModuleRunner, wrapIndex, type MonitorModule } from './module';
import { BACK_SETTLE_MS, QuitConfirm, TURN_OFF_HOLD_MS, ensureTurnOffAsset, turnOffElement } from './quit-confirm';

const BUTTONS: readonly Button[] = ['OK', 'BACK', 'START'];

/** Flipping the switch back to OFF plays the firmware's power-down animation:
 * blank ~130 ms after the event, one ~667 ms pass, dark by ~750 ms (measured
 * via /api/screen, firmware 1.1.1). Resuming before it finishes would overdraw
 * the power-down — and could itself be wiped by its later frames; the margin
 * covers the same load-dependent start lag as TURN_OFF_HOLD_MS. */
const SWITCH_RESUME_MS = 1200;

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
  /** false stills the quit-confirm drain and skips the turn-off farewell
   * (mbar's ANIMATIONS switch). */
  animations?: boolean;
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

  /** True from a switch-away event until SWITCH_RESUME_MS after the switch
   * returns to OFF. Away from OFF the system owns the screen — the apps and
   * settings menus run at priority 10, under our default 50, so any draw of
   * ours (a repaint, or an LED pulse's filler frame) lands on top of them.
   * Change-events are all we get: the state stream carries no initial
   * position, so a monitor started with the switch already away still draws
   * until the first flip. */
  let switchedAway = false;
  let switchResume: ReturnType<typeof setTimeout> | null = null;

  function drawFrame(elements: DrawElement[]): void {
    void session.draw(elements).then(
      // A success closes any open draw incident — during a device outage the
      // heartbeat fails once a minute, and the recovery line is the only
      // signal that the display is back.
      () => logResolved('draw'),
      (e) => logError('draw', (e as Error).message)
    );
  }

  function repaint(): void {
    // The quit prompt owns the screen while armed: a poll finishing (or the
    // heartbeat firing) mid-window must not overdraw it. Expiry repaints
    // after disarming, so the suppression cannot outlive the window. The
    // same gate covers the switch: away from OFF the screen is the system's.
    if (quit.armed || switchedAway) return;
    const runner = active();
    const module = runner.module;
    const elements = module
      .render({ refreshing: runner.refreshing })
      .map((el) => ({ ...el, id: `${module.id}.${el.id}` }));
    drawFrame(elements);
  }

  const quit = new QuitConfirm({
    draw: drawFrame,
    onExpire: () => repaint(),
    animate: options.animations ?? true,
  });

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
    // Every pulse frame is a display draw (the LED colour rides on a filler
    // element), so pulses would steal the screen from a system menu too.
    if (switchedAway) return;
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
      'rotate the encoder to cycle screens, BACK twice to quit (or Ctrl-C)'
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
    if (event.type === 'switch') {
      if (switchResume) clearTimeout(switchResume);
      switchResume = null;
      if (event.position !== 'OFF') {
        if (!switchedAway) log('host', `switch -> ${event.position}: system screen up, drawing paused until OFF`);
        switchedAway = true;
        // A mid-flight pulse would keep posting draw frames under the menu.
        ledAbort?.abort();
        quit.disarm();
      } else if (switchedAway) {
        log('host', 'switch -> OFF: resuming once the power-down finishes');
        switchResume = setTimeout(() => {
          switchResume = null;
          switchedAway = false;
          repaint();
        }, SWITCH_RESUME_MS);
      }
      return;
    }
    // Buttons and the encoder drive the system screens while the switch is
    // away — reacting (every press ends in a draw) would fight them.
    if (switchedAway) return;
    if (event.type === 'button') {
      // RELEASE would fire a second time for the same press.
      if (event.action !== 'PRESS') return;
      if (event.button === 'BACK' && quit.armed) {
        log('host', 'BACK pressed twice — quitting');
        shutdown(true);
        return;
      }
      // Any other press dismisses an open prompt and then acts normally. The
      // restore repaint comes first because the action's own repaint can be
      // deferred (START with a refresh already in flight repaints only when
      // that refresh ends).
      if (quit.disarm()) repaint();
      if (event.button === switchButton && modules.length > 1) {
        activeIndex = wrapIndex(activeIndex, 1, modules.length);
        log('host', `-> ${active().module.title}`);
        repaint();
      } else if (event.button === 'START') {
        active().requestRefresh('START pressed');
      } else if (event.button === 'BACK') {
        // Unreachable when SWITCH_BUTTON=BACK claims the button above — the
        // remap keeps module cycling and gives up on-device quitting.
        quit.arm();
      } else {
        // Repaint on any other press: recovers a screen blanked by BACK or
        // overdrawn by another app. (BACK itself recovers too — the prompt is
        // a draw, and its expiry repaints the module.)
        repaint();
      }
      return;
    }
    if (event.type !== 'encoder' || event.delta === 0) return;
    quit.disarm();
    active().module.onEncoder?.(event.delta);
    repaint();
  }

  /** Countdowns and pace ticks repaint once a heartbeat between polls — a
   * draw to the device only, never a fetch — so "4:59" doesn't sit frozen.
   * Skipped mid-refresh; the poll path repaints on its own. */
  const heartbeat = setInterval(() => {
    if (!active().refreshing) repaint();
  }, heartbeatMs);
  controller.signal.addEventListener('abort', () => {
    clearInterval(heartbeat);
    // Also stops the quit ticker and any pending switch-resume repaint: a
    // frame drawn after the shutdown clear would re-register the application
    // on the device.
    quit.disarm();
    if (switchResume) clearTimeout(switchResume);
    switchResume = null;
  });

  // Synced in the background at startup so a quit can play it immediately;
  // resolves false (with a log line) when it can't be readied. Skipped
  // entirely with animations off — the quit is then as still as the sweeps.
  const farewellReady: Promise<boolean> =
    (options.animations ?? true)
      ? ensureTurnOffAsset(applicationName, (message) => log('host', message))
      : Promise.resolve(false);

  /** Clean exit shared by SIGINT/SIGTERM and the double-BACK quit. The
   * latter passes `farewell` to play the firmware's turn-off animation
   * first, so quitting from the device reads as the device powering down;
   * Ctrl-C at the terminal stays instant. */
  function shutdown(farewell = false): void {
    controller.abort();
    void (async () => {
      if (farewell && (await farewellReady)) {
        // The confirming BACK blanks the screen like any BACK (DEVICE.md);
        // drawing before that blank lands would get the farewell wiped.
        await Bun.sleep(BACK_SETTLE_MS);
        // One non-looping pass; the hold covers the device's slow start and
        // its final dark frame. Failures fall through to the clear — never
        // block the exit.
        await session.draw([turnOffElement()]).catch(() => {});
        await Bun.sleep(TURN_OFF_HOLD_MS);
      }
      // Drain the LED chain before clearing: an aborted pulse still sends
      // its light-off frame, and a draw landing after the clear would
      // re-register the application on the device.
      await ledChain.catch(() => {});
      await session.clear().catch(() => {});
      process.exit(0);
    })();
  }

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => shutdown());
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
