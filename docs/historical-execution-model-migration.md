# Historical execution model migration

## From observed fill verification

Do not replace `tastytrade_verify_historical_fill`. It answers whether an
observed historical path touched a threshold and preserves its existing
`TOUCHED`, `NOT_TOUCHED`, and `NOT_VERIFIABLE` contract.

Use `tastytrade_simulate_historical_execution` only for a separately frozen
model result. Store both IDs when both forms of evidence exist; never overwrite
the observed verdict with `SIMULATED_FILLED`.

## From valuation-only replay

Candle/reference values remain `VALUATION_ONLY`. They may enter only an
explicit `REFERENCE_COST` profile. They must not be passed to a quote model or
relabeled as native/synthetic quote evidence.

## Profile versioning

Generate `profile_hash` from the complete normalized profile with
`historicalExecutionProfileHash`. Generate a fee hash with
`historicalFeeModelHash`. Any change to latency, tick, source selection,
minimum size, interpolation fraction, additional cost, or model version
changes the hash and therefore the simulation identity.

The caller must freeze the profile before outcome access. Previously viewed
samples remain `IN_SAMPLE`. Keep quote/reference sources and resolution
profiles in separate reporting cohorts.

## Unsupported behavior

V1 rejects or leaves unresolved:

- incomplete source/profile/hash inputs;
- source cohort or immutable manifest mismatches;
- sparse evidence used for a no-touch conclusion;
- fills beyond a frozen signed limit;
- non-atomic leg combinations;
- missing or insufficient package size for quote models; and
- Double Diagonal exits on or after the earliest leg expiration.

Adding roll logic, calibrated impact/queue models, or broker reconciliation
requires a later contract version.

