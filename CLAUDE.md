# Working in this repo

Controls a BUSY Bar (physical LED device) from Bun/TypeScript. See [README.md](README.md)
for what the apps do, [DEVICE.md](docs/DEVICE.md) for hardware and HTTP API knowledge, and
[USAGE-API.md](docs/USAGE-API.md) for the Claude Code usage endpoint.

**Read DEVICE.md before writing device code.** It documents a dozen behaviours that are
absent from — or contradicted by — the device's own OpenAPI spec, each of which cost real
debugging time to find.

## The device is real, shared, and stateful

Changes here have physical effects on hardware someone is using. That makes a few things
non-negotiable.

- **Injected input has side effects.** `POST /api/input?key=ok` or `key=start` can start a
  BUSY work session, depending on device state. If you start one, stop it: `PUT
  /api/busy/snapshot` with `{"snapshot":{"type":"NOT_STARTED", …}, "snapshot_timestamp_ms": …}`
  (the timestamp is required). Read the snapshot *before* you experiment so you can restore
  what was actually there.
- **The display is a shared resource.** Only one app holds it at a time. A test script that
  draws at a higher priority will steal the screen, and clearing that script leaves the
  screen blank — the previous app does not come back on its own. Clean up with
  `DELETE /api/display/draw?application_name=…`.
- **Don't leave background processes running** across a task without saying so. Long-running
  scripts hold the display.
- **The usage API rate-limits.** Iterating on the monitor will hit a 429 and back off for a
  minute. Budget for it; don't work around it by polling harder.

## Verify on the wire, not in the type system

The one rule worth internalising. The library's types are not evidence that a request
does what you think:

`busy-lib`'s `DisplayDraw` accepts `led_notification_color` in its `DisplayDrawParams`
type, then rebuilds the request body from only `{application_name, priority, elements}` —
silently dropping the field. It type-checked, compiled, returned 200, and the light never
came on. Confirming the firmware parses the field and that the types accept it proved
nothing about the middle.

So when something doesn't work, or before claiming it does:

- **HTTP bodies** → point `BUSY_BAR_ADDR` at a local `Bun.serve()` echo server and print
  what actually arrives. Note the client does a `GET /api/version` handshake first and
  requires `api_semver` in the reply.
- **Display output** → `bun run tools/screenshot.ts`, and read the PNG. Lit-pixel counts are
  a quick assertion (`263` → `275` proved the three refresh dots appeared).
- **Transient display states** → poll `/api/screen` in a tight loop and keep the frame that
  shows what you're after; a 300ms indicator is otherwise unobservable.
- **Pure logic** (colour mixing, encoders, parsers) → stub `fetch` and assert on the values.
  This caught a hue-interpolation bug before it ever reached hardware.
- **The status light** → not observable. No endpoint, no state stream, not in the
  framebuffer. **Ask the user.** Don't assert it works.

If you cannot observe something, say so plainly rather than implying it was verified.

## Known traps

Full detail in DEVICE.md; these are the ones that bite hardest.

- **Screen readback is BGR**, not RGB. Decoding it as RGB swaps red and blue — and greens
  and greys look fine, so it passes a casual glance. Colours you *send* are `#RRGGBBAA` as
  documented; only the readback is reversed.
- **Display elements persist by id.** A redraw that omits an element leaves it on screen.
  Hide with zero alpha (`#RRGGBB00`); never by omission. Conditionally-drawn elements are a
  recurring bug source.
- **`offset += readVarint()` is wrong in JavaScript.** The left operand is evaluated before
  the call advances the offset, so the skip under-advances and the parser desyncs. Same for
  `subarray(offset, offset + readVarint())`. Read the length into a variable first. This
  produced both a crash *and*, in a later "fix", silently zeroed values.
- **Alpha does not control LED intensity** — only `r/g/b` are read. Scale the components.

## Conventions

- Bun, not Node: `bun <file>`, `bun install`, `bun test`, `bunx`. `.env` loads automatically.
- Prefer built-ins (`Bun.serve`, `WebSocket`, `Bun.file`) over dependencies.
- `bunx tsc --noEmit` before committing.
- Every script reaches the device through `src/connection.ts` (persistent route config,
  probing, credentials — `mbar probe` to inspect). `BUSY_BAR_ADDR` still overrides
  everything, unprobed and verbatim, and every script works without it. Wire-level
  tests get this for free: `stubFetch()` points `BUSY_BAR_ADDR` at itself.
- Comments explain *why* — a firmware constraint, a spec inaccuracy, an ordering
  requirement. The code already says what it does.
- When you learn something about the device that isn't in DEVICE.md, add it there in the
  same commit. That file is the reason later work is fast.
