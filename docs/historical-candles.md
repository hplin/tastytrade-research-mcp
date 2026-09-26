# Historical DXLink candle transport

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

## Private source-cache handoff

When the private backend is configured, requests may opt into `READ_WRITE`,
`REFRESH`, or exact-manifest `CACHE_ONLY` behavior through
`evidence_cache`. Cache metadata is additive to the candle result and never
changes bar timing or resolution semantics. See
[`evidence-cache.md`](evidence-cache.md) for identity, revision, corruption,
quota, and offline-replay rules.
