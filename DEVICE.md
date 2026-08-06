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

Working example: `bun run src/plasma.ts [seconds]` generates a looping rainbow
plasma, uploads it, and plays it on the front display.

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

## Apps in this repo

| Script | What it does |
|---|---|
| `bun run index.ts` | Connectivity smoke test — prints device status and busy-timer state. |
| `bun run src/monitor.ts` | Shows Claude Code usage limits; rotate the encoder to cycle windows. |
| `bun run src/plasma.ts [seconds]` | Generates, uploads, and plays a looping plasma animation. |
| `bun run src/input.ts` | Prints button, switch, and encoder events from the device live. |
| `bun run src/screenshot.ts [out] [front\|back] [scale]` | Captures a display to PNG (handles the BGR readback). |

### Usage monitor

`src/monitor.ts` reads Claude Code's OAuth usage limits and renders one window at a time
as a labelled percentage plus a progress bar, recolouring by severity (green < 50% <
amber < 80% < red). It redraws every poll with a timeout of 1.5× the interval, so the
display self-clears if the process dies, and Ctrl-C clears it explicitly.

**Rotating the device's encoder cycles through the windows** — `5H`, `7D`, and one per
active model-scoped weekly limit (e.g. `FABLE`). The list is rebuilt on each poll since
the API adds and drops model windows, and the current selection follows its label across
refreshes rather than its index. Draws are serialised so a fast spin cannot interleave
with a poll's redraw.

**Pressing any button refreshes immediately** rather than waiting out the poll interval.
Refreshes fire on `PRESS` only (`RELEASE` would double-trigger) and are gated by
`REFRESH_COOLDOWN_MS` (default 5s); a 429 extends that gate for the whole `Retry-After`
window so a button cannot provoke the rate limit again. Because `BACK` dismisses the
Canvas app (see below), binding refresh to buttons also means a `BACK` press redraws
within ~1s instead of leaving the display blank until the next poll.

> Buttons keep their native device functions as well — depending on device state, `OK`
> and `START` can start a BUSY session. That is the device's own behaviour, not something
> the monitor triggers, but it is worth knowing before you reach over and tap `OK`.

Usage data comes from `GET https://api.anthropic.com/api/oauth/usage` with an
`anthropic-beta: oauth-2025-04-20` header, authorised by the OAuth token Claude Code
stores in the macOS Keychain (`~/.claude/.credentials.json` elsewhere). `src/usage.ts`
is a port of [ai-token-monitor](https://github.com/)'s `src-tauri/src/oauth_usage.rs`.
Notable details inherited from it:

- A Keychain service can hold several items, some carrying only `mcpOAuth` and no usable
  token — try multiple account candidates and accept only an item yielding `claudeAiOauth`.
- Claude Code v2.1.52+ uses a hashed service name, `Claude Code-credentials-{hash}`.
- Token refresh is delegated to `claude auth status --json` rather than reimplementing
  the OAuth exchange.
- `resets_at` is `null` on windows with no scheduled reset — it must be optional.
- Per-model weekly limits now arrive as active `weekly_scoped` entries in the `limits`
  array (with `scope.model.display_name`); the legacy `seven_day_sonnet` / `seven_day_opus`
  keys return `null`.

Env: `BUSY_BAR_ADDR`, `BUSY_PRIORITY` (default 50), `POLL_INTERVAL_MS` (default 300000).

## Library gotchas

- Status sub-objects (`device`, `firmware`, `power`, `system`) are typed optional —
  use optional chaining.
- Animation elements require explicit `await_previous_end` and `opacity` in TS
  even though the API defaults them.
- `AssetsUpload` accepts `data: Buffer | Blob | File | ArrayBuffer` (no `Uint8Array`).
- A draw is rejected with `{"error":"Not drawn due to low priority"}` when another
  Canvas app already holds the display at an equal-or-higher priority — clear that app
  (`DELETE /api/display/draw?application_name=...`) or draw at a higher priority.
