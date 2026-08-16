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
  what was actually there. Injected switch keys genuinely change the device's mode
  (`key=apps` opens the real menu); `key=off` returns it. A started session can also fire
  the user's smart-home automations (`trigger_smart_home` in the snapshot) — the blast
  radius reaches past the device.
- **The display is a shared resource.** Only one app holds it at a time. A test script that
  draws at a higher priority will steal the screen (probing over a running monitor needs
  `MBAR_PRIORITY=51`), and clearing that script leaves the screen blank. An app that drew
  once does not come back on its own; the resident monitor does — next heartbeat (≤60 s)
  or any button press. Clean up with `DELETE /api/display/draw?application_name=…`.
- **Don't leave background processes running** across a task without saying so. Long-running
  scripts hold the display.
- **The user's own `mbar` is often resident** — and it runs the code it started with, so a
  fix is never "verified" by looking at the device until *they* restart it (their call, not
  yours; say it once and move on). Stale instances accumulate silently — check
  `ps aux | grep mbar` before device work; four have been found running at once. The user
  may also be physically operating the device mid-test: before debugging anomalous input
  events, re-run with the device untouched.
- **Uploaded assets persist.** An experiment that uploads under a throwaway
  `application_name` leaves `/ext/user_assets/<app>` behind — remove it (`remove()` in
  `src/store.ts`) when done.
- **The usage API rate-limits.** Iterating on the monitor will hit a 429 and back off for a
  minute. Budget for it; don't work around it by polling harder. Host behaviour (input
  routing, the quit prompt, the switch pause) needs no usage fetches at all — `runHost`
  with a stub module exercises it against real hardware.

## The working tree is shared too

Two or three Claude sessions routinely work in this tree at once, alongside the user's
own uncommitted edits.

- Re-read a file immediately before editing it — files change on disk mid-task.
- Commit only your own work, one commit per logical change, staged file-by-file. When a
  peer's edits share a file, stage a mine-only version, commit, restore the combined
  state. If in doubt that the committed subset stands alone, prove it in a throwaway
  worktree (`git worktree add … HEAD` → check → test → remove).
- The remote (`github.com/mspasov/millibar`) is public. Never push unless the user asks
  in that session — a push publishes every commit on the branch, including peers' work
  you can't vouch for. History was scrubbed once before first publish (a device serial);
  anything secret-shaped in a commit means stop and ask before it goes anywhere near
  `origin`.
- Verify a peer session's claims yourself before relaying them. And a subagent's prompt
  must carry the credential rules (USAGE-API.md, "Handling the token") — transcripts
  persist on disk, and a delegated agent once printed a live token into one.

## Verify on the wire, not in the type system

The one rule worth internalising. The library's types are not evidence that a request
does what you think:

`busy-lib`'s `DisplayDraw` accepts `led_notification_color` in its `DisplayDrawParams`
type, then rebuilds the request body from only `{application_name, priority, elements}` —
silently dropping the field. It type-checked, compiled, returned 200, and the light never
came on. Confirming the firmware parses the field and that the types accept it proved
nothing about the middle.

So when something doesn't work, or before claiming it does:

- **HTTP bodies** → point `MBAR_ADDR` at a local `Bun.serve()` echo server and print
  what actually arrives. Note the client does a `GET /api/version` handshake first and
  requires `api_semver` in the reply.
- **Display output** → `bun run tools/screenshot.ts`, and read the PNG. Lit-pixel counts are
  a quick assertion (`263` → `275` proved the three refresh dots appeared).
- **Transient display states** → poll `/api/screen` in a tight loop and keep the frame that
  shows what you're after; a 300ms indicator is otherwise unobservable.
- **Timings** → observation is load: continuous `/api/screen` polling delayed an
  animation's start by 200–400ms that a light 60ms cadence didn't. Sample as slowly as
  the question allows, and distrust latencies measured under a tight loop.
- **Pure logic** (colour mixing, encoders, parsers) → stub `fetch` and assert on the values.
  This caught a hue-interpolation bug before it ever reached hardware. Binary encoders
  want a round-trip through an independently written reference decoder — playing the
  output proves little. And animation tests with `sweepMs: 0` cannot tell a snap from a
  sweep; that blind spot shipped a real bug.
- **Failure paths** → `MBAR_ADDR=127.0.0.1:9` (a dead port) exercises reconnect
  loops, back-off, and error coalescing in seconds, no device needed. Note `mbar`
  retries dead routes forever by design — kill or timeout such an invocation.
- **Firmware behaviour** → the open-source firmware
  (github.com/busy-app/busybar-firmware) is the reference of record when the API is
  ambiguous: the status-light preset timings and the `.anim` format came from reading
  it, not probing.
- **The status light** → not observable. No endpoint, no state stream, not in the
  framebuffer. **Ask the user.** Don't assert it works.

If you cannot observe something, say so plainly rather than implying it was verified.

Three habits with receipts: check the user's sibling projects (`~/Development/…`) before
concluding a capability doesn't exist — the usage endpoint was found in one after being
declared impossible. Probe a firmware ceiling before designing against it — the
100-element cap forced a full rewrite of the first history module. And when a bug
contradicts DEVICE.md, suspect the doc too: its first commit shipped a wrong RGB claim.

## Known traps

Full detail in DEVICE.md; these are the ones that bite hardest.

- **The firmware acts on input *after* emitting the event.** A draw fired in immediate
  reaction to a button or switch event races the device's own response to that same event
  — BACK's blank and the mode-switch screens both land tens of ms later and wipe it. Wait
  out the settle first (`BACK_SETTLE_MS`, `SWITCH_RESUME_MS`).
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
- **Never glue a scheme onto an address.** `MBAR_ADDR` may be a full URL; use
  `httpBase()`/`wsBase()` (src/config.ts). Hand-prepending once produced `ws://http://…`
  — the monitor drew fine and silently lost all button input.
- **Every numeric env var goes through `envNumber()`** (src/config.ts). A malformed value
  makes `setTimeout(fn, NaN)` fire in ~1 ms and poisons the 429 hold too
  (`Math.max(retryAfter, NaN)` is NaN) — a hot loop straight into the rate limiter.
- **Shell state does not persist between Bash calls** (fish): an env var set in one call
  is gone in the next — a scratch `MBAR_CONFIG` set that way once let a test overwrite
  the user's real `~/.config/mbar/config.json`. Tests never touch real user state:
  `cachePath: null`, scratch `MBAR_CONFIG`.

## Conventions

- Bun, not Node: `bun <file>`, `bun install`, `bun test`, `bunx`. `.env` loads automatically.
- Prefer built-ins (`Bun.serve`, `WebSocket`, `Bun.file`) over dependencies.
- `bun run check` (tsc) and `bun test` before committing. Commit messages carry the
  discovery and the why in the body, not just a summary line. (The user sometimes says
  "master" for `main`.)
- `src/` is anything you can import, `tools/` anything you only run, `docs/` anything you
  only read; `tools/` may import `../src`, never the reverse. Moves use `git mv`, and a
  refactor re-points DEVICE.md's `src/*.ts` references.
- New capability goes into `mbar` as a subcommand, not a separate tool (the user
  has said so twice). New views are added alongside existing ones — a separate screen or
  module — never by replacing what's there. Vocabulary: *module* = what the dial
  switches, *screen* = what the encoder cycles, *window* = a rate-limit period.
- "Ask questions" or "propose a way" means exactly that: stop and present options before
  implementing. Visual work starts as a proposal or a driveable bench the user runs
  (`--preview`/`--demo`, like tools/sweep.ts); they tune timing by feel in short rounds.
  Anything dial-driven keeps feedback under ~200 ms — responsiveness beats smoothness.
- `import.meta.main` guards every script's CLI block; data-source modules keep a
  standalone debug entrypoint (`bun run src/usage.ts --raw`). Logging follows src/log.ts:
  `HH:MM:SS [scope]`, coalesced repeats, an explicit recovery line, log decisions rather
  than events — and routine degradation (a 429 back-off) never alarms the status light.
- Before claiming a name (CLI, package, repo), search GitHub, npm, Homebrew, and PyPI in
  one pass — `busy` and `barkeep` both turned out taken.
- Every script reaches the device through `src/connection.ts` (persistent route config,
  probing, credentials — `mbar probe` to inspect). `MBAR_ADDR` still overrides
  everything, unprobed and verbatim, and every script works without it. Wire-level
  tests get this for free: `stubFetch()` points `MBAR_ADDR` at itself.
- Comments explain *why* — a firmware constraint, a spec inaccuracy, an ordering
  requirement. The code already says what it does.
- When you learn something about the device that isn't in DEVICE.md, add it there in the
  same commit. That file is the reason later work is fast.
