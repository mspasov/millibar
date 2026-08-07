# BUSY Bar — Device Notes

Research and live-test findings for the [BUSY Bar](https://busy.app/) this project controls.
Verified working against the physical device on 2026-08-06.

## What it is

The BUSY Bar ("Busy Status Bar") is an open-source productivity device with a 72×16 LED
pixel front display and a smaller back display. It shows busy statuses, runs a Pomodoro
timer, and supports custom apps. It is controllable over HTTP, MQTT, and BLE.

## Access

| Method | Address | Notes |
|---|---|---|
| Local (USB-Ethernet / LAN) | `http://10.0.4.20` | Default device IP |
| Local hostname | `http://busy.bar/` | Resolves to the same device |
| Remote proxy | `https://api.busy.app` | Requires API token from <https://cloud.busy.app/api-tokens> |

- The device serves its own OpenAPI spec: **`http://10.0.4.20/openapi.yaml`** (~50 endpoints).
- CORS is wide open (`Access-Control-Allow-Origin: *`) — browser apps can call the API directly.
- No HTTP access password is currently configured; the local API is unauthenticated.
  (Can be enabled in the web UI under Settings → HTTP Access.)

## This device

| Field | Value |
|---|---|
| Model | BB.1 |
| Serial | `[serial redacted]` |
| Firmware | 1.1.1 (built 2026-07-29, commit `ac59f45c`) |
| API semver | 25.0.0 |
| Firmware security | secure |

## Official library

[`@busy-app/busy-lib`](https://github.com/busy-app/busylib-ts) (`npm i @busy-app/busy-lib`),
TypeScript, ESM + CJS. Default branch is `dev`. Three modules:

- **`BusyBar`** — typed HTTP client aggregating all API namespaces
  (`System*`, `Display*`, `Audio*`, `Wifi*`, `Storage*`, `Settings*`, `Ble*`, `Input*`,
  `SmartHome*`, `Account*`, `Assets*`, `Time*`, `Update*`).
- **`StateStream`** — real-time device state over WebSocket (`/api/status/ws`), protobuf-encoded.
- **`ScreenRenderer`** — WebGL2 renderer for the 72×16 display.

```ts
import { BusyBar } from '@busy-app/busy-lib';

const bar = new BusyBar({ addr: '10.0.4.20' }); // default addr if omitted
const status = await bar.SystemStatusGet();
```

Official docs: <https://docs.busy.app/bar/dev/http-api> (blocks unauthenticated scripted
fetches — prefer the device-served `openapi.yaml`).

## HTTP API highlights

All endpoints live under `/api/`. Key groups: `status`, `busy/snapshot`,
`busy/profiles/{slot}`, `display/draw`, `display/brightness`, `audio/play`, `audio/volume`,
`storage/*`, `wifi/*`, `time/*`, `update/*`, `smart_home/*`, `ble/*`, `assets/upload`,
`screen`, `input`.

### Status

```sh
curl http://10.0.4.20/api/status    # device, firmware, system, power (battery %, charging)
curl http://10.0.4.20/api/version   # {"api_semver":"25.0.0"}
```

### Busy timer

```sh
curl http://10.0.4.20/api/busy/snapshot          # GET current timer state
curl -X PUT http://10.0.4.20/api/busy/snapshot   # run timer from a given snapshot
```

### Drawing on the display

`POST /api/display/draw` with `{application_name, priority, led_notification_color?, elements[]}`.
Element types: `text`, `image`, `animation`, `countdown`, `rectangle`. Each element takes
`id`, `x`/`y`, `align`, `timeout` (seconds, auto-clears) or `display_until` (unix ts), and
`display: front|back`.

**Priority** (1–100, default 50): a draw is accepted when its priority ≥ the currently
running app's. Built-in apps run at 10; an active BUSY/CUSTOM work session runs at 90 —
so a default-priority draw won't interrupt a focus session.

> **Elements persist by id.** A redraw that simply *omits* a previously drawn element
> leaves it on screen — the element list is merged by id, not replaced. Verified: drawing
> `[a, b]` then redrawing `[a]` leaves both visible. To hide something, redraw it with
> zero alpha (`#RRGGBB00` renders nothing) or clear the whole app with
> `DELETE /api/display/draw?application_name=…`. This bites when an element is drawn
> conditionally: a progress bar omitted at 0% keeps showing its previous width.

> **An id's element type is fixed.** Redrawing an existing id as a *different* type
> (text → rectangle or the reverse) is rejected with `400 {"error":"Bad request"}` —
> and the 400 is **not atomic**: elements earlier in the same request still land, so one
> bad element half-applies a frame. Verified both directions on firmware 1.1.1. To
> retire an element whose id won't be drawn again, re-emit it as-is with its colour
> fields zero-alpha'd (instant), or with `timeout: 1` (works for any type, gone within
> a second). `DisplaySession` in `src/display.ts` does this automatically for ids that
> disappear between consecutive draws.

```sh
# Draw scrolling green text on the front display for 20s
curl -X POST http://10.0.4.20/api/display/draw \
  -H "Content-Type: application/json" \
  -d '{
    "application_name": "my_app",
    "priority": 50,
    "elements": [{
      "id": "t1", "type": "text", "text": "HELLO",
      "font": "normal", "color": "#00FF88FF",
      "align": "center", "x": 36, "y": 8, "width": 72,
      "timeout": 20, "display": "front"
    }]
  }'

# Clear everything drawn by an app
curl -X DELETE "http://10.0.4.20/api/display/draw?application_name=my_app"
```

#### Font metrics (measured)

Both text fonts are variable-width bitmaps with 1px between glyphs. Per-glyph ink
widths, measured from `/api/screen` readbacks (firmware 1.1.1):

- **`small`** — 5px tall; mid-aligned at `y: 5` renders rows 3–7. Caps default to 4px
  with exceptions `I:1`, `M:5`, `W:5`, and `J L T V X Y Z` at 3; digits are 3px (`1` is
  2); `?` 3; `:` and `.` 1.
- **`normal`** — 7px tall; mid-aligned at `y: 5` renders rows 2–8. Digits are all 5px;
  `%` is 7.
- `align: mid_left` puts the first inked column exactly at `x`; `align: mid_right` puts
  the last inked column at `x − 2` (both fonts).

`src/monitor.ts` embeds the small-font table to right-fit its reset countdown between a
variable-width label and the percentage.

### Animations (`.anim` format)

The firmware is open source ([busy-app/busybar-firmware](https://github.com/busy-app/busybar-firmware))
and defines a custom animation container, `bicycle0` — see `lib/anim_file/anim_file_format.h`
and the encoders `scripts/seq2anim.py` / `assets/frontend/util/seq2anim.ts`.
This repo has a TypeScript encoder in [`src/anim.ts`](src/anim.ts).

File layout (all integers little-endian):

- **Header** (36 bytes): signature `bicycle0`, flags u8, width u8, height u8,
  color_format u8 (0 = BGR888, 1 = Gray4, 2 = BGRA8888), fps u8, max_encoded_len u16,
  unused u8, sections_chunk_len u32, frames_chunk_len u32, section_count u32,
  file_frame_count u32, display_frame_count u32.
- **Sections chunk**: per section — start u32, end u32 (display-frame indices),
  frame_offs u32 (file offset of the file frame containing `start`),
  duration_override u8, then a nul-terminated name. A section named `default`
  covering all frames is mandatory.
- **Frames chunk**: per file frame — encoding u8 (0 = raw, 1 = RLE), duration u8
  (number of display frames this file frame covers; identical consecutive frames
  are folded), encoded_len u16, then the data.
- **RLE codec**: opcode with high bit set = verbatim run (low 7 bits = block count,
  blocks follow); otherwise repeat run (opcode = count, one block follows).
  Block = one pixel (3 bytes BGR). Max 127 blocks per opcode.

Playback: upload with `POST /api/assets/upload?application_name=<app>&file=<name>.anim`
(raw binary body), then draw an `animation` element with `path: "<name>.anim"` and the
same `application_name`. Stock animations live in `/ext/apps_assets/shared/animations/`
(e.g. `coding_72x16.anim`) and play via `stock_path: "shared/coding_72x16.anim"`.

**Sections are switchable live.** The animation element takes a `section` name;
`loop: true` loops just that section, and redrawing the same element id with a
different `section` switches with no black frame and no re-upload. One
multi-section file is therefore the right shape for state-driven animations:
pre-render N states as sections, and a state change is a single small draw.
Sections may start mid-way through a folded file frame — `duration_override`
carries the remaining repeat count (see `seq2anim.py` in the firmware repo).
`src/anim.ts` encodes extra named sections; verified live by `src/flame.ts`
(17 sections, ~1.3 MiB, uploads in a few seconds).

Switching behaviour, all verified against `/api/screen` (a wipe test animation
makes playback position readable; flame frames were then matched byte-exact):

- **Every redraw of an animation element restarts its range at the first frame** —
  including a redraw that only changes `opacity`. A many-step opacity fade
  therefore holds the animation near frame 0 for its duration.
- `await_previous_end: false` — switches immediately: new section from frame 0
  while the old one was mid-loop. Visibly jumps.
- `await_previous_end: true` on a looping element — the end of the current loop
  *iteration* counts as the previous range's end, so the running section finishes
  its pass and the new one starts exactly at the wrap (observed …f38, f39 →
  newf0, newf2…). With seams crossfaded and sections content-correlated, the
  switch is indistinguishable from the loop itself.
- Awaited requests **queue serially**: each pending range plays a full loop before
  the next starts, so a burst of N draws stacks ~N loops of latency — pace them
  client-side if you use them.
- Race caveat: an awaited switch that lands within ~a frame of the wrap can cut
  immediately mid-loop instead (seen once across many switches).
- For **instant** seamless switches, encode phase into the sections instead of
  waiting for the wrap: store each state's loop twice back-to-back (a full loop
  entered at any frame is then a contiguous range), emit one section per
  (state, phase), read the current phase by frame-matching one `/api/screen`
  capture, and draw the target state's section at that phase plus ~3 frames of
  capture+draw latency. The switch lands mid-loop in step with what was playing.
  `src/flame.ts` glides between its 16 levels this way, one level per ~150 ms;
  641 sections in a 2.7 MiB file are accepted without complaint, and measured
  step transitions are the size of ~2 ordinary frames of motion.

Two animation elements play simultaneously and composite by `opacity`
(later-drawn on top; output ≈ top·op + bottom·(1−op), e.g. 255 red under a
50-opacity element reads back ≈130) — usable for crossfades, within the
restart-on-redraw caveat above.

`/api/screen` readback matches uploaded frame content byte-exactly (after the BGR
swap), so matching captures against locally rendered frames identifies the exact
display frame playing — the debugging primitive behind all of the above.

Working example: `bun run src/plasma.ts [seconds]` generates a looping rainbow
plasma, uploads it, and plays it on the front display. `bun run src/flame.ts` plays
a fire animation whose intensity the rotary encoder steps through 16 pre-rendered
section levels.

### Status light (the LED on top)

The only exposed control is the `led_notification_color` field on a **draw** request —
there is no dedicated LED endpoint, no LED state in the protobuf stream, and no way to
read the light back:

```json
{ "application_name": "my_app", "led_notification_color": "#00CCFFFF", "elements": [ … ] }
```

It fires the firmware's `StatusLightsPresetNotification`, which is fully specified in
`applications/services/status_lights/presets/blink.c`:

```c
const StatusLightsPresetBase status_lights_preset_notification = {
    .run = blink_run, .period_ms = 500,
    .repeat_count = 6,            // 6 ticks x 500ms -> 3 blinks over ~3s
    .override_brightness = true,  // ignores the display brightness setting
};
```

So **one request gives a fixed ~3-second, 3-blink pulse**. Duration, rate, and pattern are
not parameterisable over HTTP; the firmware has other presets (static colour, fade, blink,
rainbow gradient) but only `notification` is reachable this way.

#### Fading it smoothly

**Alpha does not control LED intensity.** `status_lights_set_output` reads only
`color.r/g/b`, and the notification preset sets `override_brightness = true`, so the
device's own LED brightness is bypassed as well. Intensity therefore comes from scaling
the RGB components themselves (`#00CCFF` at 25% is `#003340`).

Arbitrary fades are still possible because of two firmware details:

1. `status_lights_do_run_preset` frees any running preset and calls `run_pattern`
   **immediately**, and `blink` starts in its on-phase — a new colour applies at once
   rather than on the next 500ms tick.
2. So re-issuing a draw faster than the 500ms period keeps the light continuously lit
   while the colour changes underneath it.

`src/led.ts` drives this: one small draw per frame at ~30fps (measured ~11ms round trip,
all frames accepted). Two things matter for it to look right:

- Apply a perceptual gamma (~2.2) to the ramp. PWM output is linear in the component
  value, so a linear ramp reads as a hard flash at the top and nothing at the bottom.
- **End on `#000000FF`**, otherwise the notification preset keeps blinking the last
  colour for the remainder of its ~3s run. Black blinks black-on-black, i.e. off.

Each frame needs a non-empty `elements` array; a 1×1 fully transparent rectangle works,
since elements merge by id and leave the screen untouched. A draw that *omits*
`led_notification_color` does not disturb a running light, so normal redraws are safe.

```sh
bun run src/led.ts pulse "#00CCFF" 1400 2                 # colour, duration ms, cycles
bun run src/led.ts fade "#FF0000,#00FF00,#0000FF" 3000 hsv  # stops, duration ms, space
```

#### Colour crossfades

`fadeLed()` walks a list of stops, with `loop`, `pingPong`, and a trailing `fadeOutMs`.
Interpolation space matters more than it sounds:

| Space | `#FF0000 → #00FF00` midpoint | |
|---|---|---|
| `rgb` | `#808000` | muddy olive — channels cross through grey |
| `hsv` | `#FFFF00` | vivid yellow — travels the hue wheel |

`hsv` is the default. Two edge cases it has to handle, both easy to get subtly wrong:

- **Hue wrap.** Take the shortest way round the wheel, so `#FF0000 → #FF00FF` (0° → 300°)
  passes through pink at 330° rather than sweeping backwards through every other hue.
- **Degenerate endpoints.** Black and greys have no meaningful hue (and black no
  saturation), so they borrow the other end's. Resolve that borrowing *before* measuring
  hue distance — doing it after leaves the distance based on a hue no longer in play, and
  `#000000 → #00CCFF` sweeps backwards through red, giving a brown midpoint (`#804D40`)
  instead of half-brightness cyan (`#006680`).

Frame rate must stay above ~3fps: a gap longer than the preset's 500ms period lets the
blink show through as a flash.

Set it only on the draw that *starts* an action — putting it on every redraw restarts the
blink each time. A malformed value returns `{"error":"Invalid LED notification color"}`,
which is a handy way to confirm the field is being parsed.

### Input: reading events from the device

`POST /api/input?key=<key>` only **sends** a key event to the device. There is no HTTP
endpoint to read input. Events come back on the **state-stream WebSocket** instead:

```
ws://<addr>/api/status/ws        then send: {"enable": true}
```

Messages are protobuf-encoded `BSB_State.State` (schemas:
[busy-app/busybar-protobuf](https://github.com/busy-app/busybar-protobuf) — `state.proto`,
`input.proto`). Input arrives as `State.updates[].input` (field 11):

| Event | Values |
|---|---|
| `ButtonEvent` | button `OK`/`BACK`/`START`, action `PRESS`/`RELEASE` |
| `SwitchEvent` | position `BUSY`/`CUSTOM`/`OFF`/`APPS`/`SETTINGS` |
| `EncoderEvent` | `delta` (sint32, zigzag-encoded) — the rotary dial |

There is **no encoder-press event**: the protobuf defines exactly the three buttons
above. A physical press of the dial must surface as one of them — assumed `OK`
(unverified; check with `bun run src/input.ts` and press the dial; the monitor's
`SWITCH_BUTTON` env var overrides the assumption).

`bun run src/input.ts` prints these live; `src/input.ts` also exports `listenInput()` and
`decodeInputEvents()`. It decodes only the input field and skips everything else (frames
dominate the stream), so it needs no protobuf runtime. The library's own `StateStream`
decodes everything but runs in a browser Shared Worker.

The `up`/`down` keys map to encoder deltas of +1/−1, and `busy`/`custom`/`off`/`apps`/
`settings` produce switch events.

> **Injected input has real side effects.** `POST /api/input?key=ok` and `key=start` can
> *start a BUSY timer* — observed repeatedly, though not in every device state, so treat
> any injected button as potentially state-changing rather than assuming a rule. Stop a
> running timer by PUTting a `NOT_STARTED` snapshot (`snapshot_timestamp_ms` is required,
> or you get `{"error":"Failed to parse snapshot"}`).

### Display priority and the BACK button

`BACK` dismisses the Canvas app and drops the device to its **stub app**, which renders
nothing — the display goes black but is not powered off. Verified by probing what the
device will accept afterwards:

| Foreground | Draw at priority 1 | Draw at priority 50 |
|---|---|---|
| Canvas app at priority 50 | rejected | rejected |
| After `BACK` | **accepted** | — |

A priority-1 draw succeeding after `BACK` puts the foreground app at priority 0, the
documented stub/poweroff level. Any subsequent draw reclaims the display.

This makes `BACK` look intermittent when it is in fact perfectly consistent: an app that
only redraws occasionally leaves the screen dark until its next draw, so whether you
notice depends entirely on how soon something repaints. Pressing `BACK` again on an
already-blank screen also does nothing visible.

Note also that a same-priority draw from a *different* `application_name` was rejected
while the Canvas app held the display, despite the spec saying equal-priority requests
override.

> **Protobuf parsing trap:** in a hand-rolled reader, `offset += readVarint()` is wrong —
> JavaScript evaluates the left `offset` *before* `readVarint()` advances it, so the skip
> under-advances by the length-prefix size and desyncs the parser on the next tag
> (surfacing as "invalid wire type 3/4/6/7"). The same applies to
> `subarray(offset, offset + readVarint())`. Read the length into a variable first.

### Reading the screen back

`GET /api/screen?display=0|1` (0 = front, 1 = back → 160×80).

> **Two spec quirks, both easy to miss:**
> 1. The spec says `image/bmp`, but the endpoint returns a **base64-encoded raw
>    framebuffer** — 72×16×3 = 3456 bytes for the front display.
> 2. The byte order is **BGR888, not RGB**. Decoding it as RGB silently swaps red and
>    blue, which is easy to miss because greens and greys look unaffected. The official
>    library does the swap in `Global/utils/frameData.ts:bgrToRgba`.
>
> Colours you *send* (`#RRGGBBAA` in draw requests) are ordered as documented — only the
> readback is BGR. `bun run src/screenshot.ts [out.png] [front|back] [scale]` handles this.

### Audio (`.snd` format)

The device has a speaker, driven by `/api/audio/*`:

- `POST /api/audio/play` body `{application_name, path}` (uploaded file) **or**
  `{application_name, stock_path: "shared/<name>.snd"}` — exactly one of the two.
  Returns immediately; playback is asynchronous.
- `DELETE /api/audio/play` stops playback (blocks until the audio service confirms,
  410 if nothing is playing).
- `GET/POST /api/audio/volume` — 0–100 (`?volume=NN`, optional `&silent=1`).

The `.snd` format is **headerless raw PCM: signed 16-bit little-endian, mono,
44100 Hz**. No magic bytes, no metadata — the spec only says "supported formats
include .snd files". Confirmed from the firmware's `scripts/audio.py`, which encodes
with ffmpeg `-acodec pcm_s16le -f s16le -ar 44100 -ac 1` (after normalizing loudness
to −6 LUFS and applying a speaker EQ curve). So: file bytes ÷ 88200 = seconds, and
synthesizing a sound is just filling an `Int16Array`. Keep synthesized peaks around
half of full scale to sit comfortably next to the loudness-normalized stock sounds.

Uploaded audio resolves to `/ext/user_assets/<application_name>/<path>` — the same
directory `POST /api/assets/upload` writes to, so the upload flow is identical to
animations. Stock sounds live in `/ext/apps_assets/shared/sounds/` (currently
`calendar_event_starts.snd`, `calendar_reminder_ends.snd`, `volume_change.snd`);
`stock_path` takes only the last path segment (`shared/volume_change.snd`).

Playback timing (`applications/services/audio/audio.c` in the firmware):

- A play issued while a sound is running does not error and does not overlap: the
  current sound **fades out over ~10ms** and the new file is queued behind it. Only
  one file plays at a time; a burst of play requests ends with just the last one
  audible.
- The amplifier powers down when idle and takes a **100ms holdoff** on power-up
  before the sound starts. Every play from silence therefore lags the request by
  ~100ms plus the HTTP round trip — sounds triggered by physical input (e.g. a
  click per encoder detent) trail the action noticeably, and nothing API-side can
  shorten it. It also caps the effective rate at ~8 sounds/s; throttle client-side
  rather than queueing.

Working examples: `bun run src/chime.ts [freqs-hz...]` synthesizes a two-note chime,
uploads it, and plays it; `bun run src/click.ts` plays a synthesized ~25ms tick on
every rotary-encoder event (`--once` for a single test click).

## Live test performed (2026-08-06)

1. `GET /api/status` → firmware 1.1.1, battery 66% charging, uptime ~21h. ✅
2. `GET /api/busy/snapshot` → timer `NOT_STARTED`. ✅
3. `POST /api/display/draw` → drew "CLAUDE: IT WORKS" in green → `{"result":"OK"}`. ✅
4. `GET /api/screen?display=0` → decoded framebuffer, confirmed the text rendered on the LEDs. ✅
5. `DELETE /api/display/draw?application_name=claude_test` → display cleared. ✅
6. Played stock animation via `stock_path: "shared/coding_72x16.anim"`. ✅
7. Encoded a custom 90-frame plasma `.anim` (src/anim.ts), uploaded via
   `/api/assets/upload`, played it looping on the front display, and confirmed
   via `/api/screen` captures that frames were animating. ✅
8. Streamed input events over the state WebSocket — buttons, mode switch, and encoder,
   confirmed with both injected keys and physical presses. ✅
9. Pulsed and crossfaded the status light. Confirmed visually by the device's owner;
   the light is not observable over the API. ✅
10. (2026-08-07) Played the stock `shared/volume_change.snd` — heard by the device's
    owner — then synthesized a 0.82s two-note chime as raw s16le PCM (src/chime.ts),
    uploaded it, and played it back. ✅

## Where the app-level docs live

This file is device and protocol knowledge only. For what the scripts in this repo do and
how to run them, see [README.md](README.md); for the Claude Code usage endpoint the monitor
reads, see [USAGE-API.md](USAGE-API.md).

## Library gotchas

- Status sub-objects (`device`, `firmware`, `power`, `system`) are typed optional —
  use optional chaining.
- Animation elements require explicit `await_previous_end` and `opacity` in TS
  even though the API defaults them.
- `AssetsUpload` accepts `data: Buffer | Blob | File | ArrayBuffer` (no `Uint8Array`).
- A draw is rejected with `{"error":"Not drawn due to low priority"}` when another
  Canvas app already holds the display at an equal-or-higher priority — clear that app
  (`DELETE /api/display/draw?application_name=...`) or draw at a higher priority.
- **`DisplayDraw` silently drops `led_notification_color`.** The library's `draw()`
  rebuilds the body from only `application_name`, `priority`, and `elements`:

  ```js
  const { application_name, elements, priority = 50 } = params;
  body: { application_name, priority, elements }
  ```

  The field *is* part of its own `DisplayDrawParams` type, so this type-checks and
  compiles cleanly while the status light never fires. `src/monitor.ts` posts draws
  with `fetch` instead (keeping the library's types) — see `displayDraw()` there.
  Worth checking whether other namespaces narrow their bodies the same way; verify with
  a local echo server rather than trusting the types.
