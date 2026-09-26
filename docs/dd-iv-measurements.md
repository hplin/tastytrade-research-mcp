# Double Diagonal IV measurements

Contract `1.0.0` produces research-only Double Diagonal IV evidence without
changing `SPX-SPREAD-V1`, `DD_RELAXED_SURFACE_V1`, live readiness, frozen
grades, frozen candidate legs, routing thresholds, fills, or P&L.

The implementation is intentionally separate from the legacy production
`term_structure` field:

- every result has `grading_role: RESEARCH_ONLY`;
- every result has `legacy_term_structure_replaced: false`;
- selected-leg, matched-delta, and matched-forward-moneyness measurements use
  different deterministic cohort IDs; and
- no grading bucket, threshold, router rule, or outcome field is accepted or
  emitted.

Contract and profile versions are independent constants:

| Field | Version |
| --- | --- |
| DD IV measurement contract | `1.0.0` |
| DD IV measurement profile | `1.0.0` |
| Reproducible handoff dataset | `1.0.0` |
| Legacy preservation record | `1.0.0` |

Version `1.0.0` implements both `MATCHED_DELTA` and
`MATCHED_FORWARD_MONEYNESS`. Every rule declares its basis and coordinate
convention; neither basis is inferred from the other.

## MCP handoff surface

The existing `tastytrade_get_historical_spx_candidate_universe` tool accepts
an optional `dd_iv_measurement` object. The server still exposes exactly 17
tools.

The request freezes:

- one candidate ID;
- exactly four distinct source symbols and roles:
  `FRONT_PUT_SHORT`, `FRONT_CALL_SHORT`, `BACK_PUT_LONG`, and
  `BACK_CALL_LONG`;
- each leg's expiration, side, and strike;
- a versioned measurement profile; and
- each matched-coordinate rule's front/back expiration, side, target,
  convention, tolerance, missing policy, temporal-skew limit, and optional
  interpolation rule.

All four selected legs must lie inside the requested universe's expiration,
side, and strike grid. The adapter never reselects them. A missing exact
symbol remains a frozen leg with null observations and explicit warnings.

Example profile:

```json
{
  "contract_version": "1.0.0",
  "candidate_id": "dd-2026-08-25-0730-pt",
  "selected_legs": [
    {
      "role": "FRONT_PUT_SHORT",
      "source_symbol": "SPXW  260915P07425000",
      "expiration": "2026-09-15T20:00:00Z",
      "option_side": "PUT",
      "strike": "7425"
    },
    {
      "role": "FRONT_CALL_SHORT",
      "source_symbol": "SPXW  260915C07900000",
      "expiration": "2026-09-15T20:00:00Z",
      "option_side": "CALL",
      "strike": "7900"
    },
    {
      "role": "BACK_PUT_LONG",
      "source_symbol": "SPXW  260929P07475000",
      "expiration": "2026-09-29T20:00:00Z",
      "option_side": "PUT",
      "strike": "7475"
    },
    {
      "role": "BACK_CALL_LONG",
      "source_symbol": "SPXW  260929C07850000",
      "expiration": "2026-09-29T20:00:00Z",
      "option_side": "CALL",
      "strike": "7850"
    }
  ],
  "measurement_profile": {
    "profile_version": "1.0.0",
    "selected_leg": {
      "max_front_back_skew_ms": 900000,
      "combined": {
        "aggregation": "WEIGHTED_ARITHMETIC_MEAN",
        "put_weight": "0.5",
        "call_weight": "0.5"
      }
    },
    "matched_coordinates": [
      {
        "measurement_id": "put-25d",
        "measurement_basis": "MATCHED_DELTA",
        "front_expiration": "2026-09-15T20:00:00Z",
        "back_expiration": "2026-09-29T20:00:00Z",
        "option_side": "PUT",
        "target_delta": "25",
        "delta_convention": "ABSOLUTE_FORWARD_DELTA_PERCENT",
        "tolerance": "1",
        "missing_policy": "NOT_AVAILABLE",
        "max_front_back_skew_ms": 900000
      },
      {
        "measurement_id": "put-atm-forward-moneyness",
        "measurement_basis": "MATCHED_FORWARD_MONEYNESS",
        "front_expiration": "2026-09-15T20:00:00Z",
        "back_expiration": "2026-09-29T20:00:00Z",
        "option_side": "PUT",
        "target_log_moneyness": "0",
        "moneyness_convention": "LN_STRIKE_OVER_FORWARD",
        "tolerance": "0.005",
        "missing_policy": "NOT_AVAILABLE",
        "max_front_back_skew_ms": 900000
      }
    ]
  }
}
```

## `SELECTED_LEG_IV_DIFFERENCE`

The selected-leg basis computes `back IV - front IV` separately for PUT and
CALL. It preserves the exact four frozen legs and, for every leg:

- IV and delta;
- provider-observed versus derived origin;
- IV, delta, and forward model names and assumptions;
- forward value and source timestamp when delta is derived;
- bar start, end, availability, retrieval, completeness, freshness, and
  front/back skew;
- source symbol and candidate ID;
- provider, dataset, resolution, alignment, and source cohort; and
- field-level lineage and warnings.

A combined value is emitted only when the profile predeclares
`WEIGHTED_ARITHMETIC_MEAN` and both weights. PUT and CALL component spreads
remain next to the combined result. Opposing signs add
`SELECTED_LEG_SIDE_SPREADS_HAVE_OPPOSING_SIGNS` and
`COMBINED_VALUE_RETAINS_EXPLICIT_OPPOSING_SIDE_COMPONENTS`; the aggregate
never hides the divergence.

## `MATCHED_DELTA` and `MATCHED_FORWARD_MONEYNESS`

Each matched rule filters observations to the exact requested side and
front/back expirations. `MATCHED_DELTA` compares delta under the declared
convention:

- `SIGNED_FORWARD_DELTA_PERCENT`; or
- `ABSOLUTE_FORWARD_DELTA_PERCENT`.

`MATCHED_FORWARD_MONEYNESS` compares
`ln(K/F)` under `LN_STRIKE_OVER_FORWARD`, using each expiration's
timestamp-safe forward and rounding the derived coordinate to 12 decimal
places. The forward value, model, assumptions, source timestamp, strike, and
lineage remain attached to every input.

Direct selection is deterministic: minimum absolute coordinate error, then
source symbol. IV is never a tie-breaker. A contract is accepted only when
its error is within the declared tolerance. Otherwise the result is
`NOT_AVAILABLE`, with the nearest achieved coordinate, basis-specific error,
coverage gap beyond tolerance, source strike, and source symbol retained for
coverage analysis.

The output preserves the coordinate definition, target and achieved
coordinates, coordinate and basis-specific errors, source strikes, source
symbols, delta when available, IV origin, models, forward assumptions,
timing, lineage, and source cohort. The spread is calculated only when both
sides are available, share a source cohort, and satisfy the declared
front/back skew limit.

## Interpolation

The default is no interpolation. It is enabled only by a profile containing:

```json
{
  "allowed": true,
  "method": "LINEAR_BY_DELTA",
  "max_bracket_width": "10",
  "max_bracket_skew_ms": 600000
}
```

Forward-moneyness profiles use the otherwise identical bounded rule with
`method: LINEAR_BY_LOG_MONEYNESS`.

The normalizer then requires one eligible point strictly below and one
strictly above the target. Both must:

- use the same expiration, option side, provider, dataset, resolution,
  alignment, and source cohort;
- have complete, fresh bars;
- have IV, the basis-required delta or forward, and lineage available no
  later than the checkpoint;
- fit within the declared bracket width; and
- fit within the declared bracket timestamp skew.

The result is marked `DERIVED` and preserves both input points, coordinates,
IVs, strikes, symbols, models, lineage, and exact linear weights. There is no
extrapolation, nearest-contract substitution outside tolerance, fabricated
quote, later timestamp, or outcome-dependent source/expiry selection.

## Units

Every side and aggregate reports:

- `iv_unit: DECIMAL`;
- `spread_decimal`; and
- `spread_vol_points = 100 * spread_decimal`.

Exact decimal arithmetic is used. For example:

```text
spread_decimal = 0.005
spread_vol_points = 0.50
```

The sign is always back minus front.

## Timestamp and quality rules

An observation is ineligible when IV or required delta is null/non-finite,
the bar is missing or incomplete, freshness is not `FRESH`, `available_at`
is after the checkpoint, bar availability precedes bar end, forward
provenance is after the checkpoint, or any lineage timestamp is after the
checkpoint.

Unavailable data produces null spreads and warnings; it is never converted
to success-shaped evidence. `retrieved_at` may be later than the checkpoint
because it records collection provenance, not decision availability.

Universe deltas preserve their derivation:

- `BLACK_76_FORWARD_DELTA`;
- `PUT_CALL_PARITY_NO_DISCOUNT_FACTOR` with
  `DISCOUNT_FACTOR_OMITTED`; or
- `SPOT_FORWARD_ZERO_CARRY` with `ZERO_CARRY`.

Provider candle IV remains `PROVIDER_OBSERVATION`; interpolation and delta
reconstruction remain `DERIVED`.

## Legacy preservation

`migrateLegacyDdIvRecord` is schema-version aware. It never guesses whether a
legacy `term_spread_vol_points` value was already decimal, percentage, or
volatility points. For an ambiguous record it returns
`PRESERVED_AMBIGUOUS_LEGACY` and retains:

- the source path;
- declared source schema version;
- SHA-256 of the original file;
- exact raw file contents;
- a cloned raw record; and
- the untouched raw `term_spread_vol_points` value.

`normalized_measurement` remains null, and the source file is not overwritten.
Already-versioned records are also preserved rather than rewritten.

## Reproducible handoff

The deterministic source fixture is
[`test/fixtures/dd-iv-measurement-input-v1.json`](../test/fixtures/dd-iv-measurement-input-v1.json).
The generated handoff is
[`docs/examples/dd-iv-measurement-handoff-v1.json`](./examples/dd-iv-measurement-handoff-v1.json).

When the candidate universe is loaded through the private evidence cache, the
handoff also carries immutable source manifest IDs plus normalized and
provider-payload content IDs. Those IDs participate in `handoff_id`, binding
the measurement to the exact #41 source revision without exposing or copying
the licensed payload. An uncached handoff omits `source_evidence`.

Regenerate and verify it with:

```bash
npm run handoff:dd-iv
npm run handoff:dd-iv:check
```

The example intentionally demonstrates:

- nonzero selected PUT and CALL spreads with opposite signs;
- zero matched PUT spread at a common delta;
- a real `0.005` matched CALL spread reported as `0.50` vol points; and
- matched `ln(K/F)` PUT and CALL measurements; and
- distinct selected and matched cohort IDs.

The artifact names `spx-spread-grading` and `spx-spread-regression` as
consumers but sets `policy_fields_included: false`. Those consumers own
buckets, thresholds, routing sensitivity, horizons, outcomes, and exclusions.
They should join on frozen candidate, regime, IV outlook, resolution, and
horizon; report coverage and exclusions before outcomes; keep provider and
valuation/execution cohorts separate; and retain date overlap, threshold
tuning, missingness, and small-sample limitations. This MCP does not claim a
selection edge or realized win rate/P&L.
