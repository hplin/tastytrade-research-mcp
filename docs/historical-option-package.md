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
    "phase": "REGRESSION_RESEARCH"
  }
}
```

Each leg is parsed from its exact 21-character OCC symbol. The result retains
the provider symbol, derived DXLink streamer symbol, side, strike, expiration,
action, quantity, historical close, IV when present, bar-start timestamp,
availability timestamp, observation age, and provider provenance.

DXLink candle timestamps are bar starts. A candle is eligible only when:

```text
source_timestamp + interval <= as_of
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

A path point is emitted only when every exact leg has a candle with the same
bar-start timestamp and the full bar was available within the requested
window. The point's `as_of` is the bar availability timestamp. Missing legs
produce a structured `gap`; observations are never interpolated, carried
forward, or repaired with later data.

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
