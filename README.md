# millibar

Usage pressure on a very small bar.

Controls a [BUSY Bar](https://busy.app/) — an open-source desk device with a 72×16 LED
pixel display, a rotary encoder, three buttons, a five-position mode switch, and an RGB
status light — from TypeScript.

The headline app is a **modular monitor**: press the dial to switch between monitor
modules — Claude Code usage limits, CPU load, and whatever you add next — rotate it to
cycle the views inside a module, and press `START` to refresh, with the status light
fading cyan while it fetches.

## Setup

```sh
bun install
bun run tools/smoke.ts        # connectivity smoke test
bun link                # installs the global `mbar` command (~/.bun/bin)
```

The smoke test should print your device's model, firmware, battery, and timer state. If
it hangs or errors, see [Troubleshooting](#troubleshooting).

## Scripts

| Command | What it does |
|---|---|
| `bun run tools/smoke.ts` | Smoke test — prints device status and busy-timer state. |
| `mbar` (or `bun run src/mbar.ts`) | **The monitor.** Switchable modules on the display: Claude Code limits and CPU load. Dial press switches modules, rotation cycles views, `START` refreshes. |
| `bun run src/input.ts` | Prints button, switch, and encoder events live. |
| `bun run src/led.ts pulse "#00CCFF" 1400 2` | Pulses the status light — colour, duration ms, cycles. |
| `bun run src/led.ts fade "#F00,#0F0,#00F" 3000 hsv` | Crossfades through colour stops — stops, duration ms, `rgb`\|`hsv`. |
| `bun run tools/plasma.ts [seconds]` | Generates, uploads, and plays a looping plasma animation. |
| `bun run tools/flame.ts [start-level]` | **Flame.** Fire rises from the bottom; the dial sets its intensity (16 levels). Changes glide one level at a time, phase-matched, so they're smooth *and* immediate. `--preview [out.png]` renders a local contact sheet instead. |
| `bun run tools/chime.ts [freqs-hz...]` | Synthesizes a chime, uploads it, and plays it on the speaker. |
| `bun run tools/click.ts [--once]` | Clicks the speaker whenever the rotary dial moves. |
| `bun run tools/screenshot.ts [out.png] [front\|back] [scale]` | Captures a display to PNG. |

## Configuration

All via environment variables; every one has a working default.

| Variable | Default | Applies to |
|---|---|---|
| `BUSY_BAR_ADDR` | `10.0.4.20` | everything — IP, hostname, or full URL |
| `POLL_INTERVAL_MS` | `300000` (5 min) | monitor — how often the usage API is polled |
| `REFRESH_COOLDOWN_MS` | `5000` | monitor — floor between button-triggered fetches |
| `BUSY_PRIORITY` | `50` | monitor — draw priority, 1–100 |
| `SWITCH_BUTTON` | `OK` | monitor — which button event the dial press reports as (`OK`\|`BACK`\|`START`) |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | usage — where credentials are read from off-macOS |

## Modules

Each is usable on its own, not just by the monitor.

- **`src/usage.ts`** — reads Claude Code's own usage limits (5-hour, 7-day, per-model)
  from an undocumented endpoint, using the OAuth token Claude Code already stores. See
  [USAGE-API.md](docs/USAGE-API.md).
- **`src/input.ts`** — `listenInput()` streams button, switch, and encoder events off the
  device's protobuf WebSocket. Decodes only the input field, so it needs no protobuf
  runtime.
- **`src/led.ts`** — `pulseLed()` and `fadeLed()` animate the status light smoothly,
  despite the firmware only exposing a fixed 3-blink notification preset.
- **`src/anim.ts`** — `encodeAnim()` writes the device's native `bicycle0` animation
  container (RLE-compressed BGR frames, named sections), reverse-engineered from the
  open-source firmware.
- **`src/png.ts`** — `encodePng()`, the minimal PNG writer behind screenshots and
  local previews.
- **`src/snd.ts`** — `pcm16()` converts float samples to the device's `.snd` audio format
  (raw s16le mono 44.1 kHz).
- **`src/display.ts`** — the draw transport plus `DisplaySession`, which serialises
  draws, stamps timeouts, and scrubs elements whose ids disappear between draws (the
  firmware otherwise leaves them on screen). Also the shared render kit: severity
  colours, font metrics, the compact countdown, `progressBar()`.
- **`src/module.ts`** — the `MonitorModule` contract and per-module scheduler.
- **`src/host.ts`** — `runHost()` runs modules against one device: input routing, module
  switching, the heartbeat repaint, status-light ownership, shutdown.
- **`src/modules/`** — the modules themselves: `claude-usage.ts`, `cpu.ts`.
- **`src/mbar.ts`** — the entry point that registers modules with the host.

### Monitor behaviour

One window at a time: a label, a dark-grey countdown to the window's reset, a percentage,
and a progress bar recoloured by severity (green below 50%, amber below 80%, red above).
The countdown (`4:59`, `6D4H`, `59M`) ticks once a minute and drops precision — or hides —
when a long model label leaves it no room.

A faint tick on the bar marks how much of the window has elapsed, so the bar reads as a
race: fill ahead of the tick means tokens are going faster than time. Under pace the tick
sits in the empty track, just lighter than it; over pace it sits submerged in the fill as
a darker notch of the severity colour.

- **Press the dial** (its press arrives as the `OK` button event — override with
  `SWITCH_BUTTON` if your press reports differently) to switch to the next module:
  Claude usage → CPU load → back. Each module keeps polling while hidden, so switching
  always lands on fresh data, and each remembers which view it was on.
- **Rotate the encoder** to cycle the active module's views — `5H` → `7D` → per-model
  windows (e.g. `FABLE`) on Claude usage, `1M`/`5M`/`15M` load windows on CPU. The Claude
  list is rebuilt each poll, since the API adds and drops model windows; the selection
  follows its label rather than its index so a refresh never jumps you elsewhere.
- **Press `START`** to refresh the active module immediately. Three cyan dots replace the
  countdown while fetching and the status light fades. During cooldown a press still
  repaints (without refetching), so a blank screen is always recoverable — every button
  press ends in a repaint.
- Draws carry a 90-second timeout, refreshed by a once-a-minute heartbeat repaint (which
  also keeps countdowns ticking), so the display **self-clears within ~90 s if the
  process dies**. Ctrl-C clears it explicitly.

Buttons keep their normal device functions too — depending on device state, `OK` and
`START` can start a BUSY session, and `BACK` blanks the canvas. That's the device's own
behaviour, not the monitor's.

### Writing a monitor module

A module is one file in `src/modules/` implementing `MonitorModule` (see
[src/module.ts](src/module.ts)): a `poll()` that updates its data and returns its own
cadence and refresh cooldown, a `render()` that returns the element list for its current
state, and optionally `onEncoder()` for internal views. Register it in
[src/mbar.ts](src/mbar.ts) and the host does the rest — id namespacing, element
scrubbing on switch, timeouts, input routing, and status-light arbitration. A Grok-usage
module, say, is a sibling fetch client next to `src/usage.ts` plus a factory shaped like
[src/modules/claude-usage.ts](src/modules/claude-usage.ts); nothing else changes.

## Troubleshooting

**Device unreachable.** Confirm with `curl http://10.0.4.20/api/status`. The bar is also
reachable at `http://busy.bar/`. Over USB-Ethernet the address is fixed at `10.0.4.20`.

**Display went black.** Most likely `BACK` was pressed, which dismisses the drawing layer
and drops to a stub app that renders nothing — the display is not off. Any draw reclaims
it. See [DEVICE.md](docs/DEVICE.md#display-priority-and-the-back-button).

**`Not drawn due to low priority`.** Another app holds the display at an equal or higher
priority. Clear it (`curl -X DELETE "http://10.0.4.20/api/display/draw?application_name=NAME"`)
or draw higher. Note that two draw-based scripts running at once will fight over the screen.

**`no Claude Code OAuth credentials found`.** Run `claude auth` to sign in.

**Usage numbers dimmed with a `?` label.** The last fetch failed and stale values are being
shown. Repeated manual refreshes can trigger a `429`; the monitor honours `Retry-After` and
recovers on its own.

## Documentation

- **[DEVICE.md](docs/DEVICE.md)** — everything learned about the hardware and its HTTP API:
  drawing, priorities, the animation format, input events, the status light, and the
  spec's inaccuracies. Read this before touching device code.
- **[USAGE-API.md](docs/USAGE-API.md)** — the undocumented Claude Code usage endpoint.
- **[CLAUDE.md](CLAUDE.md)** — working practices for this repo.

## Requirements

Bun 1.3+, a BUSY Bar on the same network, and Claude Code signed in (for the monitor).
Credential reading is implemented for the macOS Keychain with a file fallback elsewhere.
