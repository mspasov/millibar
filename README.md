# millibar

Usage pressure on a very small bar.

Controls a [BUSY Bar](https://busy.app/) — an open-source desk device with a 72×16 LED
pixel display, a rotary encoder, three buttons, a five-position mode switch, and an RGB
status light — from TypeScript.

The headline app is a **modular monitor**: press the dial to switch between monitor
modules — Claude Code usage limits, token history, the Grok weekly credit pool, CPU
load, and whatever you add next — rotate it to cycle the screens inside a module, and
press `START` to refresh, with the status light fading cyan while it fetches.

## Setup

```sh
bun install
bun run tools/smoke.ts        # connectivity smoke test
bun link                # installs the global `mbar` and `bbar` commands (~/.bun/bin)
```

The smoke test should print your device's model, firmware, battery, and timer state. If
it hangs or errors, see [Troubleshooting](#troubleshooting).

## Scripts

| Command | What it does |
|---|---|
| `bun run tools/smoke.ts` | Smoke test — prints device status and busy-timer state. |
| `mbar` (or `bun run src/mbar.ts`) | **The monitor.** Switchable modules on the display: Claude Code limits, token history (last 30/7 days, stacked by model), the Grok weekly credit pool, and CPU load. Dial press switches modules, rotation cycles screens, `START` refreshes, `BACK` twice quits. `--modules gauge,cpu` picks which modules run (and their order). |
| `bun run src/input.ts` | Prints button, switch, and encoder events live. |
| `bun run src/led.ts pulse "#00CCFF" 1400 2` | Pulses the status light — colour, duration ms, cycles. |
| `bun run src/led.ts fade "#F00,#0F0,#00F" 3000 hsv` | Crossfades through colour stops — stops, duration ms, `rgb`\|`hsv`. |
| `bun run tools/plasma.ts [seconds]` | Generates, uploads, and plays a looping plasma animation. |
| `bun run tools/flame.ts [start-level]` | **Flame.** Fire rises from the bottom; the dial sets its intensity (16 levels). Changes glide one level at a time, phase-matched, so they're smooth *and* immediate. `--preview [out.png]` renders a local contact sheet instead. |
| `bun run tools/sweep.ts [targets...]` | Test bench for the monitor's percentage-change animation: eased bar sweep, white-hot leading edge, rolling counter, severity-colour lerp. Scripted (`10 47 85`), interactive (no args), or `--demo`; reports the frame rate the device actually sustains. |
| `bun run tools/history-intro.ts [preview\|play]` | Test bench for the history module's appearance intros (bars rising with white tips, heatmap sweeping in). `preview` writes looping APNGs and an HTML page; `play` demos all three on the device and verifies the frames on the wire. |
| `bun run tools/chime.ts [freqs-hz...]` | Synthesizes a chime, uploads it, and plays it on the speaker. |
| `bun run tools/click.ts [--once]` | Clicks the speaker whenever the rotary dial moves. |
| `bun run tools/screenshot.ts [out.png] [front\|back] [scale]` | Captures a display to PNG. |
| `mbar probe\|routes\|show\|init\|set\|rm\|order` | **Connection config.** Manages the persistent route list (USB / LAN / cloud, with credentials) and probes which route answers. `--route <names>` forces a run onto specific routes. See [Connecting](#connecting-to-the-device). |
| `bbar` (or `bun run tools/bbar.ts`) | **Storage CLI.** Browse and manage the device's 7 GB `/ext` partition and per-app assets: `ls`/`df`/`cat`/`get`/`put`/`mv`/`mkdir`/`rm`, plus `apps`/`push`/`wipe` for asset directories. `bbar help` for the full list. |

## Connecting to the device

Every script resolves the device through the same ordered route list — by
default the fixed USB-Ethernet address, then the LAN hostname:

```
usb   10.0.4.20              (USB-Ethernet, fixed)
lan   busy.bar               (mDNS hostname on the LAN)
cloud https://api.busy.app   (remote proxy — add it yourself, needs a token)
```

Routes are probed in parallel (`GET /api/version`) and the first one, in
order, that answers like a BUSY device wins. If the winning route dies
mid-run — USB unplugged — the next request re-probes and fails over to the
next route without a restart.

The list persists in `~/.config/mbar/config.json`, managed with `mbar`'s
connection subcommands (the file is written `0600` because it can hold
credentials; without it the `usb` + `lan` defaults above apply):

```sh
mbar probe        # every route's status, and which one wins
mbar routes       # just the route names, one per line
mbar set cloud https://api.busy.app --token <token>
mbar set lan 192.168.1.50 --first   # add/update, move to front
mbar show|init|rm <name>|order <name...>
mbar --help       # full usage, including the monitor and env vars
```

To force a run onto specific routes without editing the config, name them:
`mbar --route cloud` runs the monitor over the proxy, `mbar probe --route
cloud,lan` probes those two in that order. The flag is `BUSY_BAR_ROUTE` in
env form, which every script in the repo honours. Forced routes are still
probed — a dead forced route is a loud error, not a silent fallback — while
`BUSY_BAR_ADDR` stays the unprobed escape hatch and wins over both.

Credentials, both optional, per route:

- `--token` — a cloud API token from <https://cloud.busy.app/api-tokens>,
  sent as `Authorization: Bearer …`. Required for the `api.busy.app` proxy
  route, and it must be created with the **BUSY Bar** access scope — an
  Account-scope token gets the same `HTTP 403` as an invalid one, and the
  scope can't be inspected after creation (see DEVICE.md, Authentication).
- `--password` — the device's HTTP Access Password (web UI: Settings → HTTP
  Access), sent as an `X-API-Token` header (`x-api-token` query parameter on
  WebSockets). Only needed if you enabled that setting.

Caveat: there is no *button input* over the cloud proxy — it rejects every
WebSocket upgrade at its edge (verified: any path 403s the moment the
Upgrade headers appear, valid token or not), so the monitor reports input
unavailable and runs without the dial. Drawing, audio, and storage go
through plain HTTP and work the same over any route.

## Configuration

All via environment variables; every one has a working default.

| Variable | Default | Applies to |
|---|---|---|
| `BUSY_BAR_ADDR` | unset | bypasses the route config: talk to exactly this IP/hostname/URL, unprobed (wins over `BUSY_BAR_ROUTE`) |
| `BUSY_BAR_ROUTE` | unset | force selection to these config routes — comma-separated names, tried in that order, still probed. Same as `mbar --route` |
| `BUSY_BAR_TOKEN` | unset | cloud token for routes that don't carry their own |
| `BUSY_BAR_PASSWORD` | unset | HTTP Access Password for routes that don't carry their own |
| `MBAR_CONFIG` | `~/.config/mbar/config.json` | where the route config lives |
| `POLL_INTERVAL_MS` | `600000` (10 min) | monitor — how often the usage API is polled |
| `REFRESH_COOLDOWN_MS` | `5000` | monitor — floor between button-triggered fetches |
| `BUSY_PRIORITY` | `50` | monitor — draw priority, 1–100 |
| `SWITCH_BUTTON` | `OK` | monitor — which button event the dial press reports as (`OK`\|`BACK`\|`START`) |
| `MBAR_MODULES` | unset (all) | monitor — which modules run and their cycle order, comma-separated (`gauge,dash,history,grok,cpu`); the first named is the startup module. Unset includes `grok` only when a `grok login` exists. Same as `mbar --modules` (the flag wins) |
| `ANIMATIONS` | `on` | monitor — `off` stills everything that moves: value changes snap instead of sweeping, and the history screens appear without their intros. Same as `mbar --no-animations` (the flag wins) |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | usage — where credentials are read from off-macOS |

## Modules

Each is usable on its own, not just by the monitor.

- **`src/usage.ts`** — reads Claude Code's own usage limits (5-hour, 7-day, per-model)
  from an undocumented endpoint, using the OAuth token Claude Code already stores. See
  [USAGE-API.md](docs/USAGE-API.md).
- **`src/stats.ts`** — reads Claude Code's local stats cache, the per-day token history
  behind its own usage graphs (there is no server endpoint for history). Drawn by the
  monitor's history module as stacked per-model bars over the last 30 or 7 days, plus an
  all-time calendar heatmap. See [USAGE-GRAPH.md](docs/USAGE-GRAPH.md).
- **`src/grok-usage.ts`** — reads the SuperGrok shared weekly credit pool (the data
  behind the Grok CLI's `/usage` panel) with the OIDC token `grok login` already stores.
  See [GROK-USAGE-API.md](docs/GROK-USAGE-API.md).
- **`src/connection.ts`** — the route resolver behind every device request:
  loads the persistent config, probes routes in priority order, injects
  credentials (`deviceFetch()`, `wsUrl()`, `connectedBar()`), and re-probes on
  network failure so callers fail over without noticing.
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
- **`src/sweep.ts`** — `PctSweep`, the time-based value animation the modules share:
  eased sweeps, colour lerps, the bar's cooling leading edge. Frames are computed from
  the wall clock, so slow draws drop frames instead of stretching the animation.
- **`src/module.ts`** — the `MonitorModule` contract and per-module scheduler.
- **`src/host.ts`** — `runHost()` runs modules against one device: input routing, module
  switching, the heartbeat repaint, status-light ownership, shutdown.
- **`src/modules/`** — the modules themselves: `claude-gauge.ts` (one limit
  window at a time, on the provider-agnostic layout in `limit-gauge.ts`),
  `claude-dash.ts` (every window at once; the shared poll/stale/cache
  machinery lives in `limit-poller.ts`), `claude-history.ts`, `grok-gauge.ts`
  (the Grok weekly pool on the same gauge layout), `cpu.ts` (1/5/15-minute
  load averages normalised by core count — sustained pressure, not
  instantaneous CPU%).
- **`src/mbar.ts`** — the entry point that registers modules with the host.

### Monitor behaviour

The Claude **gauge** shows one limit window at a time: a label, a dark-grey countdown to
the window's reset, a percentage, and a progress bar recoloured by severity (green below
50%, amber below 80%, red above). Its sibling the Claude **dashboard** puts every window
on one screen — one slim bar per window, under the same detail row for the selected window,
whose bar runs at full brightness behind a two-pixel marker at the left edge while the
other rows dim to 45%. The two modules share one deduplicated fetch, so the pair costs
the rate-limited usage API no more than a single module would. The countdown (`4:59`,
`6D4H`, `59M`) ticks once a minute and drops precision — or hides — when a long model
label leaves it no room.

A faint tick on each usage bar marks how much of that window has elapsed, so the bar
reads as a race: fill ahead of the tick means tokens are going faster than time. Under
pace the tick sits in the empty track, just lighter than it; over pace it sits submerged
in the fill as a darker notch of the fill colour.

Value changes animate rather than snap: the bar sweeps to its new fill with ease-out, the
percentage rolls through the intermediate values, the severity colour crossfades when a
sweep crosses a band boundary, and a white-hot pixel rides the fill's leading edge,
cooling into the bar once it lands. The same sweep plays when the encoder switches
windows and when a module's data goes stale (a fade to grey in place). CPU load jitter
under 3% jumps silently so the head doesn't flash every poll. The effect can be tuned and
timed standalone with `bun run tools/sweep.ts`, which also reports the frame rate the
device actually sustains.

- **Press the dial** (its press arrives as the `OK` button event — override with
  `SWITCH_BUTTON` if your press reports differently) to switch to the next module:
  Claude gauge → Claude dashboard → Claude history → Grok weekly → CPU load → back.
  (The Grok gauge — the SuperGrok weekly credit pool on the same layout — joins the
  cycle only when a `grok login` exists; without one it sits out rather than erroring.)
  Each module keeps polling while hidden, so switching always lands on fresh data, and
  each remembers which screen it was on.
- **Rotate the encoder** to cycle the active module's screens — `5H` → `7D` → per-model
  windows (e.g. `FABLE`) on both limit modules (on the dashboard the marker walks the
  bars), `30D`/`7D` bars → `ALL` heatmap on Claude history, `1M`/`5M`/`15M` load windows
  on CPU. The Grok gauge has a single `GROK` screen (the weekly pool is its whole
  scope), so rotation does nothing there. The limit window list is rebuilt each poll,
  since the API adds and drops model windows; the selection follows its label rather
  than its index so a refresh never jumps you elsewhere.
- **Press `START`** to refresh the active module immediately. Three cyan dots replace the
  countdown while fetching and the status light fades. During cooldown a press still
  repaints (without refetching), so a blank screen is always recoverable — every button
  press ends in a repaint.
- **Press `BACK` twice within 5 s to quit** from the device: the first press paints an
  `AGAIN = QUIT` prompt over a draining time bar, the second plays the firmware's own
  turn-off animation and exits cleanly. Any other input dismisses the prompt.
- A failed update blinks the status light **red, once** (preempting the cyan fetch
  fade), and the shown values dim to stale grey until a fetch succeeds. A rate-limit
  back-off (429) skips the blink — it's routine, and would otherwise recur every
  backed-off cycle — but still dims.
- The last successful usage read is cached in `~/.cache/mbar/usage.json`
  (`grok-usage.json` for the Grok module), so a restart while the API is unreachable or
  rate-limited starts from the previous values — grey with a `?` on the label, like any
  stale data — until a live fetch replaces them. Grok tokens expire after ~6 hours; the
  gauge dims to stale over an expired one and recovers on its own the next time any
  `grok` CLI use refreshes the stored token.
- **Moving the mode switch off `OFF`** silences the monitor — no repaints, no
  status-light frames, no button or encoder handling — because the system screens own
  the display there. Back on `OFF`, it repaints once the device's power-down animation
  has finished (~1.2 s). The switch position can't be read at startup, so a monitor
  launched with the switch already away draws until the first flip it sees.
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
state, and optionally `onEncoder()` for its screens. Register it in
[src/mbar.ts](src/mbar.ts) and the host does the rest — id namespacing, element
scrubbing on switch, timeouts, input routing, and status-light arbitration. The Grok
module is the worked example: a sibling fetch client next to `src/usage.ts`
([src/grok-usage.ts](src/grok-usage.ts)) plus a thin binding
([src/modules/grok-gauge.ts](src/modules/grok-gauge.ts)) of the shared gauge layout
([src/modules/limit-gauge.ts](src/modules/limit-gauge.ts)) to a `UsageSource`; nothing
else changed.

## Troubleshooting

**Device unreachable.** `mbar probe` reports every configured route's status and which
one scripts will use. To poke by hand: `curl http://10.0.4.20/api/status`
(USB-Ethernet, fixed address) or `http://busy.bar/` (LAN).

**Display went black.** Most likely `BACK` was pressed, which dismisses the drawing layer
and drops to a stub app that renders nothing — the display is not off. Any draw reclaims
it. See [DEVICE.md](docs/DEVICE.md#display-priority-and-the-back-button).

**`Not drawn due to low priority`.** Another app holds the display at an equal or higher
priority. Clear it (`curl -X DELETE "http://10.0.4.20/api/display/draw?application_name=NAME"`)
or draw higher. Note that two draw-based scripts running at once will fight over the screen.

**`no Claude Code OAuth credentials found`.** Run `claude auth` to sign in.

**No Grok module in the cycle.** The default roster includes it only when
`~/.grok/auth.json` exists — run `grok login` (naming it explicitly with
`--modules grok` instead makes the missing login a hard error).

**Usage numbers dimmed with a `?` label.** The last fetch failed and stale values are being
shown. Repeated manual refreshes can trigger a `429`; the monitor honours `Retry-After` and
recovers on its own.

## Documentation

- **[DEVICE.md](docs/DEVICE.md)** — everything learned about the hardware and its HTTP API:
  drawing, priorities, the animation format, input events, the status light, and the
  spec's inaccuracies. Read this before touching device code.
- **[USAGE-API.md](docs/USAGE-API.md)** — the undocumented Claude Code usage endpoint.
- **[GROK-USAGE-API.md](docs/GROK-USAGE-API.md)** — the undocumented Grok weekly
  credit-pool endpoint behind the Grok gauge.
- **[USAGE-GRAPH.md](docs/USAGE-GRAPH.md)** — where the "last N days" usage graphs come
  from (local stats, not a server endpoint) and how the history module renders them.
- **[CLAUDE.md](CLAUDE.md)** — working practices for this repo.

## Requirements

Bun 1.3+, a BUSY Bar reachable over USB-Ethernet, the LAN, or the cloud proxy, and
Claude Code signed in (for the monitor). The Grok gauge additionally wants a
`grok login`; without one it simply sits out of the module cycle.
Credential reading is implemented for the macOS Keychain with a file fallback elsewhere.
