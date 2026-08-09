import { describe, expect, test } from 'bun:test';
import { decodeInputEvents, listenInput } from './input';

// Hand-rolled protobuf encoding, mirroring the wire format the device sends:
// BSB_State.State { 2: StateUpdate { 11: InputEvent { 1: button | 2: switch |
// 3: encoder } } }. Building the bytes here (rather than with a protobuf
// runtime) keeps the fixtures readable at the byte level — this parser exists
// precisely because the wire details (varint skipping, zigzag) are traps.

function varint(n: number): number[] {
  const out: number[] = [];
  let v = n;
  do {
    const byte = v & 0x7f;
    v = Math.floor(v / 128);
    out.push(v > 0 ? byte | 0x80 : byte);
  } while (v > 0);
  return out;
}

/** Varint field. */
const vf = (field: number, value: number): number[] => [(field << 3) | 0, ...varint(value)];
/** Length-delimited field. */
const ld = (field: number, payload: number[]): number[] => [
  (field << 3) | 2,
  ...varint(payload.length),
  ...payload,
];

const zigzag = (n: number): number => (n < 0 ? -2 * n - 1 : 2 * n);

/** Wraps input-event message bodies into a full State message. */
const state = (...events: number[][]): Uint8Array =>
  new Uint8Array(ld(2, events.flatMap((event) => ld(11, event))));

describe('decodeInputEvents', () => {
  test('decodes button events', () => {
    expect(decodeInputEvents(state(ld(1, [...vf(1, 2), ...vf(2, 0)])))).toEqual([
      { type: 'button', button: 'START', action: 'PRESS' },
    ]);
    expect(decodeInputEvents(state(ld(1, [...vf(1, 1), ...vf(2, 1)])))).toEqual([
      { type: 'button', button: 'BACK', action: 'RELEASE' },
    ]);
  });

  test('proto3 zero-default: an omitted button field means OK', () => {
    // The device omits fields at their default value, so a payload carrying
    // only the action must still decode as OK (enum 0).
    expect(decodeInputEvents(state(ld(1, vf(2, 1))))).toEqual([
      { type: 'button', button: 'OK', action: 'RELEASE' },
    ]);
  });

  test('decodes switch positions', () => {
    expect(decodeInputEvents(state(ld(2, vf(1, 3))))).toEqual([
      { type: 'switch', position: 'APPS' },
    ]);
  });

  test('decodes encoder deltas, including negative zigzag values', () => {
    expect(decodeInputEvents(state(ld(3, vf(1, zigzag(1)))))).toEqual([
      { type: 'encoder', delta: 1 },
    ]);
    expect(decodeInputEvents(state(ld(3, vf(1, zigzag(-3)))))).toEqual([
      { type: 'encoder', delta: -3 },
    ]);
  });

  test('multiple input events in one state message all come out', () => {
    const events = decodeInputEvents(
      state(ld(3, vf(1, zigzag(2))), ld(1, [...vf(1, 0), ...vf(2, 0)]))
    );
    expect(events).toEqual([
      { type: 'encoder', delta: 2 },
      { type: 'button', button: 'OK', action: 'PRESS' },
    ]);
  });

  test('skips unrelated fields of every wire type without desyncing', () => {
    // The stream also carries screen frames and future fields. Surround the
    // input with varint, fixed64, length-delimited, and fixed32 fields — the
    // classic desync (offset += readVarint()) shows up exactly here.
    const message = new Uint8Array([
      ...vf(1, 300), // varint (multi-byte)
      ...[(3 << 3) | 1, 1, 2, 3, 4, 5, 6, 7, 8], // fixed64
      ...ld(7, [0xde, 0xad, 0xbe, 0xef]), // some blob
      ...ld(2, ld(11, ld(3, vf(1, zigzag(-1))))),
      ...[(9 << 3) | 5, 1, 2, 3, 4], // fixed32
    ]);
    expect(decodeInputEvents(message)).toEqual([{ type: 'encoder', delta: -1 }]);
  });

  test('unknown enum values yield no event rather than a wrong one', () => {
    expect(decodeInputEvents(state(ld(1, [...vf(1, 9), ...vf(2, 0)])))).toEqual([]);
    expect(decodeInputEvents(state(ld(2, vf(1, 9))))).toEqual([]);
  });

  test('corrupt input is abandoned, never thrown', () => {
    // Truncated: declared length runs past the buffer (the clamp path).
    expect(decodeInputEvents(new Uint8Array([(2 << 3) | 2, 10, 0x01]))).toEqual([]);
    // Unwalkable wire type 3 (deprecated group).
    expect(decodeInputEvents(new Uint8Array([(1 << 3) | 3, 0xff]))).toEqual([]);
    expect(decodeInputEvents(new Uint8Array([]))).toEqual([]);
  });
});

describe('listenInput', () => {
  test('skips the cloud proxy instead of hammering a blocked WebSocket', async () => {
    // The proxy 403s every WebSocket upgrade at its edge (DEVICE.md), so an
    // attempt would fail looking like a dead route. The listener must report
    // why — once, coalescably — and never open a socket (this test would
    // otherwise hit the real proxy).
    const errors: string[] = [];
    const controller = new AbortController();
    await listenInput(() => {}, {
      addr: 'api.busy.app',
      signal: controller.signal,
      onError: (error) => {
        errors.push(error.message);
        controller.abort();
      },
    });
    expect(errors).toEqual(['no button input over the cloud proxy — it rejects WebSocket upgrades']);
  });
});
