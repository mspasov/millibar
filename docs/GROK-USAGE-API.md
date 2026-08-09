# Grok weekly usage limit — undocumented API

How to read the SuperGrok / Grok Build **shared weekly credit pool** — the same
data the Grok CLI `/usage` panel shows as overall credit usage. Verified working
2026-08-09 against Grok CLI 1.0.0 and a SuperGrok OIDC session.

There is no public xAI doc for this. The official developer console
(`console.x.ai`, Management API) tracks **API prepaid dollars**, not the
consumer weekly pool. The endpoint below is what the Grok CLI itself calls for
`/billing?format=credits`.

**Scope for this project: weekly limit only.** One window: used %, remaining %,
period start, period end (reset). Do not surface monthly envelopes, product
split (`GrokChat` / `GrokBuild`), on-demand caps, or prepaid API balance.

## The endpoint

```
GET https://cli-chat-proxy.grok.com/v1/billing?format=credits
Authorization: Bearer <OIDC access token>
Accept: application/json
```

Optional headers the CLI may send (`User-Agent: grok-cli`,
`x-grok-client-mode: cli`) are not required for a 200 in practice.

**`?format=credits` is required** for the weekly pool. Without it, the same path
returns a **monthly** dollar envelope (`monthlyLimit` / `used` in cents, calendar
month bounds). That is a different product surface; do not use it for the weekly
gauge (community tools that did produced multi-week “reset” countdowns).

### Paths that are not this API

| URL | Result |
|---|---|
| `GET …/v1/billing` (no query) | Monthly envelope — ignore for weekly |
| `GET https://api.x.ai/…/billing` | 404 |
| `GET management-api.x.ai/v1/billing/teams/…` | Needs management key; OIDC → 403; prepaid $ only |
| `POST grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig` | Alternate gRPC-web path used by some UIs; more parsing cost; same idea. Prefer the CLI proxy JSON for this repo. |

## Credentials

Grok CLI stores OIDC credentials after `grok login`.

- **Path**: `~/.grok/auth.json` (override home with `$GROK_HOME` if set: `$GROK_HOME/auth.json`).
- **Shape**: top-level object whose keys are OIDC issuer/client id strings; each
  value is a session entry.

```jsonc
{
  "https://auth.x.ai::<client-id>": {
    "key": "<JWT access token>",
    "auth_mode": "oidc",
    "expires_at": "2026-08-10T01:07:31.167206Z",
    "refresh_token": "…",
    "user_id": "…",
    "team_id": "…",
    "email": "…",
    "oidc_issuer": "https://auth.x.ai",
    "oidc_client_id": "…"
    // …profile fields
  }
}
```

Prefer the entry under `https://auth.x.ai::…` (current SuperGrok OIDC). If
several entries exist, pick a non-expired one that has a non-empty `key`, or the
latest `create_time` / furthest `expires_at`.

- **Access token**: `key` (Bearer for the billing request).
- **Expiry**: `expires_at` (ISO-8601). Observed lifetime ~6 hours after login in
  one sample; treat as short-lived and re-read the file (or refresh) before use.

### Token handling

Same rules as Claude OAuth in [USAGE-API.md](USAGE-API.md): never print the
token, never write it to disk as part of our cache, never pass it as a
command-line argument (`ps` exposure). Read → use in `Authorization` header →
drop.

### Refresh

Do **not** reimplement OIDC with private client secrets if you can avoid it.

Practical options, in order of preference for this repo:

1. **Re-read `auth.json`** each fetch if the file’s `expires_at` is still valid
   (with a small skew, e.g. 1–2 minutes). The user (or another process) may
   refresh via normal `grok` use.
2. **Delegate to the CLI**: if expired / 401, surface a clear error (“run
   `grok login`”) rather than a silent empty bar. Optional later: shell out to
   whatever refresh path the CLI exposes if one is stable.
3. **OIDC refresh** via `auth.x.ai` with `refresh_token` is what OpenUsage-class
   tools do; only add if re-read + login prompt is insufficient. If you write
   tokens back to `auth.json`, do so carefully (atomic write, mode `0600`) —
   concurrent `grok` sessions may rewrite the same file.

## Response shape (weekly)

```jsonc
{
  "config": {
    "creditUsagePercent": 3.0,           // used % of the weekly pool
    "currentPeriod": {
      "type": "USAGE_PERIOD_TYPE_WEEKLY",
      "start": "2026-08-07T06:06:44.567993+00:00",
      "end": "2026-08-14T06:06:44.567993+00:00"   // reset / cycle end
    },
    "billingPeriodStart": "2026-08-07T06:06:44.567993+00:00", // same as currentPeriod.start
    "billingPeriodEnd": "2026-08-14T06:06:44.567993+00:00",   // same as currentPeriod.end
    // --- ignore for weekly-only monitor ---
    "productUsage": [
      { "product": "GrokChat", "usagePercent": 2.0 },
      { "product": "GrokBuild", "usagePercent": 1.0 }
    ],
    "onDemandCap": { "val": 0 },
    "onDemandUsed": { "val": 0 },
    "prepaidBalance": { "val": 0 },
    "isUnifiedBillingUser": true,
    "topUpMethod": "TOP_UP_METHOD_SAVED_PAYMENT_METHOD"
  }
}
```

### Mapping for the monitor

| Concept | Field | Notes |
|---|---|---|
| Used % | `config.creditUsagePercent` | Observed as a float (e.g. `3.0`); treat as number, not assume integer. |
| **Remaining %** | `100 - creditUsagePercent` | Clamp to `[0, 100]` if the API ever overshoots. |
| Cycle start | `config.currentPeriod.start` | **Account-specific**, not calendar Monday / midnight. Do not invent. |
| Reset | `config.currentPeriod.end` | Prefer this over top-level `billingPeriodEnd` (they match when weekly). |
| Window kind | `config.currentPeriod.type` | Expect `USAGE_PERIOD_TYPE_WEEKLY`. |

Suggested TypeScript surface (mirror Claude’s `UsageWindow` where it helps):

```ts
export interface GrokWeeklyUsage {
  /** 0–100, how much of the weekly pool is used */
  usedPercent: number;
  /** 0–100, 100 - usedPercent */
  remainingPercent: number;
  periodStart: string;   // ISO-8601
  resetsAt: string;      // ISO-8601 = period end
  periodType: string;    // e.g. USAGE_PERIOD_TYPE_WEEKLY
  fetchedAt: Date;
}
```

### Parsing notes

- **Weekly only.** If `currentPeriod.type` is missing or not weekly, do not
  pretend it is a weekly window: return null / error, or omit the module. Do
  not fall back to bare `/v1/billing` monthly data.
- **Start is provided.** Unlike Claude’s 5h window (start inferred as
  `resets_at − 5h`), Grok sends `start`. Use it for progress / pace markers.
- **Duration is 7 days** when type is weekly (verified: end − start = 7.0000 d
  on a live account). Still prefer timestamps over hardcoding `7 * 86400`.
- **Ignore** `productUsage`, on-demand, prepaid — they are not the weekly pool
  gauge.
- **Ignore unknown keys** for forward compatibility.
- **No history** on this endpoint: current state only. Token/cost history would
  be local (`~/.grok/logs/…`, sessions) and is out of scope here.

## Credentials file location helper

```ts
function grokAuthPath(): string {
  const home = process.env.GROK_HOME ?? join(homedir(), '.grok');
  return join(home, 'auth.json');
}
```

Mode on disk is typically `0600`. Read with normal file APIs; handle missing
file as `NoCredentialsError` (“run `grok login`”).

## Errors

| HTTP / condition | Behaviour |
|---|---|
| 200 + weekly `currentPeriod` | Success |
| 401 / 403 | Token dead or wrong surface; re-read auth / ask for `grok login`. Do not loop. |
| 404 | Wrong URL (missing `format=credits` or wrong host). |
| 429 | Honour `Retry-After` if present; same discipline as Claude usage (see USAGE-API.md). |
| Network / timeout | Coalesce errors; do not spam the status light. |
| Missing `config` / `creditUsagePercent` / `currentPeriod` | Parse failure — “usage unavailable”, keep last good cache if any. |

## Rate limiting / poll cadence

Not fully characterised. Match Claude usage discipline unless proven safer:

- Share one fetch + TTL across modules (do not let two pollers hit the endpoint).
- Default poll on the order of **minutes**, not seconds.
- User-triggered refresh shares the same cooldown.
- On 429, full `Retry-After` (or a conservative 60s floor).

## Implementation placement (for the implementer)

Follow existing Claude patterns; do not invent a parallel stack.

| Piece | Suggestion |
|---|---|
| Module | `src/grok-usage.ts` (or extend a shared usage module with a clear Grok path) — fetch + parse + credential read only. |
| Wire-in | Through the same host/cache pattern as Claude (`src/usage.ts` + mbar TTL), so two providers do not double-poll. |
| Display | New view/module **alongside** Claude, not replacing it (project convention: new module/screen, never replace). |
| Debug CLI | `import.meta.main` block: `bun run src/grok-usage.ts` prints remaining % and reset only (never the token). |
| Docs | This file; if DEVICE/USAGE behaviour differs later, update here in the same commit. |

### Credential rules for subagents

Same as USAGE-API.md: transcripts persist. Never log the JWT, never put it in
commit messages, never dump `auth.json` in tool output.

## Curl check (manual)

```bash
# Token only in env for the shell session — do not paste into chat/logs.
TOKEN=$(python3 -c '
import json
from pathlib import Path
a = json.loads(Path.home().joinpath(".grok/auth.json").read_text())
print(next(iter(a.values()))["key"])
')

curl -sS \
  -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/json" \
  "https://cli-chat-proxy.grok.com/v1/billing?format=credits" \
| python3 -c '
import sys, json
c = json.load(sys.stdin)["config"]
u = float(c["creditUsagePercent"])
p = c["currentPeriod"]
print(f"used={u}% left={100-u}% start={p[\"start\"]} resets={p[\"end\"]} type={p[\"type\"]}")
'
unset TOKEN
```

Example live read (2026-08-09): **3% used / 97% left**, weekly
`2026-08-07T06:06:44Z` → `2026-08-14T06:06:44Z`.

## Out of scope (do not implement under this doc)

- xAI Management API prepaid balance / daily USD spend
- Monthly `/v1/billing` without `format=credits`
- Per-product `productUsage` bars
- Local session token graphs
- Grok CLI external OpenTelemetry fleet metrics

## References (community; undocumented)

- OpenUsage Grok provider: `GET …/v1/billing?format=credits` as the weekly pool
- CodexBar / Continuum: weekly unified pool since ~June 2026; gRPC-web alternate
  `GetGrokCreditsConfig`; do not treat monthly envelope reset as weekly
- Sibling Claude doc: [USAGE-API.md](USAGE-API.md)
