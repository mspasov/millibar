/**
 * Synthesizes a short two-note chime as a `.snd` file, uploads it to the
 * BUSY Bar, and plays it through the built-in speaker.
 *
 * The `.snd` format is headerless raw PCM: signed 16-bit little-endian,
 * mono, 44100 Hz (see DEVICE.md — confirmed from the firmware's
 * scripts/audio.py, which encodes with ffmpeg `-f s16le -ar 44100 -ac 1`).
 *
 * Usage: bun run tools/chime.ts [note-frequencies-hz...]
 *   e.g. bun run tools/chime.ts 523.25 659.25 783.99
 */
import { BusyBar } from '@busy-app/busy-lib';
import { deviceAddr } from '../src/config';
import { SAMPLE_RATE, pcm16 } from '../src/snd';

const APP_NAME = 'claude_sound';
const FILE_NAME = 'chime.snd';

const notes = process.argv.slice(2).map(Number);
if (notes.some(Number.isNaN)) {
  console.error('Arguments must be frequencies in Hz');
  process.exit(1);
}
const freqs = notes.length > 0 ? notes : [659.25, 880]; // E5, A5

function synthesizeChime(frequencies: number[]): Float64Array {
  const noteSpacing = 0.12; // seconds between note onsets
  const noteLength = 0.7; // seconds each note rings
  const total = noteSpacing * (frequencies.length - 1) + noteLength;
  const samples = new Float64Array(Math.ceil(total * SAMPLE_RATE));

  frequencies.forEach((freq, n) => {
    const start = Math.floor(n * noteSpacing * SAMPLE_RATE);
    const length = Math.floor(noteLength * SAMPLE_RATE);
    for (let i = 0; i < length && start + i < samples.length; i++) {
      const t = i / SAMPLE_RATE;
      // Bell-ish tone: fundamental + quieter 2nd harmonic, exponential decay,
      // 5ms linear attack to avoid an onset click.
      const envelope = Math.min(1, t / 0.005) * Math.exp(-t * 6);
      const tone =
        Math.sin(2 * Math.PI * freq * t) +
        0.3 * Math.sin(2 * Math.PI * freq * 2 * t);
      samples[start + i]! += tone * envelope;
    }
  });

  return samples;
}

const bar = new BusyBar({ addr: deviceAddr() });

const pcm = pcm16(synthesizeChime(freqs));
console.log(
  `Synthesized ${freqs.map((f) => f.toFixed(0)).join('+')}Hz chime: ` +
    `${(pcm.length / SAMPLE_RATE).toFixed(2)}s, ${(pcm.byteLength / 1024).toFixed(1)} KiB`
);

await bar.AssetsUpload(
  { application_name: APP_NAME, file: FILE_NAME, data: new Blob([pcm.buffer as ArrayBuffer]) },
  { timeout: 30000 }
);
console.log('Uploaded to device');

await bar.AudioPlay({ application_name: APP_NAME, path: FILE_NAME });
console.log('Playing');
