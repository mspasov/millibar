# Claude Code usage limits — undocumented API

How `src/usage.ts` reads your own Claude Code usage limits: the same data the interactive
`/usage` panel shows. Verified working 2026-08-06 against Claude Code v2.1.223.

There is no CLI flag and no public documentation for this. The official answer is that
usage is visible only through the interactive `/usage` panel, your account settings on
claude.ai, or — for API-key customers — the Analytics API in the Console. The endpoint
below is what Claude Code itself calls.

## The endpoint

```
GET https://api.anthropic.com/api/oauth/usage
Authorization: Bearer <oauth access token>
anthropic-beta: oauth-2025-04-20
```

Both the `/api/oauth/` path prefix and the beta header are required. **Do not guess the
path** — `/v1/usage` and `/account/usage` both return 404, which makes it look like no such
endpoint exists.

## Credentials

Claude Code stores an OAuth token that this endpoint accepts.

- **macOS**: Keychain, service `Claude Code-credentials`. Read with
  `security find-generic-password -s "Claude Code-credentials" -w`.
- **Elsewhere**: `~/.claude/.credentials.json` (or `$CLAUDE_CONFIG_DIR`).

The token lives at `claudeAiOauth.accessToken`, with expiry at `claudeAiOauth.expiresAt`.

Three things make naive lookups fail, all learned from
[ai-token-monitor](https://github.com/)'s `src-tauri/src/oauth_usage.rs`, which is the
reference implementation this port follows:

- **One service can hold several items.** Some carry only `mcpOAuth` and no usable token.
  Try multiple account candidates and accept only an item that actually yields
  `claudeAiOauth` — otherwise the lookup lands on a tokenless item and reports failure.
- **Claude Code v2.1.52+ uses a hashed service name**, `Claude Code-credentials-{hash}`.
  Discover it rather than assuming the legacy name.
- **The Keychain payload may have a leading non-JSON byte.** Strip before parsing.

Refresh is best delegated to the CLI — run `claude auth status --json` and re-read the
stored credentials — rather than reimplementing the OAuth exchange with private client
details.

### Handling the token

It is a live credential. Never print it, never write it to disk, and never pass it as a
command-line argument, where `ps` would expose it to every user on the machine. Read it,
use it, keep it in memory.

## Response shape

```jsonc
{
  "five_hour":  { "utilization": 7,  "resets_at": "2026-08-07T00:50:00Z" },
  "seven_day":  { "utilization": 6,  "resets_at": "2026-08-10T11:00:00Z" },
  "seven_day_sonnet": null,          // legacy per-model keys are null now
  "seven_day_opus":   null,
  "limits": [
    { "kind": "session",        "percent": 4, "is_active": false, "scope": null },
    { "kind": "weekly_all",     "percent": 6, "is_active": false, "scope": null },
    { "kind": "weekly_scoped",  "percent": 9, "is_active": true,
      "resets_at": "2026-08-10T10:59:59Z",
      "scope": { "model": { "display_name": "Fable" } } }
  ],
  "extra_usage": { "is_enabled": true, "monthly_limit": 17000, "used_credits": 0,
                   "currency": "EUR", "decimal_places": 2 },
  "spend": { "used": { "amount_minor": 0, "currency": "EUR", "exponent": 2 }, "…": "…" }
}
```

**Granularity is 1%.** `utilization` and `percent` are integers — every observed value
(2026-08-06/07, dozens of samples) has been whole, and no field carries a finer-grained
alternative: the per-window `limit_dollars`/`used_dollars`/`remaining_dollars` fields and
`extra_usage.utilization` are null on a subscription plan, and `spend` only moves once
paid extra-usage credits are being consumed. One percent of the 5-hour window is ±3
minutes of time-budget; finer than that requires counting tokens locally (OTEL metrics or
the transcript JSONL), which yields tokens but not percent-of-limit — the denominators
are not disclosed. Windows also carry `group` and `severity` fields, and `scope` has a
`surface` key (null so far).

Parsing notes, each of which has broken a real implementation:

- **`resets_at` is nullable.** A window at 0% utilisation reports `null`. A non-optional
  type here fails the *entire* parse, which empties the cache and surfaces a misleading
  "usage unavailable" rather than a parse error.
- **Per-model limits moved.** They now arrive as `weekly_scoped` entries in the `limits`
  array carrying `scope.model.display_name`; the dedicated `seven_day_<model>` keys return
  `null`.
- **`is_active` is not a render filter.** It marks whichever *single* limit currently
  binds — observed across two days flipping from the Fable entry (at 9%, the highest
  utilization) to the session entry (tied at 10%, session wins ties) while all three
  entries stayed present. Filtering model windows on `is_active: true` makes them vanish
  whenever another limit overtakes them, which is exactly how it broke here. A window
  that stops applying disappears from the array instead.
- **`limits` may be absent** on older payloads or some accounts. Default it to empty rather
  than failing.
- **Ignore unknown keys.** The response carries several null-valued codename placeholders
  (`tangelo`, `iguana_necktie`, `nimbus_quill`, `cinder_cove`, `amber_ladder`,
  `omelette_promotional`, …) that come and go.
- **Money is in minor units.** `monthly_limit: 17000` with `decimal_places: 2` is €170.00.

## Rate limiting

The endpoint returns **429 with a `Retry-After` header**, and it is easy to hit while
iterating — repeated manual refreshes during testing triggered a 60-second back-off. Honour
`Retry-After` in full rather than retrying on your normal interval, and gate any
user-triggered refresh behind the same window so a button press cannot provoke it again.

A sensible polling cadence is 5 minutes, which is what the monitor and ai-token-monitor
both use.

## Example

Minimal read, token never leaving memory:

```ts
import { fetchUsage } from './src/usage';

const usage = await fetchUsage();
console.log(usage.fiveHour?.utilization, usage.fiveHour?.resetsAt);
for (const model of usage.models) console.log(model.model, model.utilization);
```

`fetchUsage()` throws `NoCredentialsError` when Claude Code is not signed in and
`RateLimitError` (carrying `retryAfterSeconds`) on a 429.
