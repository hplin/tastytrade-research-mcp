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
`AVAILABLE` can still describe a completed provider snapshot with internal
missing-bar warnings; it is not a continuous quote-coverage assertion.

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
