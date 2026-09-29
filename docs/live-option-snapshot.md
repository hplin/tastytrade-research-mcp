# Unified live option snapshot

`tastytrade_get_live_option_snapshot` is a bounded, read-only SPX/SPXW
market-data endpoint. It connects directly to the tastytrade REST API and
DXLink; it does not call, embed, or depend on `tastytrade-mcp`.

The endpoint joins one option-chain cohort by the exact tastytrade
`streamer-symbol`:

- tastytrade nested option-chain metadata supplies exact OCC/provider symbols,
  streamer symbols, strike, option side, expiration, DTE, multiplier, root,
  and settlement;
- DXLink `Quote` supplies bid, ask, sizes, and side timestamps when available;
- DXLink `Greeks` supplies delta, gamma, theta, vega, rho, implied volatility,
  and event time; and
- DXLink `Summary.openInterest` supplies open interest.

This is live support evidence only. It never places, replaces, validates, or
cancels an order.

## Request

```json
{
  "request": {
    "underlying": "SPX",
    "expirations": ["2026-09-29", "2026-09-30"],
    "around_price": "7683.69",
    "strike_count": 25,
    "include_quotes": true,
    "include_greeks": true,
    "include_summary": true,
    "phase": "LIVE_SUPPORT",
    "deadline_ms": 5000,
    "max_temporal_skew_ms": 5000
  }
}
```

`strike_count` is applied independently to each root/expiration series.
`SPX` requests use the canonical `/option-chains/SPX/nested` response and
retain both SPX and SPXW roots. `SPXW` requests use the same canonical chain
but retain only SPXW contracts. This preserves the provider's exact AM/PM
settlement and symbol identity rather than manufacturing SPXW symbols.

`around_price` is caller-supplied current SPX evidence. It selects the nearest
strikes and is the `underlying_price` in the proxy formula. The endpoint does
not silently replace it with a later quote.

The request is bounded to 10 expirations and 100 strikes per series. At least
one of Quote, Greeks, or Summary must be requested. After contract selection,
the endpoint also caps the cohort at 5,000 DXLink event subscriptions so the
matching unsubscribe remains within the documented 10,000 subscription-change
budget; callers must narrow expirations or strikes when a wider request would
exceed it.

## Snapshot contract

Each contract includes:

- `provider_symbol` and `occ_symbol`, preserving OCC root padding;
- exact `streamer_symbol`;
- `root_symbol`, strike, call/put, expiration, DTE, multiplier, and settlement;
- optional `quote`, `greeks`, and `summary` objects; and
- per-contract temporal-alignment status and skew.

Missing numeric provider values remain `null`. In particular, missing
`Summary.openInterest` is never converted to zero.

The result also includes:

- `retrieved_at` and `chain_retrieved_at`;
- `snapshot_complete`, `quote_complete`, `greeks_complete`, and
  `summary_complete`;
- field and timestamp-provenance coverage counts;
- aggregate temporal alignment;
- stable `request_id` and per-observation `snapshot_id`;
- a downstream `market_data_handoff`; and
- a compact `regression_record`.

## Timestamp provenance and temporal alignment

DXLink Greeks normally carry a provider `time`. Quote `bidTime`/`askTime` and
Summary `eventTime` may be zero, especially outside the active market. Every
event therefore returns:

- `timestamp`;
- `timestamp_source`, either a provider timestamp or
  `LOCAL_RECEIVE_TIME`; and
- `received_at`.

Local receive time is an explicit fallback, not a claimed provider event
time. The result reports provider/local timestamp counts and warnings.

For each contract, the endpoint computes the maximum skew across all
requested event categories:

- `ALIGNED`: every requested event is present and skew is within
  `max_temporal_skew_ms`;
- `MISALIGNED`: all requested events are present but skew exceeds the limit;
- `UNVERIFIABLE`: every requested event is present, but at least one category
  lacks a provider timestamp, so local receive time cannot prove source-time
  alignment; or
- `INCOMPLETE`: at least one requested event is missing.

`receive_skew_ms` records whether the events arrived in one local subscription
cohort. It is not substituted for source-time skew.

The whole snapshot is complete when:

1. every requested expiration is present in the selected root set;
2. every selected contract has usable requested fields;
3. the DXLink deadline did not expire.

Temporal alignment remains a separate status. `MISALIGNED` and `INCOMPLETE`
contracts are excluded from the proxy. `UNVERIFIABLE` contracts may
contribute to the unsigned research calculation, but force proxy status
`PARTIAL`, retain Gamma Risk and Dealer GEX as `UNKNOWN`, and cannot become a
production gate.

## Level 2 unsigned gamma concentration

For every contract with Gamma, open interest, multiplier, and no known
source-time mismatch:

```text
gamma_concentration_i
  = abs(gamma_i)
    * open_interest_i
    * multiplier_i
    * underlying_price^2
    * 0.01
```

The implementation uses the repository's exact decimal arithmetic. Contracts
with missing Gamma, missing OI, missing multiplier, or failed temporal
alignment are excluded and counted; missing OI is not zero-filled.

The result uses:

```text
methodology = OI_BASED_UNSIGNED_GAMMA_CONCENTRATION
methodology_version = 1.0.0
evidence_role = SUPPORTING_EVIDENCE
phase = LIVE_SUPPORT
research_only = true
production_gate_eligible = false
```

Aggregations are returned by:

- strike;
- expiration;
- call/put;
- DTE bucket (`0_DTE`, `1_TO_7_DTE`, `8_TO_30_DTE`,
  `31_TO_60_DTE`, `61_PLUS_DTE`, or `UNKNOWN`); and
- absolute distance from spot (within 1%, 1–3%, 3–5%, or beyond 5%).

The result also includes total concentration, concentration within 1% of
spot, top strikes, contract counts, shares of total, and data completeness.

## Semantic boundary

The output intentionally states:

```text
OI-based Gamma Concentration Proxy
!= Dealer GEX
!= signed dealer positioning
!= gamma flip or zero-gamma truth
```

Open interest does not identify dealer/customer ownership or whether any
participant is long or short. Therefore:

- `gamma_risk = UNKNOWN`;
- `dealer_gex_status = UNKNOWN`;
- `signed_dealer_positioning = UNKNOWN`; and
- `gamma_flip_status = UNKNOWN`.

This endpoint supplies a concentration feature. It does not define LOW,
MODERATE, or HIGH thresholds, does not rewrite DV/CV/IC/DD grades, and must
not become a `PRODUCTION_GATE` without a separately approved methodology and
regression decision.

## Downstream handoff

`market_data_handoff` is shaped for `trading-market-data-v2` normalization:

```json
{
  "gamma_concentration_proxy": "123456.78",
  "gamma_proxy_methodology": "OI_BASED_UNSIGNED_GAMMA_CONCENTRATION",
  "gamma_proxy_as_of": "2026-09-29T02:45:00.000Z",
  "gamma_proxy_completeness": {
    "status": "AVAILABLE",
    "coverage_ratio": "1",
    "snapshot_complete": true,
    "temporal_alignment": "ALIGNED"
  },
  "dealer_gex_status": "UNKNOWN",
  "evidence_role": "SUPPORTING_EVIDENCE",
  "phase": "LIVE_SUPPORT"
}
```

If the proxy is unavailable, `gamma_concentration_proxy` is `null`, not zero.
The downstream risk dashboard must keep Gamma Risk `UNKNOWN` whenever
coverage or alignment is insufficient.

## Regression recording

Persist the full sanitized result or, at minimum:

- `regression_record`;
- `market_data_handoff`;
- proxy `data_completeness`;
- snapshot completeness and temporal alignment;
- the selected exact contract inventory; and
- later outcome labels.

`request_id` identifies the normalized logical request. `snapshot_id`
identifies the actual retrieved event cohort. This allows repeated live
observations for the same request to remain distinct during later
incremental-value analysis.

The endpoint makes no claim that Gamma concentration improves 3–5
trading-day outcomes. That claim requires a separately versioned regression
with frozen samples and decision rules.

## Opt-in live integration gate

The live gate requires credentials plus explicit current expirations and
spot:

```bash
TASTYTRADE_LIVE_OPTION_EXPIRATIONS=2026-09-29,2026-09-30 \
TASTYTRADE_LIVE_OPTION_AROUND_PRICE=7683.69 \
TASTYTRADE_LIVE_OPTION_STRIKE_COUNT=5 \
npm run live:option-snapshot
```

Optional settings are:

- `TASTYTRADE_LIVE_OPTION_UNDERLYING` (`SPX` by default);
- `TASTYTRADE_LIVE_OPTION_DEADLINE_MS` (5,000 by default); and
- `TASTYTRADE_LIVE_OPTION_MAX_TEMPORAL_SKEW_MS` (5,000 by default).

The gate passes only when at least one exact contract contains both Gamma and
OI and the requested snapshot fields are complete. Source-time alignment is
reported independently and may be `UNVERIFIABLE`; that condition leaves the
proxy `PARTIAL` and all risk/dealer conclusions `UNKNOWN`. The JSON output is
appropriate for a private regression artifact; it contains market data but
no credentials or quote token.
