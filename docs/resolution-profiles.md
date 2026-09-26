# Versioned resolution profiles

Historical research paths share resolution-profile contract `1.0.0`. The
profile is policy and provenance, not an optimization input: code always
tries the requested aggregation and then any declared fallback aggregations
in order. It never compares returns, grades, fills, or other investment
outcomes to choose a resolution.

## Built-in profiles

| Profile | Requested | Provider native | Session | Alignment | Default use |
| --- | --- | --- | --- | --- | --- |
| `DEFAULT_5M` | `5m` | `5m` | `ALL`, `UTC` | `MIDNIGHT` | Compatibility behavior when no profile is supplied |
| `HOURLY_VALUATION_RESEARCH` | `1h` | `h` | `REGULAR`, `America/New_York`, 09:30-16:00 | `SESSION` | Explicit opt-in SPX valuation research |

The native-hour profile requests DXLink
`{=h,a=s,tho=true}`. At a 07:30 `America/Los_Angeles` checkpoint during
Eastern daylight time, the usable hourly observation is the completed
09:30-10:30 `America/New_York` bar. A bar beginning at 10:30 ET is not
available until 11:30 ET and cannot enter the 10:30 ET decision.

The New York regular-session policy belongs only to the named SPX hourly
profile. Direct candle requests retain their explicit `ALL`, `REGULAR`, or
`CUSTOM` session and IANA timezone; the code does not apply US-equity hours
to every product.

## Input

All historical SPX selector, universe, exact-leg checkpoint, and package-path
requests accept:

```json
{
  "resolution_profile": {
    "profile_id": "HOURLY_VALUATION_RESEARCH",
    "profile_version": "1.0.0",
    "provider_id": "tastytrade-dxlink",
    "max_observation_age_minutes": 60,
    "max_temporal_skew_minutes": 0
  }
}
```

`provider_id` is part of cohort identity. It does not silently switch the MCP
to another adapter. A future provider adapter must pass its own identity so
its requests and results cannot merge with tastytrade DXLink evidence.

When omitted, selector and universe reconstruction retain their prior
five-minute/no-fallback behavior. Checkpoint package valuation retains its
existing ordered `5m -> 15m -> 30m -> 1h` compatibility fallback, and package
paths retain the existing ordered fallback beginning at the requested
resolution. The fully normalized fallback policy is returned and participates
in `cohort_id`, so even two requests with the same profile name but different
limits or fallback rules remain distinct.

`HOURLY_VALUATION_RESEARCH` has no fallback by default. An unavailable hourly
snapshot therefore stays unavailable rather than silently entering the
five-minute cohort.

## Result metadata

Every affected result returns `resolution_profile` with:

- `profile_id`, `profile_version`, and `provider_id`;
- deterministic `cohort_id` and resolution-specific
  `effective_cohort_id`;
- `requested_aggregation`, provider `native_aggregation`, and
  `effective_aggregation`;
- explicit session timezone/hours and alignment;
- maximum observation age and temporal skew;
- ordered fallback policy and
  `FIRST_AVAILABLE_IN_DECLARED_ORDER`.

Request IDs include the normalized profile. A default five-minute request, an
hourly request, and the same profile under another provider identity therefore
produce different request IDs and result cohorts.

## Checkpoint input

Existing RFC3339 `as_of` remains supported. Callers may instead supply exactly
one IANA-local checkpoint:

```json
{
  "local_checkpoint": {
    "local_date": "2026-03-09",
    "local_time": "07:30",
    "timezone": "America/Los_Angeles"
  }
}
```

The normalized result preserves both the local representation and UTC
instant. For the 2026 Pacific transition:

- `2026-03-02 07:30 America/Los_Angeles` is `15:30Z`;
- `2026-03-09 07:30 America/Los_Angeles` is `14:30Z`.

Ambiguous fall-back instants and nonexistent spring-forward instants are
rejected instead of guessed.

## Bar lifecycle

Normalized candles retain legacy `source_time` and add:

- `bar_start`;
- `bar_end`;
- `available_at`; and
- `retrieved_at`.

`source_time` and `bar_start` are identical. The default availability rule is
`bar_end`, while an explicit provider `available_at` is preserved when
present. Decision-time paths require `available_at <= checkpoint`.
`retrieved_at` records collection provenance but is never used to move market
evidence backward in time.

No reconstruction path interpolates, forward-fills, substitutes a later bar,
or changes resolution because one cohort has a better result.

## Candidate-construction profile

Historical selector, universe, checkpoint-package, and package-path requests
accept a JSON object named `candidate_construction_profile`. It must contain a
non-empty `version`; every other field is opaque. The object is included
unchanged in request identity and results. This MCP does not implement or
duplicate grading, Double Diagonal buckets, or final multi-leg selection
rules.

## Live capability gate

Run the bounded seven-date native-hour probe only with authorized credentials:

```bash
npm run live:resolution-gate
```

It checks 07:30 Pacific checkpoints for 2026-03-02, 04-01, 05-01, 06-01,
07-01, 08-03, and 08-25 and emits `SUPPORTED`, `PARTIAL`, `BLOCKED`, or
`NOT_RUN`. Missing credentials or missing provider data are never reported as
a pass.
