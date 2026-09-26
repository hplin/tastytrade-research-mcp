# Historical SPX candidate universe

`tastytrade_get_historical_spx_candidate_universe` returns a bounded,
timestamp-safe SPXW contract grid for downstream deterministic spread
construction. It is research-only and never chooses a final Iron Condor,
Double Diagonal, or other package.

## Input

```json
{
  "request": {
    "underlying": "SPX",
    "as_of": "2026-08-25T14:30:00Z",
    "min_dte": 21,
    "max_dte": 35,
    "strike_min": 7375,
    "strike_max": 7950,
    "strike_step": 25,
    "option_sides": ["CALL", "PUT"],
    "max_contracts": 500,
    "phase": "REGRESSION_RESEARCH",
    "references": {
      "checkpoint_id": "spx-universe-2026-08-25-0730-pt"
    }
  }
}
```

When `expirations` is omitted, the adapter generates the nearest eligible
SPXW expiration dates at minimum, midpoint, and maximum DTE. Callers may
instead supply explicit `YYYY-MM-DD` expiration dates inside the requested
DTE range.

`strike_step` defaults to 25. The requested output grid is capped by
`max_contracts` (default 500, maximum 1,000). Requests that exceed that bound
are rejected before opening a provider connection.

## Evidence reconstruction

The adapter:

1. obtains the latest complete SPX 5-minute candle available by `as_of`;
2. deterministically generates SPXW OCC and streamer symbols for the bounded
   expiration/strike/side grid;
3. retrieves option candles in batches of at most 20 symbols;
4. accepts only complete bars with
   `source_time + 5 minutes <= as_of`;
5. excludes observations older than 60 minutes;
6. treats a generated contract as historically verified only when DXLink
   returns evidence for that exact symbol; and
7. derives delta when contract IV and a timestamp-aligned call/put parity pair
   are available.

Missing contracts are excluded. Current quotes, current Greeks, later
intraday data, and later Backtester selections are never used to repair the
grid.

## Output

Each verified contract includes:

- exact OCC/provider/simulation symbol;
- expiration, strike, side, and DTE at `as_of`;
- evidence availability timestamp and observation age;
- historical close;
- reconstructed delta when available;
- contract IV, interval volume, and open interest when available;
- reconstructed-identity marker;
- field-level provenance; and
- explicit warnings.

The top-level coverage counts requested, verified, and missing contracts.
`COMPLETE` means every generated contract was verified, `PARTIAL` means at
least one but not all were verified, and `NOT_AVAILABLE` means none were
verified.

This is a bounded candidate universe, not a historical full-chain claim.
Historical bid/ask remains unavailable.

## Live checkpoint finding

At `2026-08-25T14:30:00Z`, a 21-35 DTE, 7375-7950, 25-point CALL/PUT request
returned 34 timestamp-safe contracts across:

- 2026-09-15 CALL and PUT;
- 2026-09-22 CALL and PUT; and
- 2026-09-29 PUT.

All returned provenance timestamps were at or before the checkpoint. Missing
contracts, including contracts without a completed candle in the 60-minute
window, remained explicit coverage gaps.
