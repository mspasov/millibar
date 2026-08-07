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
import { DisplaySession } from './display';
import { listenInput, type Button, type InputEvent } from './input';
import { pulseLed } from './led';
import { ModuleRunner, wrapIndex, type MonitorModule } from './module';

const BUTTONS: readonly Button[] = ['OK', 'BACK', 'START'];
const ADDR = process.env.BUSY_BAR_ADDR ?? '10.0.4.20';

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
  const priority = options.priority ?? Number(process.env.BUSY_PRIORITY ?? 50);
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
    void session.draw(elements).catch((e) => console.error((e as Error).message));
  }

  const runners = modules.map(
    (module) =>
      new ModuleRunner(
        module,
        () => {
          if (active().module === module) repaint();
        },
        (message) => console.log(`[${module.id}] ${message}`)
      )
  );

  /** One LED pulse at a time: the red failure blink can arrive while the cyan
   * fetch pulse is still fading, and interleaving their frames would flicker
   * both colours. Abort the running pulse and chain the new one behind its
   * cleanup, so the old run's final black frame cannot land mid-blink. */
  let ledAbort: AbortController | null = null;
  let ledChain = Promise.resolve();
  function pulseStatusLight(color: string, shape?: { durationMs?: number; cycles?: number }): void {
    ledAbort?.abort();
    const abort = new AbortController();
    ledAbort = abort;
    const signal = AbortSignal.any([abort.signal, controller.signal]);
    // Fire-and-forget: the fade outlasts a typical fetch and must not delay it.
    ledChain = ledChain
      .then(() => pulseLed({ color, ...shape, applicationName, priority, signal }))
      .catch(() => {});
  }

  modules.forEach((module, index) => {
    module.init?.({
      requestRender: () => {
        if (activeIndex === index) repaint();
      },
      pulseActivity: (color, shape) => {
        if (activeIndex === index) pulseStatusLight(color, shape);
      },
      log: (message) => console.log(`[${module.id}] ${message}`),
      signal: controller.signal,
    });
  });

  function handleInput(event: InputEvent): void {
    if (event.type === 'button') {
      // RELEASE would fire a second time for the same press.
      if (event.action !== 'PRESS') return;
      if (event.button === switchButton && modules.length > 1) {
        activeIndex = wrapIndex(activeIndex, 1, modules.length);
        console.log(`-> ${active().module.title}`);
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
      void session
        .clear()
        .catch(() => {})
        .finally(() => process.exit(0));
    });
  }

  console.log(
    `millibar: ${modules.map((m) => m.title).join(', ')} on ${ADDR} — ` +
      `press ${switchButton} (the dial) for the next module, START to refresh, ` +
      'rotate the encoder to cycle views (Ctrl-C to stop and clear)'
  );

  try {
    await Promise.all([
      ...runners.map((runner) => runner.run(controller.signal)),
      listenInput(handleInput, {
        signal: controller.signal,
        onError: (e) => console.error(e.message),
      }),
    ]);
  } catch (error) {
    // A module poll() throw is fatal by contract (e.g. NoCredentialsError):
    // stop everything, leave the display clean, and exit non-zero.
    controller.abort();
    console.error((error as Error).message);
    await session.clear().catch(() => {});
    process.exitCode = 1;
  }
}
