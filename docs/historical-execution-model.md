# Caller-frozen historical execution models

`tastytrade_simulate_historical_execution` is a pure deterministic adapter
over the `historical-execution-evidence/1.0.0` handoff. The caller owns
candidate construction, grading, profile selection, study labeling, entry and
exit windows, limits, fees, and horizon policy. The adapter neither selects
the most profitable scenario nor mutates source decisions, forward-paper
events, or broker state.

The result contract is `1.0.0`; see
[`historical-execution-model.schema.json`](historical-execution-model.schema.json).
Artificial DV/CV/IC/DD golden cases are in
[`../test/fixtures/historical-execution-golden.json`](../test/fixtures/historical-execution-golden.json).

## Frozen request

Every run provides:

- run, decision, candidate, candidate fingerprint, grading profile, candidate
  construction profile, measurement basis, and immutable source manifest IDs;
- source provider, dataset, license scope, resolution profile, and revision;
- decision/candidate/profile freeze timestamps and the first outcome-access
  timestamp;
- `IN_SAMPLE` or `OUT_OF_SAMPLE`, plus whether the outcome was previously
  accessed;
- exact entry/exit windows and signed limits;
- one hashed execution profile and an optional hashed fee model; and
- the exact #47 entry and exit handoffs.

The adapter verifies evidence content IDs, inventory identity, candidate
fingerprint, source cohort, manifest set, profile hash, fee hash, and
freeze-before-outcome ordering. A previously inspected sample cannot be
relabeled `OUT_OF_SAMPLE`.

## Signed price convention

The exact frozen inventory from #47 is never reversed or reselected:

- entry buys the frozen inventory and uses signed package ask;
- exit sells the frozen inventory and uses signed package bid;
- positive prices are debits and negative prices are credits; and
- gross P&L is
  `(signed exit receipt - signed entry cost) * multiplier * quantity`.

For example, a credit spread entered at `-2.8` and exited at `-1.1` has
`(+1.7 * multiplier)` gross P&L. No absolute-value conversion is used.

## V1 profiles

All profiles require a positive tick, explicit latency and minimum package
size, `atomic_package: true`, and explicit
`queue_model: NOT_MODELED` / `market_impact_model: NOT_MODELED`.

| Model | Trigger and fill |
| --- | --- |
| `QUOTE_LIMIT_TOUCH` | A valid adverse package side reaches the frozen limit; fill is exactly the limit. The result retains only an observed-point/bounded-interval claim, never continuous first-touch precision. |
| `QUOTE_CROSS` | A valid adverse package side is inside the limit; fill uses that observed side with adverse-direction tick rounding. |
| `QUOTE_PRICE_IMPROVEMENT` | Caller supplies an exact midpoint-to-adverse fraction from 0 through 1 and an additional per-package cost. Entry rounds up and exit rounds down. Fraction 0 is explicitly labeled optimistic. |
| `REFERENCE_COST` | Uses one selected valuation reference plus explicit cost. It is labeled `REFERENCE_MODEL`, never quote-backed, native executable, or broker-verified. |

There is no automatic fallback between native package quotes, aligned
synthetic leg quotes, and reference evidence.

## Status and coverage

- `SIMULATED_FILLED`: both modeled entry and exit filled.
- `NO_FILL_UNDER_MODEL`: complete selected-channel entry coverage exists, but
  no observation satisfies the frozen model.
- `NOT_ASSESSABLE`: entry evidence is missing or incomplete. Sparse no-touch
  windows never become no-fill.
- `OPEN_EXIT_UNRESOLVED`: entry filled, but exit did not fill or cannot be
  assessed.

A positive observed fill may be emitted from an otherwise incomplete window,
with an explicit warning; a negative no-touch conclusion requires complete
coverage for the selected channel. Latency and size failures are counted
separately.

When fees are absent, gross P&L may be available but `net_pnl` remains null.
The V1 fee scope is per contract, per leg, per side, so a four-leg DD charges
all four legs on entry and again on exit.

## V1 limitations

V1 is atomic-package, fixed-horizon simulation. It does not model queue
position, market impact, legging, roll management, or a full campaign. A
fixed-horizon exit ignores observations before `scheduled_exit_at`; it cannot
silently become an opportunistic managed exit. A
Double Diagonal exit window on or after the earliest leg expiration is
rejected rather than valuing only the remaining back-month legs or using SPX
intrinsic value.

Every result has `evidence_class: SIMULATED_EXECUTION`,
`broker_fill_verified: false`, `mutates_live_event: false`, and
`mutates_source_evidence: false`. The existing
`tastytrade_verify_historical_fill` tool remains observed-evidence-only.
