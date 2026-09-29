# Level 3 heuristic signed GEX

`tastytrade_compute_heuristic_signed_gex` is a research-only Level 3 model
built on the exact Level 2 unified SPX/SPXW live snapshot. The tool acquires
that snapshot once through `tastytrade_get_live_option_snapshot`'s service
path, preserves its `request_id` and `snapshot_id`, and does not fetch a
second option cohort.

The output is a model result, not observed participant inventory:

```text
HEURISTIC_SIGNED_GEX != DEALER_GEX
HEURISTIC_GAMMA_FLIP != OBSERVED_DEALER_ZERO_GAMMA
OPEN_INTEREST != DEALER_OR_CUSTOMER_POSITIONING
OPTION_FLOW != DEALER_INVENTORY
```

Every result uses:

```text
gamma_evidence_scope = HEURISTIC_SIGNED_MODEL
evidence_role = RESEARCH_ONLY
research_only = true
production_gate_eligible = false
confidence = UNKNOWN
```

The tool does not grade SPX strategies, change DV/CV/IC/DD routing, set Trade
Readiness, or authorize an order.

## Request

The request contains the ordinary unified snapshot request plus an explicit
signing model. Optional spot repricing enables bounded gamma-flip research:

```json
{
  "snapshot_request": {
    "underlying": "SPX",
    "expirations": ["2026-09-29", "2026-09-30"],
    "around_price": "7683.69",
    "strike_count": 50,
    "include_quotes": true,
    "include_greeks": true,
    "include_summary": true,
    "phase": "LIVE_SUPPORT",
    "deadline_ms": 30000,
    "max_temporal_skew_ms": 10000
  },
  "phase": "REGRESSION_RESEARCH",
  "signing_model": {
    "model_id": "CALL_SHORT_PUT_LONG_BASELINE",
    "model_version": "1.0.0"
  },
  "spot_repricing": {
    "pricing_model": "BLACK_SCHOLES_GAMMA",
    "model_version": "1.0.0",
    "annualized_risk_free_rate": "0.04",
    "annualized_dividend_yield": "0.01",
    "minimum_years_to_expiration": "0.0001",
    "spot_range": {
      "minimum": "7000",
      "maximum": "8300",
      "step": "25",
      "root_tolerance": "0.1"
    }
  }
}
```

Greeks and Summary cannot be disabled because Gamma, implied volatility, and
open interest are required inputs. The spot grid is capped at 1,001 points,
`root_tolerance` cannot exceed `step`, and the requested range must include
the snapshot's current spot.

## Explicit signing model

Contract version `1.0.0` supports one baseline hypothesis:

```text
model_id = CALL_SHORT_PUT_LONG_BASELINE
model_version = 1.0.0
CALL -> assigned sign -1
PUT  -> assigned sign +1
```

These signs are assumptions, not detected dealer positions. The complete rule
set, formula, version, and semantic role are serialized in the response and
hashed as `model_hash`. Unsupported model IDs or versions fail closed.

## Current-Gamma signed GEX

The exact-decimal calculation at the snapshot's current spot is:

```text
signed_gex_i
  = assigned_sign_i
    * abs(snapshot_gamma_i)
    * open_interest_i
    * multiplier_i
    * current_spot^2
    * 0.01
```

This section is labeled:

```text
methodology = CURRENT_GAMMA_SIGNED_GEX
approximation = SNAPSHOT_GAMMA_AT_CURRENT_SPOT
```

It does not pretend that current Gamma remains valid at hypothetical spots.
The response aggregates signed and gross absolute exposure by strike,
expiration, option type, and DTE bucket. Top strikes are ranked by gross
absolute exposure while retaining the signed net value.

Contracts with missing Gamma, OI, multiplier, current-request cohort
confirmation, OI freshness, or Greeks freshness are excluded and counted.
Missing OI is never zero-filled.

## Spot-repriced signed GEX

When `spot_repricing` is supplied, each eligible contract's Gamma is
recalculated at every requested spot with Black-Scholes Gamma:

```text
gamma(S)
  = exp(-qT) * normal_pdf(d1)
    / (S * sigma * sqrt(T))
```

The caller supplies rate, dividend yield, range, step, tolerance, and minimum
time. Implied volatility comes from the same snapshot Greeks event. Because
the live chain exposes integer DTE rather than an authoritative fractional
expiry instant, the model explicitly uses:

```text
T = max(snapshot_dte / 365, minimum_years_to_expiration)
```

This is labeled `SPOT_REPRICED_SIGNED_GEX`, kept separate from the
current-Gamma result, and records the approximation and 15-significant-digit
Gamma rounding policy. Signed-GEX outputs are rounded to six decimal places.
`current_spot_reconciliation` records the snapshot-Gamma total, repriced
total, difference, and ratio at the same spot so regression consumers can
separate repricing-model drift from a positioning change. Contracts with
missing/non-positive IV or missing DTE are excluded and counted.

## Bounded heuristic gamma flip

The tool searches only the caller's inclusive spot range. It evaluates the
caller grid, brackets sign changes, and refines each bracket by bisection
until the caller's spot tolerance is reached. It never extrapolates.
Zero-net grid points count as roots only when non-zero gross exposure is
bracketed by opposite signs. Zero-gross underflow regions are recorded as a
warning and never become gamma-flip candidates.

Statuses are:

- `AVAILABLE`: at least one bounded crossing was found with complete
  repricing coverage;
- `NOT_FOUND_IN_RANGE`: complete coverage produced no crossing in the
  requested range;
- `PARTIAL`: a crossing or no-crossing observation used an incomplete
  repriced cohort; or
- `NOT_COMPUTABLE`: repricing was not requested, no contract was eligible,
  or signed GEX was identically zero across the range.

`candidate_levels` preserves all bounded crossings in ascending order.
`level` is the crossing nearest current spot, with the lower crossing used as
a deterministic tie-break. Levels are quantized to the caller's root
tolerance. `current_spot_distance` and its percentage are included for
regression analysis. A heuristic level is never an authoritative dealer
zero-gamma level.

## Identity and reproducibility

`result_id` hashes:

- the exact Level 2 `snapshot_id`;
- the serialized signing-model hash;
- the research phase; and
- every normalized repricing assumption and range.

The output also contains a compact `regression_record`. Persist the full
`source_snapshot` returned beside the Level 3 result when evaluating
incremental value against future realized ranges or strategy outcomes. It is
the exact in-memory snapshot used by the model, not a second fetch. Repeated
calculations with the same snapshot and normalized assumptions produce the
same model and result identities.

## Optional flow context

Option Time & Sales or aggressor-side flow is not required by the Level 3
core and is not added here. If a separate flow module is introduced later,
it may describe observed buying or selling pressure only. It must not infer
dealer/customer identity or inventory.

## Opt-in live integration gate

The live gate requires explicit snapshot and repricing inputs:

```bash
TASTYTRADE_LIVE_OPTION_EXPIRATIONS=2026-09-29,2026-09-30 \
TASTYTRADE_LIVE_OPTION_AROUND_PRICE=7683.69 \
TASTYTRADE_LIVE_OPTION_STRIKE_COUNT=25 \
TASTYTRADE_HEURISTIC_GEX_SPOT_MINIMUM=7000 \
TASTYTRADE_HEURISTIC_GEX_SPOT_MAXIMUM=8300 \
TASTYTRADE_HEURISTIC_GEX_SPOT_STEP=25 \
TASTYTRADE_HEURISTIC_GEX_ROOT_TOLERANCE=0.1 \
TASTYTRADE_HEURISTIC_GEX_RISK_FREE_RATE=0.04 \
TASTYTRADE_HEURISTIC_GEX_DIVIDEND_YIELD=0.01 \
TASTYTRADE_HEURISTIC_GEX_MINIMUM_YEARS=0.0001 \
npm run live:heuristic-signed-gex
```

The gate passes only when the Level 2 unsigned snapshot, current-Gamma
heuristic, and spot-repriced heuristic are complete. A bounded
`NOT_FOUND_IN_RANGE` is a valid gamma-flip outcome; partial or non-computable
repricing fails the gate. The emitted JSON contains market data and model
evidence but no credentials or DXLink token.
