# Historical DXLink candle transport

DXLink remains the only configured runtime transport. A dormant,
provider-neutral bounded-history contract exists for a future source, but it
requires explicit provider/dataset/license approval and is not wired to an
MCP tool or environment configuration. See
[`historical-provider-decision.md`](historical-provider-decision.md).

## CandleSymbol identity

The public request keeps human-readable intervals such as `1m` and `1h`.
DXLink subscriptions use the provider's normalized `CandleSymbol`
representation:

| Requested interval | Provider period | Meaning |
| --- | --- | --- |
| `1m` | `m` | one native MINUTE period |
| `1h` | `h` | one native HOUR period |
| `60m` | `60m` | sixty MINUTE periods |
| `1d` | `d` | one native DAY period; not reconstructed from hours |

`1h` and `60m` have the same nominal duration but different aggregation
types. They are never treated as interchangeable.

Historical candle results now include the shared versioned
`resolution_profile` metadata described in
[`resolution-profiles.md`](resolution-profiles.md). Direct requests without a
profile retain their caller-supplied interval/session under
`DIRECT_CANDLE_REQUEST`. The named `HOURLY_VALUATION_RESEARCH` profile is an
explicit opt-in and produces `{=h,a=s,tho=true}` for New York regular-session
SPX research.

Request/response matching canonicalizes only provider-defined equivalences:

- a period value of one may be omitted (`1h` equals `h`);
- known values are case-insensitive and use their shortest form;
- attributes may arrive in a different order;
- explicit defaults such as `price=last`, `a=midnight`, and `tho=false` may
  be omitted.

The matcher does not ignore differences in base symbol/root, exchange,
period type, period value, alignment, session, price type, price level, or
unknown attributes. Raw requested and received strings remain in
`transport_diagnostics` alongside their canonical forms.

## Confirmed native-hour root cause

A sanitized 2026-09-26 live capture reproduced the old timeout:

```text
request:  SPX{=1h}
response: SPX{=h}
rows:     189
flags:    4 (SNAPSHOT_BEGIN), 10 (REMOVE_EVENT | SNAPSHOT_END)
outcome:  all 189 rows unmatched, then SNAPSHOT_TIMEOUT
```

The provider returned the requested data and a marker-only END event. The
client timed out because it compared the raw strings. The regression fixture
is `test/fixtures/dxlink-native-hour-sanitized.json`; its prices and volumes
are synthetic.

After canonical request generation and matching:

| Probe | Result | Received | Returned |
| --- | --- | ---: | ---: |
| SPX 2026-08-25 native `1h` | complete | 189 | 2 |
| SPX 2026-03-02 native `1h` | complete | 1,194 | 2 |
| SPX 2026-08-25 `60m` | complete, distinct `=60m` identity | 189 | 2 |
| expired SPXW 2026-08-27 native `1h` | complete | 144 | 1 |

These observations verify the client bug but do not promise universal
coverage. A provider can still return `SNAPSHOT_SNIP`, an empty completed
snapshot, or no usable contract evidence because of retention or entitlement.
Those outcomes remain separate from symbol mismatch and are not inferred to
be authorization failures without provider evidence.

## Explicit LAST, BID, and ASK aggregates

`tastytrade_get_historical_candles` accepts optional `price_type: LAST | BID |
ASK`. Omission preserves the existing LAST subscription and request/cache
identity. BID and ASK request separate DXLink `price=bid` and `price=ask`
OHLC series; the result identifies its `price_type` and
`evidence_class: VALUATION_ONLY`.

For example, request the recent short-leg ASK aggregate:

```json
{
  "request": {
    "symbol": "SPXW  261013C07800000",
    "streamer_symbol": ".SPXW261013C7800",
    "instrument_type": "OPTION",
    "interval": "1m",
    "price_type": "ASK",
    "start_time": "2026-10-13T18:03:00Z",
    "end_time": "2026-10-13T18:12:00Z",
    "deadline_ms": 18000,
    "max_output_candles": 100,
    "max_received_events": 40000,
    "max_buffer_bytes": 10000000
  }
}
```

The direct candle range retains its existing bar-start semantics. Before
evaluating a checkpoint or counting completed observations, require
`available_at <= checkpoint`; a row starting at the range end is not a
completed bar at that time.

These are aggregated price series, **not synchronized event-time NBBO**.
Separate bid and ask closes can come from different source events within a
bar; equal bar timestamps do not establish quote synchronization. The source
does not supply bid/ask sizes, last-quote event timestamps, executable package
prices, or verified fills. `bid_volume` and `ask_volume` are volumes, not
quote sizes. Missing bars remain missing; no last-price, other-price-type,
current-quote, or coarser-resolution substitution is performed.
Outside the calendar-verified RTH daily scope below, `AVAILABLE` can still
describe a completed provider snapshot with internal missing-bar warnings;
it is not a continuous quote-coverage assertion.

[dxFeed documents](https://kb.dxfeed.com/en/data-services/aggregated-services/candle-types.html)
approximately 14 calendar days of BID/ASK/MARK candle history, subject also
to candle-count limits and entitlement. That documentation is not a promise
of complete SPXW coverage under the tastytrade account.

A 2026-10-14 UTC read-only probe of the existing entitlement returned these
completed 1m aggregates for 2026-10-13 14:03–14:12 ET:

| Exact contract | BID bars | ASK bars |
| --- | ---: | ---: |
| `SPXW  261013C07800000` | 9 | 9 |
| `SPXW  261013C07840000` | 6 | 7 |

For `SPXW  260702C07475000` on 2026-07-02, BID and ASK 1m
subscriptions both returned marker-only `SNAPSHOT_SNIP` and zero bars.
LAST 5m/15m/30m session queries also returned SNIP; separate LAST 1h and 1d
queries returned seven and one bars respectively. Short 1m/5m attempts
alternated between SNIP and snapshot timeout. This is resolution-dependent
availability, not proof of a particular retention or entitlement cause.
Hourly/daily valuation does not establish minute-level stop ordering.
The probe assumed the July 2 expiration; it did not reconstruct the complete
incident inventory or verify a deployed commit.

Historical package, discovery, and execution-evidence tools retain their
LAST/reference-only behavior. BID/ASK candle aggregates are not promoted to
the quote-backed handoff. External-provider enablement remains unchanged.

## Snapshot and transaction lifecycle

Lifecycle is tracked independently for each canonical symbol.

- `SNAPSHOT_BEGIN` resets that symbol's indexed snapshot state.
- Duplicate indexes replace older values.
- `REMOVE_EVENT` removes the corresponding index.
- `SNAPSHOT_END` marks a complete provider snapshot.
- `SNAPSHOT_SNIP` is terminal but incomplete.
- Events carrying `TX_PENDING` are buffered under `max_buffer_bytes`; END or
  SNIP does not become effective until a later event clears `TX_PENDING`.
- Timestamp order never determines completion.

Completed or snipped symbols are unsubscribed independently. A request-level
deadline or resource failure preserves already completed symbol results and
marks only unfinished symbols with the applicable failure reason.
An authenticated, subscribed historical stream that fails preserves its
committed rows as partial evidence with `PROVIDER_TEMPORARY_FAILURE`.
Authentication rejection and cancellation retain their explicit error paths.

## Calendar-verified REGULAR daily coverage

Daily equity/index requests now separate transport completion from returned
session coverage. This is an additive result migration under contract
`1.0.0`, with normalization policy `us-cash-rth-2026/1`. Status is deliberately
stricter in this scope; callers must not use `snapshot_complete` alone as
confirmation of a daily baseline.

Supported scope is **2026 only**, `America/New_York`, SPY/QQQ/IWM with matching
unqualified streamer symbols, and the **SPX cash index** with `SPX` or `$SPX`
streamer identity. The explicit cash-calendar mapping is not an options,
futures, crypto, arbitrary equity/exchange, or universal index calendar.
An equity/index `REGULAR 1d` outside these bounds fails closed with
`CALENDAR_UNSUPPORTED`, an explicit scope/range reason, null ratio, false
coverage, and no promoted daily bars. It does not infer an exchange from an
unknown symbol. Direct intraday, ALL, CUSTOM, and option requests retain
their existing semantics.

The fixed schedule is sourced from the official
[NYSE calendar and core trading hours](https://www.nyse.com/trade/hours-calendars)
and corroborated by the official
[Nasdaq 2026 schedule](https://www.nasdaqtrader.com/Trader.aspx?id=Calendar).
Weekends and these full closures are excluded:

`2026-01-01`, `01-19`, `02-16`, `04-03`, `05-25`, `06-19`, `07-03`,
`09-07`, `11-26`, `12-25` (all dates in 2026).

Sessions open at 09:30 ET and close at 16:00 ET, except **November 27 and
December 24 close at 13:00 ET**. IANA timezone offsets determine the UTC
instants across both DST transitions. New years, symbols, exceptional
closures, or schedule revisions require an explicit, versioned calendar
update; this schedule does not predict them.

Expected sessions have their native bar start within the requested range
and close no later than both `end_time` and the request's market-clock
cutoff. An unfinished Monday bar is excluded at Monday INITIAL; Friday's
completed bar remains usable. An unfinished half-day is likewise excluded
before 13:00 ET. Future rows cannot become historical evidence merely
because they were included in a provider-shaped response.

Results expose:

- `expected_session_dates`, `observed_session_dates`,
  `missing_session_dates`, and `coverage_ratio` for **returned eligible bars**;
- `session_coverage_complete`, independent of `provider_snapshot_complete`
  and transport `snapshot_complete`;
- `session_coverage.calendar_id`, calendar-scope `status` (`VERIFIED` means
  the calendar scope is known, not that all bars exist), explicit unsupported
  reason, and `evaluated_through`;
- `session_coverage.ma20_expected_session_dates` and `ma20_eligible`.

The ratio is observed expected dates / expected dates, or 1 for an empty
supported expected set; no bars still returns `NOT_AVAILABLE`. Output
truncation never turns a missing returned session into confirmed coverage.
Twenty rows alone do not qualify MA20: at least twenty expected dates,
their latest twenty-date continuity, verified timing, a usable completed
transport, and no failures are required. Eligibility does not compute a
moving average, freshness grade, or downstream opportunity grade.

For example, a native Oct 7/Oct 9 response to an Oct 7–9 RTH request reports
three expected dates, two observed dates, missing `2026-10-08`, ratio `2/3`,
`session_coverage_complete=false`, and `PARTIAL`, even if both transport
flags are true. Missing days produce `SOURCE_RTH_DAILY_MISSING` and
`CALENDAR_EXPECTED_SESSION_MISSING`; provider END additionally produces
`PROVIDER_COMPLETE_BUT_COVERAGE_PARTIAL`. Timeouts expose `PROVIDER_TIMEOUT`
alongside the legacy `SNAPSHOT_TIMEOUT` reason.

### Native daily time provenance and diagnosis

[dxFeed's official Candle types documentation](https://kb.dxfeed.com/en/data-services/aggregated-services/candle-types.html)
describes `a=s` as regular-session start alignment and `tho=true` as
regular-session-only aggregation. Both daily and hourly REGULAR
subscriptions keep those attributes; ALL does not acquire them. The
documented approximately fourteen-day history applies to BID/ASK/MARK, not
as a diagnosis of LAST daily omissions.

Only a source timestamp exactly matching the supported session's 09:30 NY
open is eligible for calendar-verified native daily timing. No midnight,
prior-evening, unknown trading-date convention, or differently aligned
native row is relabeled. `source_time` and `bar_start` stay unchanged.
`session_timing` records the calendar/date; `bar_end` and `available_at`
use the actual scheduled session close, including half-days, rather than
`bar_start + 24h`. Duplicate dates under distinct native indexes fail
closed instead of arbitrarily selecting an OHLC row.

Here `available_at` is the **session-completion lower bound**, not an
observed provider publication or revision timestamp. `retrieved_at` remains
the actual collection provenance. A historical retrieval cannot prove that
this exact revision was published at an earlier frozen checkpoint; use
independently archived point-in-time evidence when that proof is required.
Nothing rewrites a frozen checkpoint or promotes later-acquired data into
its original evidence.

`transport_diagnostics.received_session_dates` and `local_pipeline` expose
canonical valid receipt, range/session filtering, invalid OHLC events,
index replacements/removals, snapshot resets, unverified daily times, and
unfinished rows. `missing_session_diagnostics` distinguishes
`NO_VALID_CANONICAL_PROVIDER_ROW_OBSERVED` from
`VALID_PROVIDER_ROW_NOT_RETURNED_LOCALLY`. Neither claims a confirmed
provider root cause: absent valid receipt could involve the stream,
subscription, entitlement, invalid rows, or unknown daily date semantics.
Requested/received raw and canonical CandleSymbols remain attributable.

### Bounded native recovery

For supported long windows of at least 30 completed sessions and deadlines
of at least 20 ms, the initial snapshot uses at most 75% of the existing
deadline, reserving time for recovery. There is no timeout increase.
Each symbol gets at most one short-window retry of the first contiguous
missing run, capped at five expected sessions; a batch has at most four
recovery attempts, sequentially. Missing dates after that bounded attempt
remain partial; this is not a promise of exhaustive recovery.
An authentication reconnect of an interrupted recovery window also counts
against the four-attempt cap; it does not grant a second missing-date window.

Retries use the **same symbol, price type, native daily period, and REGULAR
attributes**, and the original deadline's remaining wall-clock time. Event
counts are cumulative; already retained buffers and output rows reduce the
remaining budgets. Output/local resource failures and SNIP do not get fresh
budgets. A completed peer is not invalidated by another symbol's timeout.
Completed-date rows from an interrupted retry are retained alongside good
initial bars, with explicit partial diagnostics. Initial transport failure
remains visible even if the retry recovers dates.

An `UNAUTHORIZED` initial or recovery response retains committed rows, consumed event
and buffer counters, and the failed attempt's window, including zero-event
attempts. The existing authentication policy permits one token invalidation
and one forced refresh **across the entire request**, including initial
authentication. Initial reconnects subscribe only incomplete peers; recovery
refresh resumes only the interrupted native recovery window,
with the original deadline and residual event/output/buffer allowances.
Already committed timestamps are not replaced by refreshed revisions.
An initial reconnect shares the original cumulative ledger: previously committed
native index/timestamp pairs remain immutable even across `SNAPSHOT_BEGIN` and
`REMOVE_EVENT`. A changed timestamp for a committed index, or a different index
for its timestamp, fails closed as `PROVIDER_SCHEMA_MISMATCH`; no revision is
silently substituted. Other uncommitted rows follow ordinary snapshot resets.
Uncommitted transactions do not cross sockets; their retained bytes remain
conservatively charged. Duplicate wire events still consume the event allowance.
No reconnect opens when less than one millisecond remains on either the original
monotonic deadline or the injected market clock; zero is never raised to a fresh
one-millisecond allowance.
Successful reauthentication reports `REFRESHED` and retains a sanitized
`provider_error`; the failed window records `AUTH_FAILED` even when recovery
subsequently succeeds. Repeated rejection or refresh acquisition failure
reports authentication `FAILED` and an `AUTH_FAILED` partial result without
erasing initial/recovered rows or completed peers. If the remaining budgets
prevent reauthentication, authentication remains `NOT_CONFIRMED` with explicit
failure/stop diagnostics, never falsely `CONFIRMED`. Cancellation still rejects
explicitly rather than becoming a temporary provider failure.

`recovery_diagnostics` records attempts, recovered dates, stop reason,
failures, and bounded request windows with END/timeout/event evidence.
Its separate `initial_windows` list records interrupted initial attempts and their
reconnects with per-symbol event deltas, original range, completion, failure stage,
and failure/timeout provenance, including zero-event handshake rejection. These
are initial authentication attempts, not extra missing-date recovery windows.
Buffer accounting is conservative across attempts; the existing peak
counter measures attempted reservations, which can exceed the limit on a
rejected allocation, not permission to retain excess memory.
There is **no ALL substitution, 1h reconstruction, resampling, interpolation,
or `DERIVED_RTH_DAILY` source** in this implementation.

### Downstream contract and evidence gate

Consumers such as `trading-market-data-v2` and SPX/TOD baseline graders must
require `status=AVAILABLE` **and** `session_coverage_complete=true` before
confirming this daily source; require `ma20_eligible=true` for MA20 and
`available_at <= checkpoint` for every selected observation. Null/absent
coverage is not newly verified coverage. Preserve exact missing dates and
source/timeout reasons as PARTIAL diagnostics; do not fill zeros or convert
missing evidence into Market C/D or “no opportunity.” This repository does
not contain or change those external graders.

`test/fixtures/dxlink-rth-daily-synthetic.json` and deterministic fake sockets
reproduce SPX Sep 28–30 and SPY/QQQ/IWM Oct 8 omissions, aliases, local
removal/mapping failures, 33/60-session windows, recovery, budgets, holidays,
DST, half-days, unfinished bars, and MA20 continuity. The fixture is
**synthetic provider shape, not sanitized live evidence**. The existing
sanitized native-hour fixture only proves its prior hourly alias defect.
Issue #96's reported live daily observations do not establish the root
cause or verify this changed implementation. New live probes require
separate authorization; that acceptance gate remains outstanding.

Offline reproduction:

```bash
npm test -- --runTestsByPath test/historical-candles.test.js test/dxlink.test.js test/server.test.js
```

## Diagnostics

Each result reports:

- a deterministic request ID and requested/effective cohort identity;
- `dxlink_auth` with quote-token source/reuse, refresh attempt, and retry
  count, plus a sanitized `provider_error` when recovery followed an
  authentication rejection;
- `bar_start`, `bar_end`, `available_at`, and `retrieved_at` on every
  normalized candle, while retaining `source_time` as the bar-start
  compatibility field;
- requested, canonical-requested, received, canonical-received, and unmatched
  received symbols;
- per-symbol and per-request event/resource counters;
- oldest and newest valid received timestamps;
- whether BEGIN, END, and SNIP were observed;
- the timeout stage (`CONNECTING`, `AUTHENTICATING`,
  `OPENING_FEED_CHANNEL`, `CONFIGURING_FEED`, or `SNAPSHOT`).

Diagnostics never include quote tokens, account identifiers, or private
DXLink URL parameters.

The initial `AUTH_STATE/UNAUTHORIZED` after `SETUP` is the protocol challenge
that prompts `AUTH`. If DXLink sends another unauthorized state after that
token, or an `ERROR/UNAUTHORIZED`, the client closes the socket, invalidates
the shared quote-token and OAuth caches, reacquires credentials, and reruns
the complete candle snapshot once. Recovery success reports
`dxlink_auth.status = REFRESHED`. A second rejection throws explicit
`AUTH_FAILED` with sanitized diagnostics and no credential value; no further
retry occurs. A request that times out before observing
`AUTH_STATE/AUTHORIZED` reports `NOT_CONFIRMED`.

## Private source-cache handoff

When the private backend is configured, requests may opt into `READ_WRITE`,
`REFRESH`, or exact-manifest `CACHE_ONLY` behavior through
`evidence_cache`. Cache metadata is additive to the candle result and never
changes bar timing or resolution semantics. See
[`evidence-cache.md`](evidence-cache.md) for identity, revision, corruption,
quota, and offline-replay rules.
LAST, BID, and ASK have distinct cache fingerprints and manifests; an exact
manifest for one price type cannot satisfy another. The dormant bounded-history
adapter supports LAST candles only and rejects BID/ASK rather than silently
returning a different series.
