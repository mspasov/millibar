/**
 * Clicks the BUSY Bar's speaker whenever the rotary dial moves.
 *
 * Synthesizes a ~25ms mechanical tick, uploads it once, then plays it on
 * every encoder event from the state stream (src/input.ts).
 *
 * Firmware pacing (applications/services/audio/audio.c): the amplifier powers
 * up with a 100ms holdoff before a sound from idle can start, so a click
 * trails the physical detent by ~100ms plus the HTTP round trip. A play
 * issued while a sound is still running fades it out (~10ms) and queues the
 * new file. Clicking faster than the holdoff allows is pointless, so encoder
 * events inside the interval are dropped rather than queued.
 *
 * Usage: bun run src/click.ts          # click on every dial movement
 *        bun run src/click.ts --once   # play a single click and exit
 */
import { BusyBar } from '@busy-app/busy-lib';
import { listenInput } from './input';
import { SAMPLE_RATE, pcm16 } from './snd';

const APP_NAME = 'claude_sound';
const FILE_NAME = 'click.snd';
const MIN_CLICK_INTERVAL_MS = 100;

function synthesizeClick(): Int16Array {
  const length = Math.floor(0.025 * SAMPLE_RATE);
  const samples = new Float64Array(length);
  for (let i = 0; i < length; i++) {
    const t = i / SAMPLE_RATE;
    // A damped mid-high "tock" plus a burst of noise for the mechanical
    // texture. Sub-millisecond attack keeps it clicky without a DC pop;
    // high pitch suits the small speaker, which has no low end anyway.
    const attack = Math.min(1, t / 0.0008);
    const body = Math.sin(2 * Math.PI * 2600 * t) * Math.exp(-t / 0.004);
    const snap = (Math.random() * 2 - 1) * 0.6 * Math.exp(-t / 0.0015);
    samples[i] = attack * (body + snap);
  }
  return pcm16(samples);
}

const bar = new BusyBar({ addr: process.env.BUSY_BAR_ADDR ?? '10.0.4.20' });

const pcm = synthesizeClick();
await bar.AssetsUpload(
  { application_name: APP_NAME, file: FILE_NAME, data: new Blob([pcm.buffer as ArrayBuffer]) },
  { timeout: 30000 }
);
console.log(`Uploaded ${FILE_NAME} (${pcm.byteLength} bytes)`);

let lastClick = 0;
let inFlight = false;

async function click(): Promise<void> {
  const now = Date.now();
  if (inFlight || now - lastClick < MIN_CLICK_INTERVAL_MS) return;
  inFlight = true;
  lastClick = now;
  try {
    await bar.AudioPlay({ application_name: APP_NAME, path: FILE_NAME });
  } catch (error) {
    console.error(`click failed: ${(error as Error).message}`);
  } finally {
    inFlight = false;
  }
}

if (process.argv.includes('--once')) {
  await click();
  console.log('Played one click');
  process.exit(0);
}

const controller = new AbortController();
process.on('SIGINT', () => {
  controller.abort();
  process.exit(0);
});

console.log('Turn the dial to click (Ctrl-C to stop)');
await listenInput(
  (event) => {
    if (event.type !== 'encoder') return;
    console.log(`[${new Date().toLocaleTimeString()}] encoder ${event.delta > 0 ? '+' : ''}${event.delta}`);
    void click();
  },
  { signal: controller.signal, onError: (e) => console.error(e.message) }
);
