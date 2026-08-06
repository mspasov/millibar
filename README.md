# busy

Control a [BUSY Bar](https://busy.app/) — an open-source desk device with a 72×16 LED
pixel display, a rotary encoder, three buttons, a five-position mode switch, and an RGB
status light — from TypeScript.

The headline app shows your **Claude Code usage limits** on the bar: rotate the dial to
cycle between the 5-hour, 7-day, and per-model windows; press a button to refresh, with
the status light fading cyan while it fetches.

## Setup

```sh
bun install
bun run index.ts        # connectivity smoke test
```

`index.ts` should print your device's model, firmware, battery, and timer state. If it
hangs or errors, see [Troubleshooting](#troubleshooting).

## Scripts

| Command | What it does |
|---|---|
| `bun run index.ts` | Smoke test — prints device status and busy-timer state. |
| `bun run src/monitor.ts` | **Usage monitor.** Claude Code limits on the display; dial cycles windows, button refreshes. |
| `bun run src/input.ts` | Prints button, switch, and encoder events live. |
| `bun run src/led.ts pulse "#00CCFF" 1400 2` | Pulses the status light — colour, duration ms, cycles. |
| `bun run src/led.ts fade "#F00,#0F0,#00F" 3000 hsv` | Crossfades through colour stops — stops, duration ms, `rgb`\|`hsv`. |
| `bun run src/plasma.ts [seconds]` | Generates, uploads, and plays a looping plasma animation. |
| `bun run src/chime.ts [freqs-hz...]` | Synthesizes a chime, uploads it, and plays it on the speaker. |
| `bun run src/click.ts [--once]` | Clicks the speaker whenever the rotary dial moves. |
| `bun run src/screenshot.ts [out.png] [front\|back] [scale]` | Captures a display to PNG. |

## Configuration

All via environment variables; every one has a working default.

| Variable | Default | Applies to |
|---|---|---|
| `BUSY_BAR_ADDR` | `10.0.4.20` | everything — IP, hostname, or full URL |
| `POLL_INTERVAL_MS` | `300000` (5 min) | monitor — how often the usage API is polled |
| `REFRESH_COOLDOWN_MS` | `5000` | monitor — floor between button-triggered fetches |
| `BUSY_PRIORITY` | `50` | monitor — draw priority, 1–100 |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | usage — where credentials are read from off-macOS |

## Modules

Each is usable on its own, not just by the monitor.

- **`src/usage.ts`** — reads Claude Code's own usage limits (5-hour, 7-day, per-model)
  from an undocumented endpoint, using the OAuth token Claude Code already stores. See
  [USAGE-API.md](USAGE-API.md).
- **`src/input.ts`** — `listenInput()` streams button, switch, and encoder events off the
  device's protobuf WebSocket. Decodes only the input field, so it needs no protobuf
  runtime.
- **`src/led.ts`** — `pulseLed()` and `fadeLed()` animate the status light smoothly,
  despite the firmware only exposing a fixed 3-blink notification preset.
- **`src/anim.ts`** — `encodeAnim()` writes the device's native `bicycle0` animation
  container (RLE-compressed BGR frames), reverse-engineered from the open-source firmware.
- **`src/snd.ts`** — `pcm16()` converts float samples to the device's `.snd` audio format
  (raw s16le mono 44.1 kHz).
- **`src/screenshot.ts`** — captures a display to PNG, handling the BGR framebuffer.
- **`src/monitor.ts`** — composes the above into the usage monitor.

### Usage monitor behaviour

One window at a time: a label, a percentage, and a progress bar recoloured by severity
(green below 50%, amber below 80%, red above).

- **Rotate the encoder** to cycle `5H` → `7D` → per-model windows (e.g. `FABLE`). The list
  is rebuilt each poll, since the API adds and drops model windows; the selection follows
  its label rather than its index so a refresh never jumps you elsewhere.
- **Press any button** to refresh immediately. Three cyan dots appear while fetching and
  the status light fades. During cooldown a press still repaints (without refetching), so
  a blank screen is always recoverable.
- Draws carry a timeout of 1.5× the poll interval, so the display **self-clears if the
  process dies**. Ctrl-C clears it explicitly.

Buttons keep their normal device functions too — depending on device state, `OK` and
`START` can start a BUSY session, and `BACK` blanks the canvas. That's the device's own
behaviour, not the monitor's.

## Troubleshooting

**Device unreachable.** Confirm with `curl http://10.0.4.20/api/status`. The bar is also
reachable at `http://busy.bar/`. Over USB-Ethernet the address is fixed at `10.0.4.20`.

**Display went black.** Most likely `BACK` was pressed, which dismisses the drawing layer
and drops to a stub app that renders nothing — the display is not off. Any draw reclaims
it. See [DEVICE.md](DEVICE.md#display-priority-and-the-back-button).

**`Not drawn due to low priority`.** Another app holds the display at an equal or higher
priority. Clear it (`curl -X DELETE "http://10.0.4.20/api/display/draw?application_name=NAME"`)
or draw higher. Note that two draw-based scripts running at once will fight over the screen.

**`no Claude Code OAuth credentials found`.** Run `claude auth` to sign in.

**Usage numbers dimmed with a `?` label.** The last fetch failed and stale values are being
shown. Repeated manual refreshes can trigger a `429`; the monitor honours `Retry-After` and
recovers on its own.

## Documentation

- **[DEVICE.md](DEVICE.md)** — everything learned about the hardware and its HTTP API:
  drawing, priorities, the animation format, input events, the status light, and the
  spec's inaccuracies. Read this before touching device code.
- **[USAGE-API.md](USAGE-API.md)** — the undocumented Claude Code usage endpoint.
- **[CLAUDE.md](CLAUDE.md)** — working practices for this repo.

## Requirements

Bun 1.3+, a BUSY Bar on the same network, and Claude Code signed in (for the monitor).
Credential reading is implemented for the macOS Keychain with a file fallback elsewhere.
