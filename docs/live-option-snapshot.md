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

Contract version `1.3.0` adds native timing with explicit UNKNOWN provenance and
optional exact-package quote/Greek quality handoff. Version `1.2.0` added expiry-aware shared authentication provenance
and deterministic one-reconnect recovery. Version `1.1.0` added bounded
DXLink auto-chunking plus separate event-time, current-request cohort, and
source-freshness evidence.

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

Exercise style is `EUROPEAN` with source `SPX_PRODUCT_SPECIFICATION`, not a
claimed per-contract provider field. Multiplier and AM/PM settlement still come
from the option chain; strict package checks compare them against exact OCC
identity and the caller's expected contract terms.

The result also includes:

- `retrieved_at` and `chain_retrieved_at`;
- `dxlink_auth`, including token source/reuse, refresh attempt, and retry
  count, plus a sanitized `provider_error` when authentication was rejected;
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

## DXLink authentication lifecycle

The live snapshot and historical candle clients use the same production
quote-token manager. It honors the tastytrade `expires-at` timestamp with a
one-minute safety margin and does not reuse a token indefinitely after an
OAuth session refresh or WebSocket reconnect.

DXLink's first `AUTH_STATE/UNAUTHORIZED` after `SETUP` is the normal challenge
that prompts the client to send `AUTH`. A later `AUTH_STATE/UNAUTHORIZED`, or
an `ERROR` with `error = UNAUTHORIZED`, is an authentication rejection. The
client then:

1. closes all sockets from that snapshot attempt;
2. invalidates the cached quote token and OAuth access token;
3. reacquires a quote token and rebuilds every affected connection; and
4. retries the snapshot exactly once.

A recovered result reports `dxlink_auth.status = REFRESHED`,
`refresh_attempted = true`, and `retry_count = 1`. If the fresh credential is
also rejected, the result is `NOT_AVAILABLE`, every affected transport batch
is `FAILED`, `dxlink_auth.status = FAILED`, and the batch error begins with
`AUTH_FAILED`. `provider_error` preserves only the provider code and message;
credential values are never returned. If the request deadline expires before
every batch observes `AUTH_STATE/AUTHORIZED`, status is `NOT_CONFIRMED`
rather than claiming a verified session.

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

Version 1.3 additionally exposes, per event:

- `provider_event_timestamp` and `provider_event_timestamp_source`; missing
  native values are **null / UNKNOWN**, never copied from receipt time;
- `as_of`, the native provider timestamp only (null when unknown);
- `received_at` and `available_at`, local receipt time; availability here means
  available to this collector, not an independently known original publication;
- `retrieved_at`, local collection completion time;
- `source`, the DXLink event category, and `provider_symbol`, the original
  DXLink `eventSymbol` (a streamer symbol, not a relabeled OCC symbol); and
- `timestamp_provenance` for native, side, receipt, availability and retrieval
  timestamps.

Quote native time is the last side change (`max(bidTime, askTime)`), while
strict quote freshness uses **both** side times, including the oldest side.
Provider fields use documented epoch milliseconds without seconds/milliseconds
guessing. Native provider time is not asserted to be an exchange execution
timestamp. Greek `time` is event time: `calculation_timestamp` remains
null / UNKNOWN because an independent model calculation time is not supplied.
IV source is `DXLink Greeks.volatility`; IV recency uses that event's native
time, not local receipt. Greek flags preserve transaction/snapshot completion
separately from arrival.

There is no single native timestamp for the entire multi-event snapshot:
top-level `as_of` is null / UNKNOWN. Top-level `available_at`, `retrieved_at`
and `chain_retrieved_at` identify local collection clocks. Legacy proxy,
handoff and regression `*_as_of` aliases remain collection time, now with
explicit `*_as_of_source = LOCAL_COLLECTION_TIME`.

The compact parser honors negotiated `FEED_CONFIG.eventFields`, including
reordering and omitted fields. When no layout is supplied it retains the
requested legacy layout. Missing numeric fields remain null; missing Greek
flags make strict Greek content completion unprovable.

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

### Strict exact-package handoff (optional, no implicit readiness)

Supply `exact_package` inside `request` to select exactly 2, 3 or 4 OCC legs,
including cross-expiry calendars. Exact selection overrides nearest-strike
selection, not expiration/root scope. Each leg must be in `expirations` and
the requested root scope; missing chain legs stay visible in the handoff.
The existing #47 OCC parser is reused. OCC padding, action, ratio, expiry,
multiplier, settlement and exercise style are retained with a request
fingerprint. No historical evidence is rewritten.

Example `exact_package` (add to the request above with matching expirations):

```json
{
  "legs": [
    {
      "provider_symbol": "SPXW  261014C06000000",
      "action": "BUY_TO_OPEN",
      "ratio": 1,
      "settlement": "PM",
      "multiplier": "100",
      "exercise_style": "EUROPEAN"
    },
    {
      "provider_symbol": "SPXW  261015C06000000",
      "action": "SELL_TO_OPEN",
      "ratio": 1,
      "settlement": "PM",
      "multiplier": "100",
      "exercise_style": "EUROPEAN"
    }
  ],
  "policy": {
    "max_quote_age_ms": 5000,
    "max_greeks_age_ms": 5000,
    "max_iv_age_ms": 5000,
    "max_quote_greek_skew_ms": 1000,
    "max_cross_leg_skew_ms": 1000,
    "max_receive_skew_ms": 1000,
    "require_quote_size": true,
    "require_open_interest": true,
    "require_volume": false,
    "session": {
      "start_at": "2026-10-14T13:30:00.000Z",
      "end_at": "2026-10-14T20:00:00.000Z",
      "time_zone": "America/New_York",
      "utc_offset_minutes": -240
    }
  }
}
```

All six age/skew thresholds, all three presence requirements, and the session
policy are **mandatory**; the example numbers are not server defaults.
FinPilot/caller owns the approved session window (including holidays and early
closes). The collector checks current retrieval and quote/Greek native times
against that window and verifies the actual New York DST offset. It does not
reconstruct a historical RTH calendar. Past-dated contracts are incompatible;
strict AM-settled SPX packages also exclude expiration-day contracts
conservatively. Mixed SPX/SPXW roots or AM/PM settlement packages fail closed;
same-root, same-settlement cross-expiry packages are supported.

The result's `exact_package_quality` is also included in
`market_data_handoff.exact_package_quality`. It exposes:

- every requested leg and its observation or null, validity and reason codes;
- oldest quote/Greek age, per-leg quote-versus-Greek skew (both quote sides),
  across-leg native skew and receive-time skew;
- content completeness independently from authenticated transport completion;
- policy, fingerprint, receipt-cohort boundary and timestamp provenance; and
- `READY` or `NOT_READY`, with destination `FINPILOT_GATE` only.

Positive, non-crossed bid/ask and complete delta/gamma/theta/vega/rho plus
positive IV are required. Greek transaction/snapshot flags must establish
content completion. Sizes must be positive when the policy requires them.
Required OI may use exact-current-request Summary receipt; unknown Summary
native time **does not** become quote/Greek timing evidence. OI zero is valid.
This preserves #87: a complete unsigned Gamma+OI proxy remains possible with
unknown Summary event time, confirmed exact cohort, locally acquired OI and
fresh native Greeks. Stricter exact-package failure does not change that
separate legacy Gamma evidence.

`Quote`/`Greeks`/`Summary` do not supply option trading volume in this
contract. `summary.day_volume` is null with `day_volume_source = UNKNOWN`.
Official streaming examples supply `dayVolume` via **Trade**, not Summary.
No Trade subscription or volume source has been invented: a
`require_volume: true` policy fails closed with `MISSING_VOLUME`.

Reason codes include `MISSING_LEG`, `MISSING_QUOTE`, `ABSENT_QUOTE_TIME`,
`INVALID_QUOTE`, `CROSSED_QUOTE`, `MISSING_QUOTE_SIZE`, `PARTIAL_GREEKS`,
`ABSENT_GREEKS_TIME`, `MISSING_IV`, `STALE_QUOTE`, `STALE_GREEKS`, `STALE_IV`,
`QUOTE_GREEK_SKEW`, `CROSS_LEG_SKEW`, `PARTIAL_COHORT`,
`MISSING_OPEN_INTEREST`, `MISSING_VOLUME`, `PROVIDER_SYMBOL_MISMATCH`,
`INCOMPATIBLE_CONTRACT`, `INCOMPATIBLE_SETTLEMENT`, `FUTURE_TIMESTAMP`,
`TRANSPORT_INCOMPLETE`, `SESSION_ANOMALY` and `DST_ANOMALY`.
`content_complete` means fields arrived, not that prices, timing or identity
passed validity. A complete transport can therefore still have invalid content
or a missing exact leg.

Omitting `exact_package` returns null quality, **not READY**. Existing defaults
are unchanged: 25 strikes, 5000 ms request deadline, 5000 ms legacy temporal
skew, all three categories enabled. Legacy Greek/OI acquisition freshness is
request-bound, not a new approved age SLA. None of these defaults elevate
exact-package readiness.

READY is only a data-quality handoff. `order_authorized`,
`production_gate_eligible` and `live_permission_backfill` are always false;
`research_only` is always true. FinPilot owns grades, strategy, GO/capital and
production decisions. Heuristic signed Gamma remains research-only;
**ZeroGEX remains the only current live SPX Gamma regime source** under the
owner's policy.

### Local integration evidence and official-source audit

```bash
npm run build
node scripts/probe-live-option-quality-fixtures.mjs
npm test -- --runTestsByPath test/live-option-quality.test.js test/live-option-snapshot.test.js
```

The probe and fixtures are synthetic sanitized LIVE_SUPPORT data with mocked
REST, token provider and DXLink sockets; they exercise the actual client,
handshake, subscription fields, reordered compact decoding, normalization,
exact selection and handoff. They cover synchronized 2/3/4-leg packages,
cross-expiry 2/4-leg packages, missing chain legs and missing event legs.
Jest additionally covers native-time absence, skew, stale IV, crossed quotes,
partial Greeks/flags, metadata mismatches, session/DST anomalies and thresholds.
They are **not real-provider validation**.

Real live validation is **BLOCKED: no operational authorization or provider
session used for #99 implementation**. No credentials, entitlements, broker
mutations, provider acquisitions, deployments or services were accessed.
The pre-existing live Gamma/OI probe remains separately opt-in; it can accept
`TASTYTRADE_LIVE_OPTION_EXACT_PACKAGE_JSON` containing the full explicit policy
and reports `exact_package_quality_outcome` independently from its legacy
Gamma/OI outcome. This documentation does not authorize running it.

Official public references audited for field semantics (not account entitlement):

- [tastytrade streaming guide](https://developer.tastytrade.com/docs/guides/stream-market-data/):
  Quote/Greeks/Summary field selection, exact streamer symbols, compact layout,
  and Trade-only `dayVolume` in the documented example.
- [dxFeed Quote](https://docs.dxfeed.com/dxfeed/api/com/dxfeed/event/market/Quote.html):
  bid/ask change time in epoch milliseconds; last change is the maximum side
  time, not proof that both sides are fresh.
- [dxFeed Greeks](https://docs.dxfeed.com/dxfeed/api/com/dxfeed/event/option/Greeks.html):
  `time` is event time in milliseconds, volatility/Greeks are model values,
  and flags carry transaction/snapshot semantics.
- [dxFeed MarketEvent](https://docs.dxfeed.com/dxfeed/api/com/dxfeed/event/market/MarketEvent.html):
  event creation time can be zero/unavailable on network events. Summary
  receipt is not an original native event time.
- [Cboe SPX specifications](https://www.cboe.com/tradable-products/sp-500/spx-options/spx-specifications):
  SPX/SPXW multiplier 100, European exercise, and distinct standard/weekly
  expiry trading conventions. Chain settlement is preserved and compared,
  never guessed from a date or entitlement.

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
