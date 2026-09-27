# Historical SPX candidate discovery

`tastytrade_discover_historical_spx_candidates` provides timestamp-safe,
selector-based SPX contract discovery for `REGRESSION_RESEARCH`. It supports
arbitrary historical checkpoints, including 07:30 PT, without using option
evidence observed after `as_of`.

The tool returns `HISTORICAL_SELECTOR_CANDIDATE_SET`, not a full historical
option chain. It uses two provider-faithful paths:

1. deterministic SPXW reconstruction from completed DXLink candles for
   `DELTA` and `PERCENTAGE_OTM`; and
2. exact-timestamp Backtester selection as a fallback.

If neither path has sufficient timestamp-safe evidence, the selector fails
closed.

## Provider capability findings

Verified against the tastytrade OpenAPI definitions and live provider probes:

| Provider surface | Verified capability | Limitation |
| --- | --- | --- |
| `GET /option-chains/{symbol}` | Current equity-option instrument chain and symbology | No documented historical `as_of` parameter |
| `GET /market-data/by-type` | Current quotes for known symbols | No documented historical quote timestamp |
| DXLink historical `Candle` | Historical SPX and known SPXW option OHLCV, IV, and OI | Requires the symbol to be known; it does not enumerate a historical chain |
| `POST /backtests` | Historical selection by delta, percentage OTM, current-price offset, premium, and DTE | Documented `EntryConditions` has no time-of-day field |
| `GET /backtests/{id}/logs` | Live responses expose selected side, strike, expiration, fill price, and provider `internalSymbol` | Identity fields are undocumented and accepted only at an exact checkpoint timestamp |
| `POST /simulate-trade` | Accepts recovered provider symbols and generated SPXW OCC symbols | Historical snapshots are available only at provider sampling times, not every arbitrary checkpoint |

The Backtester accepted an undocumented request field:

```json
{
  "entryConditions": {
    "frequency": "every day",
    "entryTime": "14:30:00Z"
  }
}
```

It silently ignored `entryTime`; the 2026-08-25 SPX trial still opened at
`2026-08-25T19:45:00Z` (12:45 PT), after the requested 07:30 PT checkpoint.
The adapter never sends or trusts this field. The sanitized observation is in
[`test/fixtures/spx-candidate-entry-time-ignored-2026-08-25.json`](../test/fixtures/spx-candidate-entry-time-ignored-2026-08-25.json).

## Deterministic Path B reconstruction

For each request, the reconstruction path:

1. Retrieves the latest completed `SPX` candle under the normalized resolution
   profile. The omitted-profile default remains 5 minutes. A candle is usable
   only when its explicit `available_at <= as_of`.
2. Builds eligible SPXW PM expiration dates from the requested calendar DTE.
   A weekday target uses that exact expiration date; a weekend target uses
   the nearest eligible weekdays inside the requested DTE range.
3. Builds a bounded 5-point strike ladder:
   - `PERCENTAGE_OTM` centers the ladder on the requested spot-relative
     strike.
   - `DELTA` uses the SPX candle IV only to center a wider ladder. The final
     contract is selected from contract-specific historical evidence.
4. Adds paired call/put parity anchors around SPX spot.
5. Constructs documented SPXW OCC and streamer symbols, then retrieves the
   candidate-discovery candles in batches of at most 100 symbols. The
   standalone bounded-universe tool retains its 20-symbol batches.
6. Keeps only complete bars available by `as_of` and inside the profile's
   maximum observation age. Contract existence is inferred only when DXLink
   returns historical evidence for that exact generated symbol.
7. Reconstructs an expiration-specific forward from a call and put at the
   same strike and candle timestamp:

   ```text
   F = K + call_close - put_close
   ```

   The calculation intentionally omits a discount factor because no separate
   historical rates source is introduced. This limitation is explicit in the
   output warnings.
8. Reconstructs contract delta with the contract candle IV and a
   Black-76-style forward delta:

   ```text
   d1 = (ln(F / K) + 0.5 * sigma^2 * T) / (sigma * sqrt(T))
   call_delta = N(d1)
   put_delta = N(d1) - 1
   ```

9. Selects deterministically by selector error, observation age, requested
   expiration distance, then strike.

The bounded universe is not represented as a full historical chain. Missing
IV, missing timestamp-aligned parity, stale observations, incomplete bars, or
provider snapshot failures cannot be replaced by future or current data.

`CURRENT_PRICE_OFFSET` and `PREMIUM` remain eligible for the exact-timestamp
Backtester fallback. They are not success-shaped by the reconstruction path.

## MCP input

```json
{
  "request": {
    "underlying": "SPX",
    "as_of": "2026-08-25T14:30:00Z",
    "min_dte": 21,
    "max_dte": 35,
    "sides": ["CALL", "PUT"],
    "selector_grid": [
      {
        "method": "DELTA",
        "value": 20,
        "days_until_expiration": 28
      },
      {
        "method": "PERCENTAGE_OTM",
        "value": 0.01,
        "days_until_expiration": 28
      }
    ],
    "lookback_calendar_days": 0,
    "resolution_profile": {
      "profile_id": "HOURLY_VALUATION_RESEARCH",
      "profile_version": "1.0.0",
      "max_observation_age_minutes": 60,
      "max_temporal_skew_minutes": 0
    },
    "candidate_construction_profile": {
      "version": "candidate-construction/7"
    },
    "phase": "REGRESSION_RESEARCH",
    "references": {
      "checkpoint_id": "spx-2026-08-25-0730-pt"
    }
  }
}
```

The selector/side cross-product is capped at 12 attempts.

`as_of` may be replaced by `local_checkpoint` with `local_date`,
`local_time`, and an IANA `timezone`. Ambiguous and nonexistent local times
are rejected. Omitting `resolution_profile` preserves the existing 5-minute
cohort; native-hour New York RTH reconstruction requires the explicit
`HOURLY_VALUATION_RESEARCH` profile.

`candidate_construction_profile` is returned unchanged and contributes to the
request ID. Its grading, bucket, and final selection fields are not
interpreted by this MCP.

## Date-range discovery

`tastytrade_discover_historical_spx_candidates_range` coordinates the same
single-checkpoint discovery contract across an explicit trading calendar. It
does not infer weekdays or exchange holidays. The caller supplies every
eligible session:

```json
{
  "request": {
    "underlying": "SPX",
    "start_date": "2026-08-03",
    "end_date": "2026-08-31",
    "trading_calendar": {
      "timezone": "America/Los_Angeles",
      "local_time": "07:30",
      "session_dates": [
        "2026-08-03",
        "2026-08-04",
        "2026-08-05",
        "2026-08-06",
        "2026-08-07"
      ]
    },
    "min_dte": 21,
    "max_dte": 35,
    "sides": ["CALL", "PUT"],
    "selector_grid": [
      {
        "method": "DELTA",
        "value": 20,
        "days_until_expiration": 21
      },
      {
        "method": "PERCENTAGE_OTM",
        "value": 0.01,
        "days_until_expiration": 21
      }
    ],
    "resolution_profile": {
      "profile_id": "HOURLY_PROVIDER_ALIGNED_RESEARCH",
      "profile_version": "1.0.0"
    },
    "candidate_construction_profile": {
      "version": "SPX-CANDIDATE-RESEARCH-V1"
    },
    "phase": "REGRESSION_RESEARCH",
    "max_concurrency": 2,
    "checkpoint_deadline_ms": 60000,
    "max_checkpoints_per_run": 25,
    "retry_policy": {
      "max_attempts": 2,
      "backoff_ms": 250
    },
    "evidence_cache": {
      "mode": "READ_WRITE",
      "dataset_id": "dxlink-candles"
    }
  }
}
```

The date bounds select from `trading_calendar.session_dates`; an empty
intersection is invalid. Session dates must be unique and strictly
increasing. Each selected local checkpoint is resolved before provider work
begins, so ambiguous or nonexistent local times fail the whole input without
discarding provider evidence from an already-started run.

The range coordinator:

- runs at most four checkpoint workers and at most 50 checkpoints per
  invocation;
- applies one hard deadline to the complete reconstruction/Backtester retry
  sequence for each checkpoint; its abort signal is operational metadata and
  does not enter immutable candle-cache fingerprints;
- retries only timeout or rate-limit failures, up to three attempts;
- emits checkpoint results in calendar order even when workers complete out
  of order;
- schedules every never-attempted session before deferred retries, then
  rotates unresolved retries to the queue tail for deterministic round-robin
  fairness across continuation calls;
- preserves the complete single-checkpoint result unchanged under each
  checkpoint;
- reports `AVAILABLE`, `PARTIAL`, `NOT_AVAILABLE`, `PROVIDER_TIMEOUT`,
  `PROVIDER_RATE_LIMIT`, `PROVIDER_ERROR`, or `CACHE_ERROR`;
- aggregates selector coverage by DTE and side, failure counts, retries, and
  immutable-cache summaries; and
- reports how many checkpoints were fully served from cache or required
  provider access.

Each checkpoint also returns lightweight `diagnostics`. The fixed stage list
distinguishes `CACHE_LOOKUP`, `PROVIDER_BOOTSTRAP`, `CONTRACT_UNIVERSE`,
`CANDLE_RECONSTRUCTION`, and `SELECTOR_EVALUATION`, with status, cumulative
duration, and operation count for each stage. `timeout_stage` identifies the
most specific active or failed stage when a deadline expires, including
`BEFORE_CACHE_LOOKUP` when provider work never began. A provider timeout
returned as a completed selector attempt is attributed to
`SELECTOR_EVALUATION`, including after an earlier retry failed in another
stage.
`selector_attempts_started` records the normalized selector identities that
reached evaluation. Range coverage counts those starts even if the deadline
interrupts the single-checkpoint call before it can return its normal
`attempts` array.

Cache and provider diagnostics are emitted outside the immutable candle
request. They do not alter request fingerprints. A cache hit completes
`CACHE_LOOKUP` without starting `PROVIDER_BOOTSTRAP`; a source fetch starts
`PROVIDER_BOOTSTRAP` only after the cache elects to call the provider.

The logical `request_id` includes the normalized date range, complete
calendar, resolved checkpoints, selector/DTE configuration, resolution and
candidate-construction profiles, and references. It intentionally excludes
worker count, deadline, retry tuning, invocation limit, and continuation
state.

When work remains, `continuation` contains an opaque integrity-checked cursor,
the completed session dates, the complete scheduling-order list of unresolved
dates, and separate `unattempted_session_dates` and
`deferred_session_dates` queues. Supply the cursor unchanged as
`continuation_cursor` with the same logical request. Completed checkpoints are
not called again. A retryable checkpoint remains unresolved and moves to the
tail of the deferred queue; deferred work begins only after the first-pass
queue is empty and then rotates round-robin.

New cursors use the v2 opaque format. Existing v1 cursors remain accepted and
their pending dates are treated as unattempted once, allowing a formerly
head-blocked cursor to classify failures into the deferred queue and advance.
Cursor integrity, logical-request binding, date partition validation, and
first-pass calendar ordering remain fail-closed. The logical request ID and
immutable candle fingerprints do not include cursor version or queue state.

Results from a resumed invocation are incremental: retain the completed
checkpoint payloads from earlier responses and append the newly completed
payloads. `progress.checkpoints_unattempted` and
`progress.checkpoints_awaiting_retry` expose the post-invocation queue counts;
the existing completed, deferred-this-run, and remaining counts retain their
prior meanings. Changing a logical input causes cursor validation to fail.

`evidence_cache.as_of` and `evidence_cache.evidence_role` are assigned per
checkpoint and therefore cannot be supplied at range level. `CACHE_ONLY`
continues to forbid Backtester fallback. Exact manifest fingerprints and
single-checkpoint anti-lookahead rules are unchanged.

## 2026-08 range acceptance

The 2026-09-27 live acceptance submitted all 21 explicit sessions from
2026-08-03 through 2026-08-31 as one logical batch at 07:30
`America/Los_Angeles`. It requested CALL and PUT Delta-20 and 1%-OTM
selectors at 21, 28, and 35 DTE: 252 selector attempts.

The first `READ_WRITE` invocation preserved 169 reconstructed candidates and
returned three `AVAILABLE` plus 18 `PARTIAL` checkpoints. Five checkpoints
were terminal; the other 16 retained their partial evidence and continuation
state after Backtester returned HTTP 429. Continuation rounds attempted only
those 16 unresolved dates and did not repeat the five completed dates.

The immutable candle evidence then replayed all 21 sessions in one
`CACHE_ONLY` invocation:

- all 21 checkpoints completed with no continuation;
- the same three `AVAILABLE`, 18 `PARTIAL`, and 169 candidates were retained;
- 399 exact cache requests were hits and 399 provider calls were avoided;
- no candle-provider or Backtester call occurred; and
- all 21 checkpoints reported fully cache-served with zero requiring provider
  access.

The private manifests and full acceptance payload remain outside the
repository.

### Pre-selector timeout acceptance

The 2026-09-27 #70 validation used the exact six-Delta selector grid for both
CALL and PUT at 21, 28, and 35 DTE with a 15-second checkpoint deadline.

- A fresh-cache 2026-08-24 request completed in 9,069 ms. It made one
  underlying request plus five option batches of 100, 100, 100, 100, and 46
  symbols, started all 12 selectors, and returned eight candidates with no
  timeout.
- A fresh-cache 2026-08-03 request completed in 8,881 ms. Its option batches
  were 100, 100, 100, 100, and 40 symbols; all 12 selectors started, eight
  candidates were returned, and no timeout occurred.
- The frozen 2026-08-24 single-checkpoint and one-session range results had
  the same request identity, selector attempts, contracts, profiles,
  warnings, and anti-lookahead semantics. The cached range call completed in
  1,305 ms with `timeout_stage: null`.

The full 21-session August run kept one logical request ID across continuation
rounds and never repeated a completed checkpoint. Backtester HTTP 429s were
isolated after selector evaluation; immutable candle evidence was retained,
and unresolved checkpoints were finalized through the existing `CACHE_ONLY`
path, which forbids Backtester fallback. The final full-month replay reported:

- 21 completed checkpoints with no continuation;
- all 252 selector attempts started and completed;
- 159 reconstructed candidates;
- four `AVAILABLE`, 16 `PARTIAL`, and one `NOT_AVAILABLE` checkpoint;
- 126 immutable manifests;
- no pre-selector timeout; and
- all 21 checkpoints fully served from cache with zero candle-provider or
  Backtester calls.

## 2026-08-25 07:30 PT validation

The live four-selector smoke test completed without creating Backtester jobs:

| Side | Selector | OCC/provider symbol | Strike | Price | Reconstructed delta | Observation age |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| CALL | Delta 20 | `SPXW  260922C07900000` | 7900 | 24.52 | 18.766569 | 30 minutes |
| CALL | 1% OTM | `SPXW  260922C07740000` | 7740 | 82.09 | 42.642850 | 40 minutes |
| PUT | Delta 20 | `SPXW  260922P07425000` | 7425 | 38.50 | -20.712880 | 35 minutes |
| PUT | 1% OTM | `SPXW  260922P07590000` | 7590 | 71.58 | -35.884120 | 20 minutes |

All four candidates have:

- `selected_at = 2026-08-25T14:30:00.000Z`;
- exact expiration `2026-09-22T20:00:00.000Z`;
- exact SPXW OCC identity used for `provider_symbol`,
  `simulation_symbol`, and `occ_symbol`;
- no provenance timestamp after `as_of`; and
- `RECONSTRUCTED_CANDIDATE_FOUND` with no Backtester job ID.

The fixture is captured in
[`test/fixtures/spx-candidate-path-b-2026-08-25.json`](../test/fixtures/spx-candidate-path-b-2026-08-25.json).

## Normalized output

`status` is:

- `COMPLETE` when every requested selector/side has price, price effect, and
  selected historical delta;
- `PARTIAL` when at least one exact candidate is available but the requested
  set or enrichment is incomplete; or
- `NOT_AVAILABLE` when no timestamp-safe candidate can be recovered.

Each reconstructed contract preserves:

- generated-and-evidence-validated SPXW OCC identity;
- expiration, strike, option side, requested selector, and DTE;
- `selected_at`, which is always the requested checkpoint;
- `bar_start`, `bar_end`, `available_at`, and `retrieved_at`;
- the latest usable option close and contract IV;
- interval volume and open interest when DXLink supplies them;
- reconstructed historical delta;
- checkpoint SPX close;
- observation age relative to `as_of`;
- field-level source timestamps and provenance; and
- explicit confidence and limitation warnings.

The option observation can precede `selected_at`. Its availability timestamp
is retained in provenance, while `observation_age_ms` makes the staleness
explicit.

Capability semantics:

- `deterministic_checkpoint_reconstruction` means at least one returned
  candidate came from Path B.
- `historical_contract_universe_reconstructed` means a bounded generated
  universe was validated with historical DXLink evidence.
- `exact_leg_simulation` means the exact returned identifier is accepted by
  `/simulate-trade`.
- `exact_checkpoint_simulation` is separate. It is `false` for reconstructed
  07:30 candidates because Backtester does not expose an exact 07:30
  simulation snapshot.

The live `SPXW  260922C07900000` identifier was accepted by
`/simulate-trade` at the provider-supported `2026-08-25T19:45:00Z` sample.
Candidate discovery does not use that later snapshot.

## Anti-lookahead behavior

1. Every candle must be complete by `as_of`; a bar starting exactly at
   `as_of` is excluded.
2. Option observations older than the profile limit are excluded.
3. Contract price and IV come from the same option candle.
4. Delta requires a call/put parity pair inside the profile's temporal-skew
   limit; the default limit remains zero.
5. Future DXLink candles never enter the candidate universe or selector.
6. Backtester trials and opening orders must both equal `as_of`; stale and
   future trials remain excluded.
7. Current chain, quote, Greek, or IV values never fill historical fields.
8. Raw future closes, P/L, and outcome fields never enter candidate output.
9. Candidate discovery and forward outcome simulation remain separate
   phases.

## Remaining limitations

| Field | Status |
| --- | --- |
| Full historical chain | Not available; only a bounded deterministic universe is reconstructed |
| Historical bid/ask | Not available |
| Contract candle IV | Available when the option candle supplies it |
| ATM IV surface | Not available |
| Skew | Not available |
| Term structure | Not available |
| Interval volume | Available when the option candle supplies it |
| Open interest | Available when the option candle supplies it |
| Exact arbitrary-time `/simulate-trade` snapshot | Not available |

`surface.atm_iv`, `surface.skew`, and `surface.term_structure` remain `null`.
Aggregate selector backtests remain discovery evidence only and must never be
reported as exact-leg replay, execution evidence, win rate, expectancy, or
P/L.

`spx-spread-historical-replay` may freeze the returned exact symbols at the
checkpoint. Forward analysis must then use only future evidence in a separate
phase and must preserve whether the provider path is exact checkpoint
simulation or historical-candle evidence.

## Source-cache boundary

Candidate discovery may use the private immutable source cache only with the
`ENTRY` evidence role. `OUTCOME_3_TRADING_DAYS` and
`OUTCOME_5_TRADING_DAYS` are rejected at the selector boundary, so forward
outcomes cannot influence entry reconstruction. Exact offline replay and
manifest handling are documented in
[`evidence-cache.md`](evidence-cache.md).
