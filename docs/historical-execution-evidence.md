# Historical exact-leg execution evidence

`tastytrade_normalize_historical_execution_evidence` is a local-only,
provider-neutral normalization tool. It accepts already licensed and
retrieved historical quote observations, validates their temporal and source
cohort integrity, and emits a deterministic handoff for a later explicit
simulation model. It performs no provider call, grading, order placement, or
broker reconciliation.

The output contract is `1.0.0`; its machine-readable schema is
[`historical-execution-evidence.schema.json`](historical-execution-evidence.schema.json).

## Evidence layers

The handoff keeps three layers structurally separate:

- `VALUATION_ONLY` contains trade, candle, or model references. These values
  cannot establish an executable quote or a fill.
- `SIMULATED_EXECUTION` is absent from this contract. The
  `simulated_execution.input_status` field only states whether a later,
  separately frozen model has eligible quote input.
- `BROKER_EXECUTION` is never inferred. `broker_fill_verified` and
  `evidence_layers.broker_execution.verified` are always `false`.

Existing #35 historical package endpoints remain unchanged and continue to
return candle-close references with `execution_quality: VALUATION_ONLY`.

## Frozen inventory and signed prices

Each inventory leg contains its exact 21-character OCC symbol, opening
action, positive ratio, OCC expiration, settlement, and multiplier. The
normalizer verifies the expiration encoded in the symbol, rejects duplicate
symbols, enforces the expected family shape, and requires one common positive
multiplier.

Inventory quantity is positive for `BUY_TO_OPEN` and negative for
`SELL_TO_OPEN`. For that same inventory:

```text
signed bid = package price received when selling the frozen inventory
signed ask = package price paid when buying the frozen inventory
```

For aligned leg quotes, long inventory uses bid on the signed bid and ask on
the signed ask. Short inventory uses negative ask on the signed bid and
negative bid on the signed ask. Credit structures therefore retain negative
prices; no absolute-value conversion is applied. Native package quotes must
declare `SIGNED_CASH_FLOW_PER_UNIT` and are preserved separately from the
synthetic quote.

## Quote eligibility

A quote observation is complete only when:

- every exact leg is present with bid, ask, bid size, and ask size;
- quotes are `NBBO` or `BBO`, have `NORMAL` status, and declare option-premium
  semantics;
- bid does not exceed ask;
- `source_timestamp <= available_at <= observed_at <= retrieved_at`;
- any `bar_end` is complete by `observed_at`;
- age and cross-leg timestamp skew satisfy the caller's frozen policy; and
- provider, dataset, license scope, resolution profile, and source revision
  form one quote cohort.

Missing values remain `null`. SNIP, partial, future, stale, crossed,
misaligned, mixed-cohort, or ambiguous-price observations remain in the
handoff with rejection reasons but cannot be marked usable for simulated
execution. Window inputs list every expected observation time; missing times
become explicit gaps and are never interpolated or forward-filled.

Package size is the minimum whole package quantity supported by the adverse
side of every leg after applying ratios. A missing or zero required size
fails closed.

## Immutable lineage

Every quote/reference row carries its source ID, provider, dataset, license
scope, resolution profile, source revision, immutable revision,
`manifest_id`, and `normalized_content_id`. Both IDs use the #41
`sha256:<64 hex>` format. The output aggregates the exact IDs and hashes the
normalized handoff with the same canonical content-ID helper. A source
revision or manifest change therefore creates a different `evidence_id`;
older frozen handoffs are not mutated.

## Current provider capability

Run:

```bash
npm run live:historical-quote-capability
```

The probe uses the already-authorized tastytrade DXLink candle source at an
older and a recent 07:30 America/Los_Angeles checkpoint. It records
per-field support without changing provider enablement. DXLink candles can
provide timestamped close/IV valuation evidence when retained, but the
current source does not expose historical bid, ask, bid size, ask size, or
native package quotes. Those fields remain unsupported/null, and the probe
always reports `six_month_coverage_pass: false`. Enabling a separate quote
provider remains subject to
[`historical-provider-decision.md`](historical-provider-decision.md).

The 2026-09-26 probe produced:

| Checkpoint | Provider result | Exact symbols | Candle close | Candle IV | Bid/ask | Bid/ask size | Native package |
| --- | --- | ---: | ---: | ---: | --- | --- | --- |
| 2026-03-02 07:30 PT | `NOT_AVAILABLE` | 0 | 0 | 0 | unsupported | unsupported | unsupported |
| 2026-08-25 07:30 PT | `PARTIAL` | 12 | 12 | 11 | unsupported | unsupported | unsupported |

The exact sanitized result is retained in
[`historical-quote-capability-2026-09-26.json`](historical-quote-capability-2026-09-26.json).
This is a capability result, not a six-month coverage pass and not evidence
that a quote-backed execution model can run on those dates.
