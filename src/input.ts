/**
 * Reads physical input events (buttons, mode switch, rotary encoder) from the
 * BUSY Bar over its state-stream WebSocket.
 *
 * `POST /api/input` only *sends* key events to the device — there is no HTTP
 * endpoint to read input. Events arrive instead on `GET /api/status/ws`, as
 * protobuf-encoded `BSB_State.State` messages carrying `StateUpdate.input`
 * (field 11). Streaming must be enabled by sending `{"enable": true}` after
 * connecting. Schemas: github.com/busy-app/busybar-protobuf (input.proto,
 * state.proto).
 *
 * Only the input field is decoded here; frames and other state updates are
 * skipped, so this stays dependency-free rather than pulling in a protobuf
 * runtime. (The library's own StateStream decodes everything but runs in a
 * browser Shared Worker.)
 *
 * Usage: bun run src/input.ts
 */

import { deviceAddr, wsBase } from './config';

const BUTTONS = ['OK', 'BACK', 'START'] as const;
const ACTIONS = ['PRESS', 'RELEASE'] as const;
const SWITCH_POSITIONS = ['BUSY', 'CUSTOM', 'OFF', 'APPS', 'SETTINGS'] as const;

export type Button = (typeof BUTTONS)[number];
export type ButtonAction = (typeof ACTIONS)[number];
export type SwitchPosition = (typeof SWITCH_POSITIONS)[number];

export type InputEvent =
  | { type: 'button'; button: Button; action: ButtonAction }
  | { type: 'switch'; position: SwitchPosition }
  | { type: 'encoder'; delta: number };

/** Minimal protobuf field reader — enough to walk messages and skip the rest. */
class Reader {
  offset = 0;
  constructor(readonly buf: Uint8Array) {}

  get done(): boolean {
    return this.offset >= this.buf.length;
  }

  varint(): number {
    let result = 0;
    let shift = 0;
    while (this.offset < this.buf.length) {
      const byte = this.buf[this.offset++]!;
      result += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) break;
      shift += 7;
    }
    return result;
  }

  lengthDelimited(): Uint8Array {
    // `length` must be read before `this.offset` is used: varint() advances it,
    // and JS would otherwise evaluate the stale offset first.
    const length = this.varint();
    // Clamp: a corrupt length must not read past the buffer or run away.
    const end = Math.min(this.offset + length, this.buf.length);
    const slice = this.buf.subarray(this.offset, end);
    this.offset = end;
    return slice;
  }

  /** Returns false on a wire type we cannot size, meaning the rest of this
   * message is no longer safely walkable. */
  skip(wireType: number): boolean {
    switch (wireType) {
      case 0: this.varint(); return true;
      case 1: this.offset += 8; return true;
      case 2: this.lengthDelimited(); return true;
      case 5: this.offset += 4; return true;
      // 3 and 4 are deprecated groups; 6 and 7 do not exist.
      default: this.offset = this.buf.length; return false;
    }
  }
}

function* fields(buf: Uint8Array) {
  const reader = new Reader(buf);
  while (!reader.done) {
    const tag = reader.varint();
    yield { field: tag >>> 3, wire: tag & 7, reader };
  }
}

function firstVarint(buf: Uint8Array, wanted: number): number {
  for (const { field, wire, reader } of fields(buf)) {
    if (field === wanted && wire === 0) return reader.varint();
    if (!reader.skip(wire)) break;
  }
  return 0;
}

function decodeInputEvent(buf: Uint8Array): InputEvent | null {
  for (const { field, wire, reader } of fields(buf)) {
    if (wire !== 2) {
      if (!reader.skip(wire)) break;
      continue;
    }
    const payload = reader.lengthDelimited();
    switch (field) {
      case 1: {
        const button = BUTTONS[firstVarint(payload, 1)];
        const action = ACTIONS[firstVarint(payload, 2)];
        return button && action ? { type: 'button', button, action } : null;
      }
      case 2: {
        const position = SWITCH_POSITIONS[firstVarint(payload, 1)];
        return position ? { type: 'switch', position } : null;
      }
      case 3: {
        // sint32 is zigzag-encoded.
        const raw = firstVarint(payload, 1);
        return { type: 'encoder', delta: (raw >>> 1) ^ -(raw & 1) };
      }
    }
  }
  return null;
}

/**
 * Extract input events from one `BSB_State.State` message.
 *
 * Anything unparseable is abandoned rather than throwing: this decodes a live
 * stream that also carries screen frames and future field types, and one
 * unexpected message must not kill the listener.
 */
export function decodeInputEvents(message: Uint8Array): InputEvent[] {
  const events: InputEvent[] = [];
  for (const { field, wire, reader } of fields(message)) {
    if (field !== 2 || wire !== 2) {
      if (!reader.skip(wire)) break;
      continue;
    }
    for (const update of fields(reader.lengthDelimited())) {
      if (update.field === 11 && update.wire === 2) {
        const event = decodeInputEvent(update.reader.lengthDelimited());
        if (event) events.push(event);
      } else if (!update.reader.skip(update.wire)) {
        break;
      }
    }
  }
  return events;
}

export interface ListenOptions {
  addr?: string;
  signal?: AbortSignal;
  /** Called on transport errors; listening continues via reconnect. */
  onError?: (error: Error) => void;
}

/**
 * Stream input events until `signal` aborts, reconnecting if the socket drops.
 */
export async function listenInput(
  onEvent: (event: InputEvent) => void,
  options: ListenOptions = {}
): Promise<void> {
  // wsBase: BUSY_BAR_ADDR may be a full http(s) URL, which must map to
  // ws(s)://, not be glued after "ws://".
  const base = wsBase(options.addr);
  const { signal, onError } = options;

  while (!signal?.aborted) {
    await new Promise<void>((resolve) => {
      const ws = new WebSocket(`${base}/api/status/ws`);
      ws.binaryType = 'arraybuffer';
      const close = () => ws.close();
      signal?.addEventListener('abort', close, { once: true });

      const finish = () => {
        signal?.removeEventListener('abort', close);
        resolve();
      };

      ws.onopen = () => ws.send(JSON.stringify({ enable: true }));
      ws.onmessage = (event) => {
        if (typeof event.data === 'string') return;
        for (const input of decodeInputEvents(new Uint8Array(event.data as ArrayBuffer))) {
          onEvent(input);
        }
      };
      ws.onerror = () => onError?.(new Error(`state stream connection to ${base} failed`));
      ws.onclose = finish;
    });

    if (signal?.aborted) break;
    await Bun.sleep(2000); // back off before reconnecting
  }
}

function describe(event: InputEvent): string {
  switch (event.type) {
    case 'button': return `button ${event.button} ${event.action}`;
    case 'switch': return `switch -> ${event.position}`;
    case 'encoder': return `encoder ${event.delta > 0 ? '+' : ''}${event.delta}`;
  }
}

if (import.meta.main) {
  const controller = new AbortController();
  process.on('SIGINT', () => {
    controller.abort();
    process.exit(0);
  });

  console.log(
    `Listening for input on ${deviceAddr()} — ` +
      'press buttons, turn the dial, or move the switch (Ctrl-C to stop)'
  );
  await listenInput(
    (event) => console.log(`[${new Date().toLocaleTimeString()}] ${describe(event)}`),
    { signal: controller.signal, onError: (e) => console.error(e.message) }
  );
}
