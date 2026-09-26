# Historical exact-leg option packages

The historical package tools reconstruct research-only SPX package references
from completed DXLink option candles:

- `tastytrade_get_historical_option_package_at_checkpoint`
- `tastytrade_get_historical_option_package_path`

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
availability timestamp, observation age, and provider provenance.

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

Both package tools can pass an `evidence_cache` policy to their underlying
historical-candle requests. Results return the exact source manifest IDs and
content hashes used for valuation. A later run may provide those IDs with
`CACHE_ONLY`; missing or mismatched shards fail the entire replay without a
provider call or undeclared resolution substitution. Changing only execution
references reuses the verified candle objects while producing independent
research-result identity. Full configuration and migration guidance is in
[`evidence-cache.md`](evidence-cache.md).
