# Historical exact-leg option packages

The historical package tools reconstruct research-only SPX package references
from completed DXLink option candles:

- `tastytrade_get_historical_option_package_at_checkpoint`
- `tastytrade_get_historical_option_package_path`
- `tastytrade_get_historical_option_package_horizons`

They preserve exact OCC symbols and never use current quotes, future bars, or
Backtester snapshots outside the requested time window.

## Checkpoint valuation

The checkpoint tool accepts an exact 2- or 4-leg package, an `as_of`
timestamp, and explicit research limits:

```json
{
  "request": {
    "family": "DEBIT_VERTICAL",
    "underlying": "SPX",
    "as_of": "2026-08-27T14:30:00Z",
    "legs": [
      {
        "provider_symbol": "SPXW  260924C07750000",
        "action": "BUY_TO_OPEN"
      },
      {
        "provider_symbol": "SPXW  260924C07800000",
        "action": "SELL_TO_OPEN"
      }
    ],
    "max_observation_age_minutes": 30,
    "max_temporal_skew_minutes": 10,
    "resolution_profile": {
      "profile_id": "DEFAULT_5M",
      "profile_version": "1.0.0"
    },
    "candidate_construction_profile": {
      "version": "candidate-construction/7"
    },
    "phase": "REGRESSION_RESEARCH"
  }
}
```

Each leg is parsed from its exact 21-character OCC symbol. The result retains
the provider symbol, derived DXLink streamer symbol, side, strike, expiration,
action, quantity, historical close, IV when present, bar-start timestamp,
availability timestamp, observation age, and provider provenance. Additive
structured fields report `reconstruction_status` and one of:

- `CONTRACT_ABSENT_FROM_RECONSTRUCTED_UNIVERSE`
- `HISTORICAL_CANDLE_UNAVAILABLE`
- `STALE_OBSERVATION`
- `ALIGNMENT_MISMATCH`
- `CACHE_ERROR`
- `PROVIDER_ERROR`

Per-leg provenance includes the lifecycle, full resolution profile, provider
failure reasons, source revision, and exact evidence-cache manifest and
content IDs when present.

`as_of` may be replaced by an unambiguous IANA `local_checkpoint`. The
normalized checkpoint, deterministic request ID, opaque
`candidate_construction_profile`, and full resolution/cohort metadata are
returned. The candidate profile is preserved verbatim; package valuation does
not implement grading, DD buckets, or final leg selection.

DXLink candle timestamps are bar starts. A candle is eligible only when:

```text
available_at <= as_of
```

Observation age is measured from that availability timestamp, not from the bar
start. The package value is calculated with exact decimal arithmetic:

```text
buy close * quantity - sell close * quantity
```

The result is `AVAILABLE` only when every leg has a complete, non-truncated
snapshot, every selected observation is within
`max_observation_age_minutes`, and the leg availability timestamps are within
`max_temporal_skew_minutes`. Otherwise `reference_value` is null and the result
is `NOT_AVAILABLE` with explicit missing, stale, or alignment warnings.

Historical Candle events do not provide bid and ask prices. Therefore:

- `reference_value` is a trade/candle-derived valuation reference;
- `synthetic_mid` and `synthetic_natural` remain null;
- `execution_quality` is `VALUATION_ONLY`;
- `usable_for_execution` is always false.

Reference values additionally carry
`reference_type: CANDLE_REFERENCE` and
`evidence_class: VALUATION_ONLY`.

## Fixed trading-session horizons

The horizon tool accepts up to 50 frozen candidates and a caller-supplied,
strictly increasing list of trading-session dates. It never manufactures a
calendar or assumes that weekdays are sessions. For every candidate,
`entry_date` must occur in that list and the requested session offsets must
exist:

```json
{
  "request": {
    "underlying": "SPX",
    "trading_calendar": {
      "timezone": "America/Los_Angeles",
      "local_time": "07:30",
      "session_dates": [
        "2026-08-25",
        "2026-08-26",
        "2026-08-27",
        "2026-08-28",
        "2026-08-31",
        "2026-09-01"
      ]
    },
    "horizons": [
      "ENTRY",
      "OUTCOME_3_TRADING_DAYS",
      "OUTCOME_5_TRADING_DAYS"
    ],
    "candidates": [
      {
        "candidate_id": "frozen-ic-2026-08-25",
        "family": "IRON_CONDOR",
        "entry_date": "2026-08-25",
        "legs": [
          {
            "role": "LONG_PUT",
            "provider_symbol": "SPXW  260922P07350000",
            "action": "BUY_TO_OPEN",
            "lifecycle": "EXPIRED"
          },
          {
            "role": "SHORT_PUT",
            "provider_symbol": "SPXW  260922P07400000",
            "action": "SELL_TO_OPEN",
            "lifecycle": "EXPIRED"
          },
          {
            "role": "SHORT_CALL",
            "provider_symbol": "SPXW  260922C07900000",
            "action": "SELL_TO_OPEN",
            "lifecycle": "EXPIRED"
          },
          {
            "role": "LONG_CALL",
            "provider_symbol": "SPXW  260922C07950000",
            "action": "BUY_TO_OPEN",
            "lifecycle": "EXPIRED"
          }
        ]
      }
    ],
    "resolution_profile": {
      "profile_id": "HOURLY_PROVIDER_ALIGNED_RESEARCH",
      "profile_version": "1.0.0",
      "max_observation_age_minutes": 120,
      "max_temporal_skew_minutes": 0
    },
    "candidate_construction_profile": {
      "version": "SPX-CANDIDATE-RESEARCH-V1"
    },
    "phase": "REGRESSION_RESEARCH"
  }
}
```

The workflow queries only those frozen symbols at every horizon. It does not
substitute a nearby strike or expiration after outcomes are known.

The aggregate `coverage` object reports requested candidates and checkpoints,
complete entry/+3/+5 packages, missing-leg counts by caller-defined role,
structured missing-reason counts, and coverage grouped by strategy,
expiration, entry DTE, and requested/effective resolution profile. Exact
front/back expirations, including a 21/35-DTE Double Diagonal, are treated as
one immutable four-leg package.

## Optional research model valuation

The horizon tool supports an opt-in `valuation_fallback` for regression
coverage when an exact frozen leg has no historical candle:

```json
{
  "valuation_fallback": {
    "mode": "MODEL_IF_LEG_MISSING",
    "pricing_model": "BLACK_SCHOLES_SPOT",
    "model_version": "1.0.0",
    "source_contract": {
      "provider_id": "local-research-model",
      "dataset_id": "historical-option-package-model-valuation",
      "license_scope_id": "private-research",
      "resolution_profile": {
        "profile_id": "HISTORICAL_OPTION_MODEL_VALUATION",
        "profile_version": "1.0.0",
        "native_resolution": "MODEL_INPUTS",
        "effective_resolution": "MODEL_REFERENCE"
      },
      "source_revision": "black-scholes-spot/1.0.0"
    },
    "annualized_risk_free_rate": "0.04",
    "annualized_dividend_yield": "0.01",
    "volatility_shift_fraction": "0.1",
    "max_input_age_minutes": 120,
    "checkpoints": [
      {
        "session_date": "2026-08-25",
        "underlying": {
          "value": "7800",
          "observed_at": "2026-08-25T13:00:00Z",
          "available_at": "2026-08-25T14:00:00Z",
          "retrieved_at": "2026-08-25T16:00:00Z",
          "source": "approved-historical-source",
          "dataset_id": "spx-underlying",
          "license_scope_id": "private-research",
          "source_revision": "2026-08-25",
          "manifest_ids": ["sha256:<64 lowercase hex characters>"],
          "normalized_content_ids": [
            "sha256:<64 lowercase hex characters>"
          ]
        },
        "leg_inputs": [
          {
            "provider_symbol": "SPXW  260922P07350000",
            "implied_volatility": "0.22",
            "iv_origin": "INTERPOLATED_SURFACE",
            "surface_id": "spxw-surface-2026-08-25-0730",
            "source_symbols": [
              "SPXW  260922P07325000",
              "SPXW  260922P07375000"
            ],
            "observed_at": "2026-08-25T13:00:00Z",
            "available_at": "2026-08-25T14:00:00Z",
            "retrieved_at": "2026-08-25T16:00:00Z",
            "source": "approved-historical-source",
            "dataset_id": "spxw-iv-surface",
            "license_scope_id": "private-research",
            "source_revision": "2026-08-25",
            "manifest_ids": ["sha256:<64 lowercase hex characters>"],
            "normalized_content_ids": [
              "sha256:<64 lowercase hex characters>"
            ]
          }
        ]
      }
    ]
  }
}
```

The caller supplies one checkpoint record for every horizon that may need a
modeled leg. Dates still resolve through the caller's trading-session array;
the model never infers weekdays. Each source must satisfy:

```text
observed_at <= available_at <= scheduled checkpoint <= retrieved_at
scheduled checkpoint - observed_at <= max_input_age_minutes
scheduled checkpoint - available_at <= max_input_age_minutes
```

Malformed, stale, or future-dated model inputs are rejected. The fallback is
eligible only for `HISTORICAL_CANDLE_UNAVAILABLE` and
`CONTRACT_ABSENT_FROM_RECONSTRUCTED_UNIVERSE`. It does not turn
`CACHE_ERROR`, `PROVIDER_ERROR`, `STALE_OBSERVATION`, or
`ALIGNMENT_MISMATCH` into a successful valuation.

The original horizon `status`, `legs`, and strict `package` remain the candle
reconstruction result. When fallback is enabled, the additive `valuation`
object reports:

- `EXACT_PACKAGE_REFERENCE` / `HIGH` when all exact candle values exist;
- `MIXED_OBSERVED_MODELED` / `MEDIUM` when only missing legs are modeled; or
- `MODEL_SURFACE` / `LOW` when all legs are theoretical.

Every valuation leg identifies `OBSERVED`, `MODELED`, or `UNAVAILABLE`.
Observed decimal values are preserved byte-for-byte. Modeled legs retain the
same OCC symbol, action, quantity, strike, expiration, side, DTE, multiplier,
settlement, model/version, SPX input, IV origin/surface, timestamps, source
revision, license scope, manifest IDs, and normalized content IDs.

Black-Scholes spot valuation uses the caller's explicit rate and dividend
assumptions. The central value and the low/high band are rounded to six
decimal places before exact package arithmetic. The band reprices each
modeled leg in two coherent parallel scenarios:
`IV * (1 - volatility_shift_fraction)` and
`IV * (1 + volatility_shift_fraction)`. It is sensitivity metadata, not a
statistical confidence interval. Each normalized input also reports its age
at the checkpoint.

Packages containing a modeled leg use `MODEL_REFERENCE`; exact packages keep
`CANDLE_REFERENCE`. Both remain `VALUATION_ONLY` with
`guaranteed_executable: false`. They are never labeled as a quote, bid/ask,
NBBO, midpoint, historical touch, executable package price, or broker fill.
For opening inventories, `execution_evidence_input` is a complete adapter
payload for `tastytrade_normalize_historical_execution_evidence`. The
resulting model reference may be consumed only by a separately frozen
`REFERENCE_COST` profile. `valuation_fallback.source_contract` is emitted
unchanged for every modeled horizon, so mixed and fully modeled references
can share one frozen downstream source contract while remaining distinct
valuation-basis cohorts.

Valuation coverage is additive to strict coverage and separately reports
valued ENTRY/+3/+5 packages, basis counts, quality counts, and modeled-leg
counts by role.

## Short-window package path

The path tool accepts `1m`, `5m`, `15m`, `30m`, or `1h`. If a requested fine
resolution exhausts the configured local receive, buffer, or output budget, or
DXLink returns a clipped/incomplete snapshot, the tool tries progressively
coarser supported resolutions and records every attempt. It never silently
resamples, and it does not describe a local budget exhaustion as a provider
hard limit.

When no profile is supplied, the historical compatibility fallback order is
preserved. `HOURLY_VALUATION_RESEARCH` is explicit opt-in, requests native
`h` bars aligned to the 09:30 New York regular-session open, and has no
fallback by default. Resolution selection always uses the first provider
available aggregation in the declared order; package values or downstream
outcomes never influence the choice.

A path point is emitted only when every exact leg has a candle with the same
profile-aligned `bar_start`, the full bar was available within the requested
window, and availability skew is within the profile limit. The point preserves
`bar_start`, `bar_end`, `available_at`, and `retrieved_at`; its `as_of` is the
latest leg availability timestamp. Missing or skewed legs produce a structured
`gap`; observations are never interpolated, carried forward, or repaired with
later data.

`fill_verification_path` is shaped for the direct-path mode of
`tastytrade_verify_historical_fill`:

```json
{
  "request": {
    "submitted_at": "2026-08-27T14:30:00Z",
    "valid_until": "2026-08-27T14:50:00Z",
    "working_limit": "21",
    "price_effect": "DEBIT",
    "verification_side": "ENTRY",
    "fill_model": "LIMIT_TOUCH",
    "path": [],
    "evidence_source": "tastytrade-dxlink:historical-option-package{=5m}",
    "references": {
      "checkpoint_id": "spx-2026-08-27-0730-pt"
    }
  }
}
```

Reference-close paths support `LIMIT_TOUCH` research only. They do not support
an executable `CONSERVATIVE_CROSS` claim because historical bid/ask is absent.
The fill verifier retains its legacy `status: NOT_VERIFIABLE` value for
compatibility and also returns
`assessment_status: NOT_ASSESSABLE`.

## 2026-08-27 acceptance finding

The exact 7750C/7800C debit vertical was probed at the 07:30 PT checkpoint:

| Leg | Latest completed 5m source | Available at | Close | Age |
| --- | --- | --- | --- | --- |
| `SPXW  260924C07750000` | `13:35Z` | `13:40Z` | `81.31` | 50m |
| `SPXW  260924C07800000` | `14:05Z` | `14:10Z` | `60.25` | 20m |

The leg skew is 30 minutes. With the issue's example limits of 30-minute age
and 10-minute skew, the checkpoint correctly returns `NOT_AVAILABLE` with
`CHECKPOINT_PACKAGE_STALE` and `TEMPORAL_ALIGNMENT_FAILED`. With explicit
60-minute age and 30-minute skew research limits, it returns a `21.06` debit
reference, still marked valuation-only.

For 07:30-07:50 PT, the bounded 1-minute replay exceeds DXLink's snapshot
limit, so the finest retrievable resolution is explicitly `5m`. The 7750C has
no candle in the window; the 7800C has only a `14:45Z` bar, available at
`14:50Z`. The result therefore contains four exact 5-minute gaps and no
fabricated package points. A fill check is honestly `NOT_ASSESSABLE`
(`status: NOT_VERIFIABLE` for backward compatibility).

Backtester snapshots beginning around 12:45 PT are not used as 07:30 evidence.

## Immutable source manifests

All package tools can pass an `evidence_cache` policy to their underlying
historical-candle requests. Results return the exact source manifest IDs and
content hashes used for valuation. A later run may provide those IDs with
`CACHE_ONLY`; missing or mismatched shards fail the entire replay without a
provider call or undeclared resolution substitution. Changing only execution
references reuses the verified candle objects while producing independent
research-result identity. Full configuration and migration guidance is in
[`evidence-cache.md`](evidence-cache.md).

The horizon workflow accepts the same cache policy but assigns `as_of` and
`evidence_role` separately for each checkpoint. Callers must omit those two
fields; `ENTRY`, `OUTCOME_3_TRADING_DAYS`, and
`OUTCOME_5_TRADING_DAYS` are assigned deterministically.
