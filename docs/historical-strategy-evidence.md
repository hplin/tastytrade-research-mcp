# Historical strategy evidence V2

`tastytrade_normalize_historical_strategy_evidence` accepts `{ "request": ... }`
and returns `HistoricalStrategyEvidence`, contract version `2.0.0`. This is
one local-only, provider-neutral adapter, not a set of strategy-specific network
endpoints. It reuses V1 OCC parsing, exact decimal arithmetic, leg quote
normalization, timestamp/cohort rejection, signed package pricing, reference
normalization, and canonical content hashes.

No provider calls, credentials, purchase/activation, current-quote repair,
selection reconstruction, FinPilot A/A+ grading, position sizing, portfolio
gates, trading decisions, or production promotion are implemented.

## Request and identity

The complete MCP input JSON schema is exported as
`HISTORICAL_STRATEGY_EVIDENCE_INPUT_SCHEMA` in
`src/historical-strategy-evidence.ts` and published through `tools/list`.
Unknown properties are rejected. The TypeScript request/result types are
`HistoricalStrategyEvidenceInput` and `HistoricalStrategyEvidence`.
The result schema is
[`historical-strategy-evidence.schema.json`](historical-strategy-evidence.schema.json);
its shared observation/source definitions reference the unchanged V1 schema.
Deterministic, synthetic examples of every supported family are in
`test/fixtures/historical-strategy-evidence.js`; they are not provider coverage.

Required fields:

| Field | Meaning |
| --- | --- |
| `contract_version` | Exactly `2.0.0` |
| `strategy` | Caller-frozen `strategy_id`, `family`, `underlying: "SPX"`, and exact `root: "SPX"` or `"SPXW"` |
| `selection` | `selected_at`, `source_timestamp`, `available_at`, `retrieved_at`, and nested `source`; optional `reference_cost` |
| `legs` | Two to four exact OCC legs: `provider_symbol`, `action`, positive safe-integer `ratio`, `expiration`, `settlement`, `multiplier`; optional planned `entry_phase` |
| `quote_policy` | Frozen `max_quote_age_ms`, `max_temporal_skew_ms`, and `require_sizes: true` |
| `expected_observation_times` | Non-empty, unique explicit RFC3339 checkpoints; no implicit calendar |
| `observations` | V1 historical `observed_at`, `leg_quotes`, optional `native_package_quote` and `references` |

All legs must match the frozen root, encoded OCC expiry, and standard multiplier
100. SPX uses AM settlement; SPXW uses PM. A normalized leg explicitly includes
root, side, decimal strike, expiry, settlement, action, ratio, signed inventory
quantity, multiplier, and planned entry phase. Long quantities are positive;
short quantities are negative. Duplicate symbols, mixed roots, invalid dates,
wrong sides/directions, unsupported quantities, or mislabeled shapes fail closed.
Expiration-date checks reject checkpoints and execution source dates after
planned expiry. They do not verify an intraday settlement cutoff; evidence on
expiry day must not be interpreted as proof the contract was still tradable.

Every `source` carries V1 `source_id`, `provider_id`, `dataset_id`,
`license_scope_id`, `resolution_profile`, `source_revision`, positive `revision`,
`manifest_id`, and `normalized_content_id`. IDs must use `sha256:<64 lowercase
hex>` syntax. Resolution profiles retain their ID, version, native resolution,
and effective resolution.

## Enforced family definitions

These are explicit inventory conventions, not recommendations or inferred
selection rules. Equal ratios may be any positive safe integer unless noted.

| Family | Enforced shape |
| --- | --- |
| `CDS` | Call debit vertical: BUY lower strike, SELL higher strike |
| `PDS` | Put debit vertical: BUY higher strike, SELL lower strike |
| `PCS` | Put credit vertical: BUY lower strike, SELL higher strike |
| `CCS` | Call credit vertical: SELL lower strike, BUY higher strike |
| `IC` | Long outer put/call wings, short inner put/call; ordered strikes, equal wing widths |
| `AIC` | Same signed condor structure, unequal put/call wing widths |
| `SIC` | Same signed condor structure; each explicitly assigned `FIRST`/`SECOND` phase is one full put or call vertical; either side may enter first |
| `RIC` | Reverse IC: short outer wings, long inner put/call; equal widths |
| `DD` | Four legs: short front put/call, long back put/call, both back strikes outward from the front strikes |
| `DC` | Four legs: one same-strike long put calendar and one same-strike long call calendar |
| `Hybrid` | Four legs: exactly one same-strike calendar and one outward-strike diagonal |
| `CALL_CALENDAR` | Two calls, same strike: SELL front, BUY back |
| `PUT_CALENDAR` | Two puts, same strike: SELL front, BUY back |
| `LIB` | Long iron butterfly: short outer wings, long coincident inner put/call; equal widths |
| `BWB` | Three distinct strikes of one side: long wings, short body; wing quantities sum to body quantity; unequal widths or unequal wing quantities |
| `SIB` | Short iron butterfly: long outer wings, short coincident inner put/call; equal widths |

Verticals, condors, and butterflies are single-expiry. Calendar/diagonal
structures use exactly two expiries. DD/DC/Hybrid require put strikes below call
strikes and equal ratios. Two-leg calendars cannot be relabeled as four-leg DC.
Non-BWB shapes require equal ratios; BWB preserves asymmetric ratios such as
`+1/-3/+2` without converting to a standard `1/-2/1` butterfly.

## Selection/reference-cost freeze

Selection must satisfy
`source_timestamp <= available_at <= selected_at <= first checkpoint`
and `selected_at <= retrieved_at`. The caller supplies selection identity
and exact legs; nothing reconstructs a candidate from later observations.
An optional selection `reference_cost` uses the V1 reference schema, signed
cash-flow-per-unit semantics, and must be available at `selected_at`.
Any completed-bar reference must have `bar_end <= available_at`.
It remains `VALUATION_ONLY`, never an execution or guaranteed entry cost.

`frozen_selection_id` hashes normalized strategy, inventory, selection (including
reference cost and provenance), and quote policy. Supplying that optional ID
requires an exact match. Changing later quotes or entry facts cannot change
this identity. Changing a frozen leg, reference cost, source, or policy does.
Historical timestamps and selection claims remain caller-supplied, not
independently established by this tool.

## Actual entry facts and staged SIC

`execution_events` is optional/null. Each supplied event requires:

- `execution_id`, planned `phase`, `source_timestamp`, `available_at`,
  `retrieved_at`, and nested `source`;
- actual `fills`, each with an exact planned `provider_symbol`, positive
  safe-integer `quantity`, and non-negative exact `price` per option unit.

Price and quantity are caller execution facts, never quote-derived fills.
Opening direction comes from the frozen leg. Each fill records signed
inventory quantity and signed dollar cost (`price * signed quantity * 100`).
Debit cost is positive; received credit is negative. Partial actual fills
remain partial; quantities cannot exceed frozen inventory. Duplicate IDs,
duplicate leg rows within an event, off-inventory fills, phase mismatches,
pre-selection executions, or invalid source/availability/retrieval ordering
are rejected. Non-SIC entries use `ENTRY`.

SIC requires explicit planned leg phases. Actual `SECOND` facts require actual
complete `FIRST` fills, with nondecreasing source and availability ordering.
Incomplete first-phase fills cannot authorize a second actual phase.
First-phase fills cannot resume after phase two begins. No planned second
entry is inferred from an attractive package quote.

At each checkpoint, only supplied events with `available_at <= observed_at`
contribute to `active_inventory` and `actual_entry_cost_dollars`. Each active
row keeps `planned_inventory_quantity`, nullable `active_inventory_quantity`,
planned phase, and `execution_fact_status`. An absent supplied fill remains
`null`/`NO_SUPPLIED_FILL`, not an assertion of a flat broker position. Supplied
partial inventory is `PARTIAL_FILL`; fully supplied planned quantity is
`PLANNED_QUANTITY_FILLED`. The reported exposure is only the inventory
established by the supplied facts, not independent account reconciliation.

For example, a supplied first put vertical costing `-200` dollars stays at
`-200` before the second actual entry is supplied and available. A future
optional `-200` call credit does not change the earlier checkpoint to `-400`.
Adding such a later actual event leaves the earlier checkpoint hash unchanged.
Missing entry cost, first/second entry timestamp, and optional event array
remain explicit `null`; quotes and reference costs never fill them.

## Evidence, completeness, and immutable replay

Every expected checkpoint is emitted. Missing observations have
`quote_evidence: null`, `evidence_level: "NONE"`, and
`missing_observation_reason: "MISSING_OBSERVATION"`. No forward fill,
interpolation, substitute legs, or current-quote repair is performed.
Available observations retain V1 per-leg rejection reasons, all timestamp
fields, source cohorts, quote/reference coverage, and distinct native versus
synthetic quotes.

- `EXECUTABLE_QUOTE`: shared V1 rules allow a historical native or synthetic
  package quote as input to a separately specified execution model. This is
  not an actual or simulated fill.
- `REFERENCE_ONLY`: at least one timestamp-safe valuation reference is
  available, but no executable quote.
- `NONE`: neither layer is available.

`status` and top-level coverage describe quote/reference availability across
the requested checkpoints, not completeness of actual execution history.
Missing-size, crossed, stale, skewed, future, mixed-cohort, or otherwise
ineligible quotes are not upgraded. Missing leg prices leave synthetic package
bid/ask null; partial legs cannot manufacture a package quote.
`quote_inventory_scope: "FROZEN_PLANNED_INVENTORY"` makes clear that package
quotes describe the planned inventory, not the independently tracked actual
active exposure. This is especially important during SIC phase one.

Selection, events, checkpoints, and the entire result have deterministic
canonical content IDs. Lineage aggregates exact source `manifest_ids` and
`normalized_content_ids`, including selection/reference costs, quotes,
references, and actual execution facts. Inventory, leg quotes, actual fill
rows, and entry events are normalized into deterministic order. Missing times
are explicit. Replaying the same frozen input yields identical IDs.

The adapter does not read, write, or validate private cache objects. Manifest
links and source/license claims are caller-supplied: both
`source_and_license_claims_verified` and `cache_contents_verified` are `false`.
Use retained immutable source-cache objects to substantiate those links
outside this adapter. No real-provider historical coverage is claimed.

## Risk and scope limitations

`broker_fill_verified` is always false, including for caller-supplied execution
facts. `verified_global_maximum_loss_dollars` and `loss_certificate` are always
null. In particular, a multi-expiry package mark is **not** verified global
maximum loss or a **$4,000 loss certificate**. Early-expiry exposure,
settlement, assignment/exercise, dynamic paths, exits, fees, final P&L, and
portfolio outcomes are not modeled here. Those are not implicit zeroes.

## Migration

V1 `tastytrade_normalize_historical_execution_evidence`, its four-family input
schema, `1.0.0` output, signed prices, and content hashes remain unchanged.
Existing four-family provider endpoints and clients require no migration.
V2 is additive and must be requested by its new tool name and version.
Its broader shapes and caller entry ledger are not accepted by the V1
execution simulator or replay-report contract; this change does not introduce
the dynamic path/exit replay from issue #101.
