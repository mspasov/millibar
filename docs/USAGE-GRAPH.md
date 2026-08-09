# How Claude renders its "last N days" usage graphs

Findings from reading the Claude Code v2.1.226 binary (the JS bundle is embedded in the
executable and greppable with `rg -a` / `strings`) and the reference implementation in
`~/Development/ai-token-monitor`. Explored 2026-08-09.

## There is no history endpoint

The `/api/oauth/usage` endpoint ([USAGE-API.md](USAGE-API.md)) returns only *current*
window percentages. The full list of `api/oauth/*` paths in the binary contains nothing
else usage-shaped (`profile`, `validate`, `roles`, `settings`, file upload…). Every
usage-over-time graph Claude Code shows is computed **locally from session transcripts**
— which is also exactly what ai-token-monitor does. If we want a history graph, we build
it from local data too; the server won't give it to us.

## Where the graphs live in Claude Code

The settings dialog (`/usage`, `/stats`) has tabs Status / Config / Usage / Stats.

- **Usage tab**: progress bars only, straight from the oauth endpoint. No graph.
- **Stats tab**: the graphs. A date-range selector — `All time · Last 7 days · Last 30
  days` — and two sub-views, Overview and Models.

## The data pipeline

Persistent cache at **`~/.claude/stats-cache.json`** (version 5), incrementally updated
(`lastComputedDate` high-water mark). Shape:

```jsonc
{
  "version": 5,
  "lastComputedDate": "2026-08-06",
  "dailyActivity":    [{ "date": "2026-08-06", "messageCount": 2355, "sessionCount": 7, "toolCallCount": 696 }],
  "dailyModelTokens": [{ "date": "2026-08-06", "tokensByModel": { "claude-fable-5": 114822351, "claude-opus-5": 94749114 } }],
  "modelUsage": { "<model>": { "inputTokens": 0, "outputTokens": 0, "cacheReadInputTokens": 0,
                               "cacheCreationInputTokens": 0, "webSearchRequests": 0, "costUSD": 0 } },
  "totalSessions": 0, "totalMessages": 0, "longestSession": {}, "firstSessionDate": "", "hourCounts": {}
}
```

The scanner walks the session JSONLs under `~/.claude/projects/`, and:

- **mtime-skips** files older than `fromDate` before parsing — that's what keeps the 7d/30d
  recompute cheap.
- Drops sidechain entries (`isSidechain`) except in `subagents/` directories.
- Counts messages, sessions, and `tool_use` blocks per day.
- Sums per-model tokens from assistant `message.usage` as
  **`input + output + cache_read + cache_creation`** — cache tokens included.
  ai-token-monitor uses the identical formula (its cache v3 changelog: "total_tokens now
  includes cache tokens").
- Buckets days by **UTC** (`toISOString().split("T")[0]`). ai-token-monitor buckets by
  *local* date — so the two disagree about which day evening tokens land on.

Range filter: `fromDate = today − (N−1)` for 7d/30d; all-time uses the whole cache.

## Rendering: Overview sub-view

A GitHub-style contribution heatmap, drawn as text:

- 7 rows (Sun–Sat) × `min(52, max(10, terminalWidth − 4))` week columns, ending on the
  current week; month labels above; `Mon/Wed/Fri` row labels.
- Cell glyphs `·  ░ ▒ ▓ █`: zero days get the dot; nonzero days are quantized by
  **percentiles** of the nonzero `messageCount` distribution — ≥p75 → `█`, ≥p50 → `▓`,
  ≥p25 → `▒`, else `░`. Legend: `Less ░ ▒ ▓ █ More`.

Percentile thresholds (not max-relative buckets) are what keep one monster day from
flattening the rest of the graph. ai-token-monitor's heatmaps quantize the same way
(threshold array → 5 heat levels).

## Rendering: Models sub-view ("Tokens per Day")

A line chart via a bundled copy of the **asciichart** library (`plot(series, {height,
colors, format})`):

- Height 8 rows; width targets `min(52, max(20, terminalWidth − 7))` data points.
- One series per **top-3 models** by total tokens, coloured with the theme's
  suggestion/success/warning colours; legend as coloured bullets.
- **If there are fewer days than the target width, each day's value is repeated
  `floor(width / days)` times** to stretch the series — a 7-day range still fills the
  chart. More days than width → `slice(-width)`, i.e. it clips old days rather than
  aggregating.
- Y labels formatted `999k / 1.2M / 1.0B`, padded to 6 chars; x-axis gets 2–4 date
  labels spread along it.

## ai-token-monitor's equivalents (the SVG take)

- **`DailyChart.tsx`** — the "last N days" bar chart, mounted twice: `days={7}` and
  `days={30}`. Iterates `today−(N−1) … today` and fills gaps with 0 (Claude Code's line
  chart instead only plots days present in the cache). Bars scale to the max value,
  with a dashed average line, y ticks at 0/mid/max, hover tooltip, and weekday labels
  that thin out (`i % ceil(days/7)`) when N > 14. Toggles tokens/cost and chart/list.
- **`Heatmap.tsx`** — 12-week GitHub-style heatmap; **`ActivityGraph.tsx`** — full-year
  version with a 3D mode. Both threshold-quantized like Claude Code's.

## On the BUSY Bar

Implemented: `src/stats.ts` reads the cache (entry-wise, defensively — the file is
undocumented and version-gated at `version: 5`), and `src/modules/claude-stats.ts`
renders it as a monitor module — 30-day (1px bars + 1px gaps) and 7-day (8px bars)
windows, each bar max-scaled and stacked bottom-up by the window's top-3 models, with
the remainder as a grey cap. Verified on-device 2026-08-09: ~40 elements per frame
accepted at once, stacked 1px-wide columns read fine.

Two behaviours worth keeping in mind, both inherited from the cache:

- **It only advances when Claude Code itself recomputes** (opening its stats panel);
  three days stale is routine. The module therefore anchors its window at the newest
  *data* day rather than calendar today — trailing calendar days would render as
  false zeroes — and marks the gap (`30D?` + `-3D`).
- **Days are UTC buckets**, so the bar boundaries won't match a local-midnight mental
  model (ai-token-monitor buckets locally and disagrees with Claude Code the same way).

Not built: the heatmap form (7 rows × up to ~52 week columns also fits 72×16, hue or
brightness encoding the percentile bucket) — a natural third view if wanted.
