# Historical event-path evidence V1

`tastytrade_build_historical_event_path` accepts `{ "request": ... }` and
returns the additive `HISTORICAL_EVENT_PATH` contract, version `1.0.0`.
The complete input schema is `HISTORICAL_EVENT_PATH_INPUT_SCHEMA` in
`src/historical-event-path.ts`, published by MCP `tools/list`; the output
schema is [`historical-event-path.schema.json`](historical-event-path.schema.json).

This is a local, read-only evidence workflow, not another strategy simulator.
It reuses V2 exact-family selection/inventory validation, V1 quote/reference
normalization, canonical immutable evidence IDs, exact decimal pricing,
and the existing hashed execution and fee profiles. The existing fixed
ENTRY/+3/+5 endpoints, reports, versions and content hashes are unchanged.
It never accesses credentials, providers, cache storage, broker/paper state,
grading, sizing or live trading policy.

## Frozen request

| Field | Contract |
| --- | --- |
| `initial_inventory` | Exactly `"FLAT"`: explicit caller assertion of a flat starting ledger, not account reconciliation |
| `selection` | V2 `contract_version: "2.0.0"`, `strategy`, `selection`, `legs`, `quote_policy`, optional `frozen_selection_id`; excludes V2 observations/entry events |
| `roll_legs` | Up to 28 additional predeclared exact OCC legs; same root, settlement class and multiplier as the initial 2/3/4-leg family |
| `calendar` | Caller-authoritative `calendar_id`, `available_at`, source identity and up to 400 ordered, nonoverlapping sessions with explicit `session_date`, `open_at`, `close_at` |
| `settlements` | Exactly one caller-frozen `settles_at` cutoff per initial/replacement symbol, on its encoded expiration date; no inferred intraday cutoff |
| `policy` | `frozen_at`, existing hashed `execution_profile`, required hashed `fee_model`, explicit `settlement_fees: "PER_CONTRACT"` or `"ZERO"`, and `instructions` |
| `expected_checkpoints` | 1-2000 unique explicit RFC3339 instants; includes variable entry/exit/overnight checkpoints; inside supplied calendar range, after selection |
| `observations` | At most one per checkpoint: V1 observation plus exact active `inventory_id` and `risk` rows |
| `events` | Up to 500 caller-scheduled exact lifecycle events; an atomic roll can close four old and open four new symbols |
| `page_size` | 1-100 returned checkpoints; optional `cursor` and `frozen_path_id` |

Calendar availability, policy and every instruction/limit must be frozen no later
than selection. Sessions, cutoff authority, ledger completeness, sources and
license claims are caller assertions, explicitly **not independently verified**.
Use the retained immutable cache objects behind their exact source revisions,
`manifest_id` and `normalized_content_id` to substantiate them outside this
adapter. The adapter does not look up, rewrite or replace those objects.
Aggregate manifest/content lineage is returned; IDs alone do not verify storage
rights or provider coverage. No private cache credentials are needed.

`historicalPathInventoryId(rows)` hashes sorted nonzero
`{ provider_symbol, inventory_quantity }` rows. An observation's ID must match
the exact active ledger at that checkpoint, including partial/staggered/rolled
quantities. This prevents native package quotes or package references for planned
inventory from silently valuing different active inventory.

The caller chooses every checkpoint and must include all intervals it intends
to assess. Calendar membership does not establish that an omitted session was
observed. `complete` means complete **only for the frozen requested denominator**,
never continuous coverage, a six-month coverage pass or verified market performance.

## Lifecycle, execution and fees

Each event supplies `event_id`, `kind`, `evidence_kind`, full source clock/identity,
and `fills` with unique `fill_id`, exact `provider_symbol`, `side: "OPEN" | "CLOSE"`,
positive `quantity` and nullable per-unit `price`. Long inventory is positive,
short negative. OPEN follows the frozen leg's direction; CLOSE reverses it.
`kind` is `OPEN`, `PARTIAL_CLOSE`, `CLOSE`, `ROLL` or `SETTLEMENT`.
ROLL must contain old-leg closes and new-leg opens. CLOSE must flatten the ledger.
Only declared legs can change; no more than four active symbols are supported.
Cumulative opens cannot exceed each frozen leg's allocation: recycling a closed
symbol requires a separately frozen lifecycle, not silently reusing fill IDs.

Only events with `available_at <= checkpoint` affect that checkpoint. All clocks
require `source_timestamp <= available_at <= retrieved_at`; source order cannot
run backward on an exact leg. SIC SECOND requires complete FIRST opening facts
already available in source/availability order; absent optional second legs stay
flat under the caller's explicit initial-flat assertion. Future closes/rolls
cannot alter an earlier checkpoint's content ID.

- `BROKER_FILL`: supplied per-leg execution facts; not generated from quotes and
  **not independently broker-verified**. `instruction` and `simulation_observation`
  must be null.
- `SIMULATED_FILL`: requires an exact frozen `instruction` and null leg prices.
  The instruction includes ID, freeze time, execution-window start, trigger label
  and signed transaction-cost limit. It must exactly match `policy.instructions`.
  Triggers (`ENTRY`, `STAGE`, `TAKE_PROFIT`, `CLOSE`, `ROLL_REVIEW`, `ROLL`) are
  FinPilot data; MCP does not select a trigger or optimize a parameter.
  `simulation_observation` is the V1 snapshot for the exact signed transaction
  inventory, not the total remaining position.
- `SETTLEMENT`: supplied official cash-settlement prices for exact remaining
  quantities, with source time exactly at each leg's frozen cutoff; no quotes or
  synthetic settlement prices are substituted. Availability may be delayed.

Simulation calls the existing shared model evaluator with transaction direction
encoded in signed inventory. It supports the same `QUOTE_CROSS`,
`QUOTE_LIMIT_TOUCH`, `QUOTE_PRICE_IMPROVEMENT`, and low-evidence `REFERENCE_COST`
profiles, including latency, package size, ticks and the caller's signed limit.
It evaluates the supplied instant, not a hidden search between checkpoints.
Limit touch is only modeled execution under the explicit profile, never proof of
a broker fill or a continuously observed first touch. Midpoint is not executable;
price improvement remains an explicit model assumption. Missing/stale/skewed,
future or incomplete exact legs cannot produce quote-backed fills; references
cannot repair them. `NOT_ASSESSABLE` and `NO_FILL_UNDER_MODEL` events change neither
inventory nor fees. Model output is package cost; per-leg simulated prices are
never invented.

Fees use the required frozen per-contract/per-leg/per-side model exactly once
per applied fill quantity. Opening, partial close, roll close/new open and final
close are separate nonoverlapping sides. Duplicate event/fill IDs fail closed.
Settlement fees use the separately explicit policy. `fee_basis` identifies modeled
fees even for supplied broker execution prices; these are not actual broker fee
receipts. Unavailable fees/costs are null, not zero. The caller's IDs and history
claims are not independent proof that a differently relabeled duplicate is genuine.

After a cutoff, an unsettled active leg leaves P/L unknown with
`SETTLEMENT_NOT_AVAILABLE_ACTIVE_INVENTORY_UNRESOLVED`; it is never carried forward
as an executable quote. Once official settlement is available, only the actual
settled leg is removed; later-expiring legs remain exact and independently valued.
Post-cutoff trade events are rejected.

## Observations, risk and complete denominators

Quotes preserve V1 bid/ask/size, event/availability/retrieval times, cohorts and
rejection reasons. `package_natural` is the signed active-inventory bid/ask, only
when all exact legs pass the quote policy inside an authoritative session;
`executable_fill` is always false. Non-session quotes are explicitly ineligible.
`OBSERVED_QUOTE`, `CANDLE_REFERENCE`, `MODEL_REFERENCE`, `TRADE_REFERENCE`,
`SIMULATED_FILL` and `BROKER_FILL` remain distinct. Reference bars must end before
availability. Missing observations/legs remain explicit; no forward fill,
interpolation, current-quote repair or expiry substitution is performed.

Risk rows independently preserve per-leg IV, delta/gamma/theta/vega/rho, source
clocks/identity and `OBSERVED_GREEKS` versus `MODEL_REFERENCE`. Missing individual
IV/Greek fields remain null, with `PARTIAL` rows, `missing_fields` and full
six-field-per-active-leg denominators. `expiry_role` is
FRONT for the earliest frozen expiry and BACK otherwise; exact expiry remains
on the inventory. Unavailable/stale/post-cutoff risk values remain null with
reasons. Risk cannot promote missing quotes to execution evidence. `risk_gaps`
names active legs without accepted risk rows.

Every checkpoint reports active inventory, known signed cash flow, modeled fees,
liquidation value, net P/L, evidence levels and holding duration. Cash flow is
the negative of signed transaction cost in dollars. Conservative quote liquidation
is `active signed_bid * 100`; references remain valuation-only. Thus
`net_pnl = cumulative_cash_flow + liquidation_value - nonoverlapping_fees`.
A fully closed supplied ledger needs no fabricated liquidation quote.
Holding duration is wall-clock first-entry to checkpoint/final close, including
overnights and any flat intervals; it is not trading-session time.

MAE is the nonpositive minimum sampled net P/L relative to zero; MFE the
nonnegative maximum. Full-denominator MAE/MFE are null if any requested P/L is
missing or a simulation is unassessable. Explicit `observed_sample_*` values may
describe the available subset, never a complete path. Every metric retains
valuation evidence and execution evidence levels (including reference-backed
simulations). `continuous_path_extrema_verified` is always false.
Coverage reports full-path expected/measured/missing checkpoints, active-leg quote
and risk denominators, accepted counts, unresolved simulated events and gaps.
Intervals report elapsed/non-session milliseconds and explicitly assert that no
between-checkpoint observations were inferred.

## Immutable resume and local examples

`path_id` binds frozen normalized selection, inventory, calendar, cutoffs,
profiles, instructions, checkpoint denominator and exact supplied evidence/events,
including source revisions. Resubmit the same full frozen input with `cursor` to
resume; change `page_size` without changing identity. Drift or invalid cursor
shape/checksum/range fails closed. The deterministic checksum detects corruption;
it is not a server authorization signature. Cursors grant no data access.
No mutable provider state, clock or server-side session controls resumption.
Checkpoint IDs depend only on available facts at that checkpoint. Events
(bounded to 500), full coverage and aggregate metrics repeat on each checkpoint
page so page boundaries never shrink denominators.

Synthetic, deterministic requests are in
`test/fixtures/historical-event-path.js`; they are not licensed observations.
After `npm run build`, an offline example is:

```js
import { buildHistoricalEventPath } from "./dist/historical-event-path.js";
import { pathFixture } from "./test/fixtures/historical-event-path.js";
const request = pathFixture("DC");
request.page_size = 1;
const first = buildHistoricalEventPath(request);
const second = buildHistoricalEventPath({
  ...request, frozen_path_id: first.path_id, cursor: first.pagination.next_cursor,
});
```

For issue #101 AC1, the retained sanitized capability/smoke/coverage artifacts do
**not** establish a licensed entry-to-variable-exit vertical slice.
[`historical-event-path-audit-issue-101.json`](historical-event-path-audit-issue-101.json)
therefore records the explicitly permitted `NOT_ASSESSABLE` alternative, with
source byte hashes, six documented gaps and null market metrics/denominators.
It does not convert synthetic fixtures or legacy candle aggregates into market
performance. Reproduce/check entirely offline:

```sh
npm run report:historical-event-path
node scripts/report-historical-event-path.mjs --check
```

Each of the three tracked inputs is bounded to 512 KiB; no acquisition, cache
recovery, credential access, provider activation or operational experiment occurs.
Issue #98 remains incomplete and #42 remains `DO_NOT_ENABLE`.
