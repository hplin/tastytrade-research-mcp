# Historical SPX candidate discovery

`tastytrade_discover_historical_spx_candidates` provides checkpoint-safe,
selector-based SPX contract discovery for grading regression. It returns a
contract only when Backtester selected it exactly at the requested `as_of`;
otherwise it fails closed. It does not reconstruct or claim a full historical
option chain.

## Provider capability findings

Verified against the tastytrade OpenAPI definitions and a live Backtester
spike on 2026-09-25:

| Provider surface | Verified capability | Historical snapshot limitation |
| --- | --- | --- |
| [`GET /option-chains/{symbol}`](https://developer.tastytrade.com/openapi/instruments.yaml) | Current equity-option instrument chain | The path accepts only `symbol`; no documented `as_of` or historical timestamp parameter |
| [`GET /market-data/by-type`](https://developer.tastytrade.com/openapi/market-data.json) | Current quotes for known symbols | The query accepts symbol lists by instrument type; no documented historical quote timestamp |
| [`POST /backtests`](https://developer.tastytrade.com/openapi/backtesting.yaml) | Historical selection by delta, percentage OTM, current-price offset, premium, and DTE | The documented `EntryConditions` has frequency, day, concurrency, and VIX fields, but no time-of-day field; the documented `Trial` schema contains only open time, close time, and P/L |
| `GET /backtests/{id}/logs` | Live responses exposed the selected option's side, strike, expiration, fill price, and provider `internalSymbol` | The response body is not documented by the OpenAPI schema, so these identity fields are explicitly best-effort |
| `POST /simulate-trade` | Accepts the recovered provider `internalSymbol` and returns a point-in-time price and delta | Does not provide historical bid/ask, IV, skew, term structure, OI, or volume |

The identity capability spike used a 20-delta, 28-DTE SPX put selector over
2026-04-14 through 2026-04-15. The logs selected:

- `equity-option.SPX.20260512200000.P.6690000` at
  `2026-04-14T19:45:00Z`; and
- `equity-option.SPX.20260513200000.P.6740000` at
  `2026-04-15T19:45:00Z`.

An exact point request to `/simulate-trade` for the first provider symbol
returned price `42.35` and delta `-20.17` at
`2026-04-14T19:45:00Z`.

The checkpoint-time capability spike submitted the undocumented field:

```json
{
  "entryConditions": {
    "frequency": "every day",
    "entryTime": "14:30:00Z"
  }
}
```

The provider accepted the request but ignored `entryTime`; the 2026-08-25 SPX
trial still opened at `2026-08-25T19:45:00Z` (12:45 PT), after the requested
07:30 PT checkpoint. The adapter never sends or trusts this field. The
sanitized observation is captured in
[`test/fixtures/spx-candidate-entry-time-ignored-2026-08-25.json`](../test/fixtures/spx-candidate-entry-time-ignored-2026-08-25.json).

Because the log identity fields are undocumented, production use is accepted
only behind normalization and the captured contract fixture
[`test/fixtures/spx-candidate-2026-04-15.json`](../test/fixtures/spx-candidate-2026-04-15.json).
If the provider shape drifts, the tool returns `PARTIAL` or `NOT_AVAILABLE`
instead of reconstructing a symbol.

## MCP input

```json
{
  "request": {
    "underlying": "SPX",
    "as_of": "2026-04-15T14:30:00Z",
    "min_dte": 21,
    "max_dte": 35,
    "sides": ["PUT"],
    "selector_grid": [
      {
        "method": "DELTA",
        "value": 20,
        "days_until_expiration": 28
      }
    ],
    "lookback_calendar_days": 7,
    "phase": "REGRESSION_RESEARCH",
    "references": {
      "checkpoint_id": "spx-2026-04-15-0730-pt"
    }
  }
}
```

Supported selector methods are `DELTA`, `PERCENTAGE_OTM`,
`CURRENT_PRICE_OFFSET`, and `PREMIUM`. The cross-product of `selector_grid`
and `sides` is capped at 12 provider jobs per MCP call.

## Normalized output

The result uses:

- `evidence_type: HISTORICAL_SELECTOR_CANDIDATE_SET`;
- `evidence_phase: REGRESSION_RESEARCH`;
- `status: COMPLETE` when every requested selector/side produced an
  exact-checkpoint identity plus point-in-time price and delta;
- `status: PARTIAL` when at least one exact-checkpoint contract is available
  but the requested set or enrichment is incomplete; and
- `status: NOT_AVAILABLE` when no exact-checkpoint contract can be recovered.

Each returned contract preserves:

- exact provider `internalSymbol`, also usable as `simulation_symbol`;
- expiration, strike, and option side;
- requested selector method, selector value, and DTE;
- DTE at selection and DTE at the requested checkpoint;
- provider selection timestamp;
- simulated price and selected historical delta at that exact timestamp;
- underlying price at selection when present in logs;
- observation age relative to `as_of`;
- field-level source timestamps and endpoint provenance; and
- explicit confidence and limitation warnings.

`occ_symbol` remains `null` because Backtester logs do not expose a documented
OCC symbol. No OCC root is guessed. The exact provider symbol is sufficient
for `/simulate-trade`.

The current provider path requires `selected_at == as_of`, so
`observation_age_ms` is zero for every returned contract. The field remains in
the stable result contract so downstream replay can preserve the selected
timestamp and explicitly reason about age if a future provider-faithful
reconstruction path supports earlier observations.

## Anti-lookahead behavior

1. The tool derives the SPX session date in `America/New_York` and submits a
   bounded lookback window for each selector/side.
2. It accepts only a trial whose `openDateTime` equals `as_of`.
3. Earlier trials are counted in `STALE_TRIALS_EXCLUDED`; later trials are
   counted in `FUTURE_TRIALS_EXCLUDED`. Neither can become a candidate.
4. It separately requires the opening order timestamp to equal `as_of`.
5. It validates the recovered contract against the requested DTE range at
   `as_of`.
6. Exact-leg enrichment calls `/simulate-trade` with
   `startTime == endTime == selected_at`; only a snapshot with that exact
   timestamp is accepted.
7. Raw Backtester logs, close timestamps, P/L, transactions, and later
   snapshots are never included in the normalized result.
8. Candidate discovery and forward outcome simulation remain separate
   phases.

For the fixture checkpoint `2026-04-15T14:30:00Z` (07:30 PT), the
`2026-04-14T19:45:00Z` selection is stale and the same-day
`2026-04-15T19:45:00Z` selection is in the future. The tool returns
`NOT_AVAILABLE`; it does not substitute either contract. When `as_of` is
exactly `2026-04-14T19:45:00Z`, the exact provider symbol, expiration, strike,
selection timestamp, and zero observation age remain available for downstream
exact-leg simulation.

## Unsupported historical fields

The following fields remain unavailable and must stay `UNKNOWN`/`null` in
grading:

| Field | Status |
| --- | --- |
| Full historical chain/universe | Not available |
| Historical bid/ask surface | Not available |
| ATM IV | Not available |
| Contract or surface IV from this capability | Not available |
| Skew | Not available |
| Term structure | Not available |
| Open interest | Not available |
| Volume | Not available |

The output always keeps `surface.atm_iv`, `surface.skew`, and
`surface.term_structure` as `null` and exposes matching capability flags and
warnings. Current option-chain, quote, Greek, or IV values must never be used
to fill these historical fields.

Aggregate selector backtests are discovery evidence only. They must not be
reported as exact-leg historical replay, execution evidence, win rate,
expectancy, or P/L. Exact forward-path analysis must start from a returned
`simulation_symbol` in a separate regression step.

`spx-spread-historical-replay` must treat `NOT_AVAILABLE` as a frozen
no-candidate checkpoint. It may build any supported spread family only from
contracts returned for that exact checkpoint, then pass their unchanged
`simulation_symbol` values into exact-leg forward simulation.
