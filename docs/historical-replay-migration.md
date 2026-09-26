# Historical replay migration

## Existing consumers

Keep existing candidate grading, package valuation, historical fill
verification, and paper simulation outputs unchanged. The replay builder is a
new local-only report layer; it does not replace any of those contracts.

## Handoff sequence

1. Freeze baseline and research policy outputs before outcome retrieval.
2. Carry the full candidate decision universe, not only candidates accepted by
   the production policy.
3. Convert licensed exact-leg observations through the historical execution
   evidence contract.
4. Produce immutable simulation results under separately hashed optimistic,
   baseline, and stress profiles.
5. Keep raw references `VALUATION_ONLY`; if a frozen `REFERENCE_COST` model is
   run, keep its `SIMULATED_EXECUTION` output in a distinct
   `REFERENCE_MODEL` scenario.
6. Submit the complete matrix to
   `tastytrade_build_historical_replay_report`.

Consumers should key report rows by `group_id` and source records by
`record_id`. They must not merge rows across source group, evidence strength,
profile hash, fee hash, or horizon.

## Regression fields

Use each group's `gross` and `net` metric blocks directly. The
`closed_position_denominator` excludes no-fill, not-assessable, open, missing,
and valuation-only records. Treat a null metric as unavailable, not zero.

Use `missing_data` for coverage reporting and `execution_sensitivity` to flag
conclusion changes across execution assumptions. Do not turn sensitivity into
automatic winner selection or a grading change.

`drawdown.metric=CLOSE_SEQUENCE_DRAWDOWN` is explicitly non-MTM.
`account_return` is intentionally null without a frozen capital, concurrency,
and sizing policy.

## Fail-closed migration rules

Reject the replay rather than adapting old data when:

- a candidate, record, profile, fee, simulation, or source hash conflicts;
- a required candidate × scenario × horizon cell is missing;
- core scenarios use different manifests or source contracts;
- the simulation horizon differs from the candidate's frozen exit;
- a reference observation is relabeled as quote-backed execution;
- later selector fallback is enabled; or
- `DD_RELAXED_SURFACE_V1` is labeled as a mild-only change.

The V1 report never writes live state, monthly paper files, or brokerage
orders. Roll management, side-specific DD exits, portfolio MTM drawdown, and
account return require a future versioned contract.
