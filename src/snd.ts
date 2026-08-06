/**
 * Helpers for the device's `.snd` audio format: headerless raw PCM,
 * signed 16-bit little-endian, mono, 44100 Hz (see DEVICE.md).
 */
export const SAMPLE_RATE = 44100;

/**
 * Convert float samples to 16-bit PCM, scaled so the loudest sample hits
 * `peak` of full scale. Stock sounds are loudness-normalized to −6 LUFS;
 * around half of full scale sits comfortably next to them.
 */
export function pcm16(samples: Float64Array, peak = 0.5): Int16Array {
  let max = 0;
  for (const s of samples) max = Math.max(max, Math.abs(s));
  const gain = max > 0 ? peak / max : 0;
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    pcm[i] = Math.round(samples[i]! * gain * 32767);
  }
  return pcm;
}
