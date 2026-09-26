# Historical execution evidence migration

## Existing callers

No existing response is upgraded in place:

| Existing output | Remains | Migration |
| --- | --- | --- |
| Historical option package checkpoint/path | `VALUATION_ONLY` | Keep using it for reference valuation; do not map candle OHLC to bid/ask. |
| `tastytrade_verify_historical_fill` | Observed historical touch evidence | Keep its verdict independent from later simulated execution. |
| Live package pricing | Live quote evidence | Do not relabel it as historical evidence without immutable historical timestamps and source manifests. |
| Backtester simulation | Provider simulation | Do not present it as quote-backed or broker-verified evidence. |

## New handoff

Call `tastytrade_normalize_historical_execution_evidence` only after freezing
the candidate and exact inventory. Supply explicit expected observation
times, quote age/skew limits, per-leg quote/status/size fields, and #41
immutable manifest/content IDs. Preserve unsupported provider fields as
`null`; do not synthesize bid/ask from candle high/low, close, or midpoint.

Consumers must select one explicit quote channel (`NATIVE_PACKAGE` or
`ALIGNED_LEG_QUOTES`) and one separately versioned execution profile before
reading outcomes. The handoff itself is not a fill result. Its
`broker_fill_verified` value cannot be changed to `true`.

Frozen `1.0.0` handoffs remain valid by their `evidence_id`. Any incompatible
field or semantic change requires a new contract version rather than
rewriting cached evidence.
