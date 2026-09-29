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

Contract version `1.1.0` adds bounded DXLink auto-chunking plus separate
event-time, current-request cohort, and source-freshness evidence.

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
the endpoint caps the cohort at 5,000 DXLink event subscriptions so matching
unsubscribes remain within the documented 10,000 subscription-change budget.
Within that bound, callers do not split requests around DXLink's 65,536-byte
frame limit. The client deterministically encodes subscriptions into frames
no larger than 48 KiB and reads at most four batches concurrently.

## Snapshot contract

Each contract includes:

- `provider_symbol` and `occ_symbol`, preserving OCC root padding;
- exact `streamer_symbol`;
- `root_symbol`, strike, call/put, expiration, DTE, multiplier, and settlement;
- optional `quote`, `greeks`, and `summary` objects; and
- per-contract event timestamp alignment, Gamma/OI cohort alignment, OI
  freshness, and Greeks freshness evidence.

Missing numeric provider values remain `null`. In particular, missing
`Summary.openInterest` is never converted to zero.

The result also includes:

- `retrieved_at` and `chain_retrieved_at`;
- `snapshot_complete`, `quote_complete`, `greeks_complete`, and
  `summary_complete`;
- `transport`, including the encoded size and status of every DXLink batch
  plus affected symbols for partial, timed-out, or failed batches;
- field and timestamp-provenance coverage counts;
- aggregate event timestamp alignment, cohort alignment, OI freshness, and
  Greeks freshness;
- stable `request_id` and per-observation `snapshot_id`;
- a downstream `market_data_handoff`; and
- a compact `regression_record`.

## Timestamp, cohort, and freshness evidence

DXLink Greeks normally carry a provider `time`. Quote `bidTime`/`askTime` and
Summary `eventTime` may be zero, especially outside the active market. Every
event therefore returns:

- `timestamp`;
- `timestamp_source`, either a provider timestamp or
  `LOCAL_RECEIVE_TIME`; and
- `received_at`.

Local receive time is an explicit fallback, not a claimed provider event
time. The result reports provider/local timestamp counts and warnings.

`event_timestamp_alignment` compares provider event timestamps across all
requested event categories:

- `ALIGNED`: each requested category has a provider timestamp and skew is
  within `max_temporal_skew_ms`;
- `MISALIGNED`: provider timestamps are present but skew exceeds the limit;
  or
- `UNVERIFIABLE`: at least one requested category lacks a provider timestamp
  or event-time alignment otherwise cannot be established.

The legacy `temporal_alignment` field remains for version-1 consumers and may
also report `INCOMPLETE`. It is not a Gamma proxy completeness gate.

`cohort_alignment` separately evaluates exact-symbol Greeks and Summary
observations delivered for this request:

- `CONFIRMED`: usable Gamma and OI were received for the exact contract during
  the current request, and their receive-time skew is within
  `max_temporal_skew_ms`;
- `PARTIAL`: only one usable side of the Gamma/OI pair arrived; or
- `NOT_CONFIRMED`: the pair is absent or cannot be tied to the current request
  cohort.

`oi_freshness` may be `CONFIRMED` from `CURRENT_REQUEST_RECEIVE_TIME` even
when `Summary.eventTime` is unavailable. Open interest is low-frequency
state; local receipt in this exact request proves acquisition freshness
without fabricating a provider event time. `greeks_freshness` requires a
provider event timestamp delivered in this request. Both freshness objects
also support `STALE` and `UNKNOWN`.

These statuses describe acquisition freshness for this request, not a
separately approved market-recency SLA. Provider/receive timestamps and
`age_ms` remain explicit so downstream research can apply a versioned policy.

The whole snapshot is complete when:

1. every requested expiration is present in the selected root set;
2. every selected contract has usable requested fields;
3. every DXLink batch completes without timeout or failure.

Provider event-time alignment remains independent evidence. Missing Summary
provider time, or even a provider-time mismatch caused by low-frequency OI,
does not degrade a fully confirmed current-request Gamma/OI cohort. Batch
failure, missing Gamma/OI, stale or unknown freshness, or unconfirmed cohort
evidence still fails closed.

## Level 2 unsigned gamma concentration

For every contract with Gamma, open interest, multiplier, confirmed
current-request cohort, confirmed OI freshness, and confirmed Greeks
freshness:

```text
gamma_concentration_i
  = abs(gamma_i)
    * open_interest_i
    * multiplier_i
    * underlying_price^2
    * 0.01
```

The implementation uses the repository's exact decimal arithmetic. Contracts
with missing Gamma, missing OI, missing multiplier, unconfirmed cohort
alignment, or unconfirmed freshness are excluded and counted; missing OI is
not zero-filled. Event timestamp alignment remains visible but does not
replace the cohort/freshness policy.

Proxy status is:

- `COMPLETE` when the requested chain is complete and every selected contract
  has eligible Gamma/OI evidence;
- `PARTIAL` when at least one eligible contract exists but the requested
  Gamma/OI cohort is incomplete; or
- `NOT_AVAILABLE` when no contract is eligible.

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

The separate
[`tastytrade_compute_heuristic_signed_gex`](heuristic-signed-gex.md) tool may
apply an explicit, versioned Level 3 signing hypothesis to this exact
snapshot. That model preserves `snapshot_id`, remains `RESEARCH_ONLY`, and
does not change any Level 2 unsigned values or the `UNKNOWN` dealer fields in
this contract.

## Downstream handoff

`market_data_handoff` is shaped for `trading-market-data-v2` normalization:

```json
{
  "gamma_concentration_proxy": "123456.78",
  "gamma_proxy_methodology": "OI_BASED_UNSIGNED_GAMMA_CONCENTRATION",
  "gamma_proxy_as_of": "2026-09-29T02:45:00.000Z",
  "gamma_proxy_completeness": {
    "status": "COMPLETE",
    "coverage_ratio": "1",
    "snapshot_complete": true,
    "temporal_alignment": "UNVERIFIABLE",
    "event_timestamp_alignment": "UNVERIFIABLE",
    "cohort_alignment": "CONFIRMED",
    "oi_freshness": "CONFIRMED",
    "greeks_freshness": "CONFIRMED"
  },
  "dealer_gex_status": "UNKNOWN",
  "evidence_role": "SUPPORTING_EVIDENCE",
  "phase": "LIVE_SUPPORT"
}
```

If the proxy is unavailable, `gamma_concentration_proxy` is `null`, not zero.
The downstream risk dashboard must keep Gamma Risk `UNKNOWN` whenever
coverage, cohort alignment, or freshness is insufficient. `COMPLETE` still
describes only the unsigned concentration proxy; it does not make Dealer GEX
or Gamma Risk known.

## Regression recording

Persist the full sanitized result or, at minimum:

- `regression_record`;
- `market_data_handoff`;
- DXLink batch provenance;
- proxy `data_completeness`;
- snapshot completeness, event alignment, cohort alignment, and freshness;
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
reported independently and may be `UNVERIFIABLE`; a confirmed current-request
cohort with confirmed OI and Greeks freshness may still produce a `COMPLETE`
proxy. All risk/dealer conclusions remain `UNKNOWN`. Set five current
expirations and `TASTYTRADE_LIVE_OPTION_STRIKE_COUNT=50` to exercise live
auto-chunking. The JSON output is appropriate for a private regression
artifact; it contains market data but no credentials or quote token.
