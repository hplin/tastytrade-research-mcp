# Read-only historical broker orders and OO audit

## Tools and safety

`tastytrade_get_historical_orders`, `tastytrade_get_historical_transactions`
and `tastytrade_audit_oo_broker_orders` accept `{ "request": ... }`.
They use the existing OAuth refresh client, the trusted HTTPS broker host,
the configured product User-Agent, timeouts, and disabled redirects.
Broker transport exposes **GET only**:

- `/customers/me/accounts`: dynamically resolve the selected account.
- `/accounts/{account-number}/orders`: historical search, **not `/orders/live`**.
- `/accounts/{account-number}/transactions`: historical transactions and executions.

No account mutation, order placement, cancellation/replacement, strategy changes,
credential-file reads, deployments, paid providers, or automatic trading are
part of these tools. OAuth token refresh is authentication, not a broker mutation.
Tests inject offline transports; constructing a server does not contact the broker.

Account selection is mandatory: `{ "type": "Traditional IRA" }` resolves only
one accessible, nonclosed account of that broker account type. Multiple matches
fail with `AMBIGUOUS_TRADITIONAL_IRA`. In that case provide `account_number`
explicitly; it must also belong to an accessible Traditional IRA. Never guess
an account from a nickname, position, strategy, or recent order.
An incomplete account listing fails instead of selecting an apparently unique
account from a truncated response.

Outward results mask the account (last four characters only). Raw account
responses, Axios config/URLs/errors, provider rejection prose, usernames,
customer identifiers, vendor text logs and strategy names are never returned
or logged. Rejection reason presence is retained as
`PROVIDER_REASON_PRESENT_REDACTED`; source is `OptionOmega` only when the
provider explicitly supplies that recognized name, otherwise `UNKNOWN`.
Other source text is not assumed to identify OO.
Strategy/campaign labels and venue identifiers use SHA-256-derived references
to prevent arbitrary embedded PII or tokens being echoed. These references
are stable local correlation aids, not anonymity guarantees against guessing
a known label. Order/fill/transaction IDs and full OCC symbols are retained as
necessary technical evidence. Broker data and logs are not written to the
historical candle cache.
Account references likewise check that the independently acquired orders and
transactions resolved the same account; a scope change blocks combined
execution confirmation and realized P/L, even if masked suffixes are identical.

## Windows, paging and evidence limitations

`start` and `end` accept either offset-bearing RFC3339 timestamps or calendar
dates. Dates mean **ET midnight**, with an exclusive end. To request both
October 12 and 13 use `start: "2026-10-12", end: "2026-10-14"`.
DST dates resolve to the correct 23/25-hour UTC window. Naive timestamps,
invalid calendar dates, reverse/empty windows and windows longer than 366 days
are rejected. Original timestamps, normalized UTC and ET representations are
preserved with separate `BROKER` and `OO` clock labels.

Both broker queries send `start-at`, `end-at`, `underlying-symbol=SPX`,
`sort=Asc`, `page-offset` and `per-page`. There is no status filter: unsuccessful
orders must remain visible. Exact SPX/SPXW OCC records are returned; mixed or
malformed packages produce an explicit gap instead of losing legs silently.
Provider records outside the requested half-open window are excluded with a
gap; records without a membership timestamp remain explicitly unverified.

`page_size` defaults to 100 (maximum 200); `max_pages` defaults to 100 (maximum
1000). Budget exhaustion, changing totals, mismatched unique totals, missing
pagination, premature empty pages, repeated pages and conflicting duplicates
are **INCOMPLETE**, not success. Exact duplicate IDs are suppressed. A complete
empty result is `EMPTY` with `NO_ELIGIBLE_SPXW_EVIDENCE`. Access/scope,
authentication, rate-limit and provider errors have fixed safe codes. Already
retrieved pages are retained on later failure. Requests are serial; rate limits
stop acquisition rather than triggering hidden retries or live fallback.
The shared limit of 200 respects the historical orders endpoint maximum;
transactions and combined audits use that same conservative limit. Larger
values are rejected before authentication or broker requests, not silently capped.

`pagination_complete` establishes enumeration of the **provider query result**,
not proof of exhaustive broker event history or account entitlement. Historical
orders usually expose their final record and selected lifecycle timestamps, not
every intermediate state transition. Created/received/in-flight/live/updated/
cancelled/terminal and available order-rule route/cancel timestamps are retained.
Absent fields remain absent; they are never manufactured from nearby events.
Canceled and Cancelled remain cancellations, not rejection. Replace relations
come only from `replaces-order-id` / `replacing-order-id`; distinct cancellations
are not proof of retries, broker failure, outage, or strategy malfunction.

Transactions retain order/execution IDs, full OCC symbol, action, quantity,
price, execution time, available lots, venue reference, currency, value,
net value, fee components/effects, estimated-fee flag and reversal reference.
Expiration/side/strike are decoded from the exact OCC identity; settlement and
expiration-related subtype are retained only when the provider supplies supported
fields. They are not invented from product conventions.

## OO Activity Log and correlation

`activity_log` can be an object `{ "events": [...] }`, its JSON string, or
normalized text. Each JSON event accepts:

- `kind`: `STOP_TRIGGERED`, `LIMIT_ATTEMPT`, `RETRY_LIMIT_EXHAUSTED` or
  `FILL_REPORTED`.
- `timestamp`: RFC3339 with offset, preserving the OO original clock.
- Optional `order_id`, exact OCC `symbols`, decimal-string `price`,
  `campaign_id`.

Normalized text example:

```text
2026-10-13T14:06:00-04:00 STOP_TRIGGERED price=3.65 SPXW  261013C07800000 SPXW  261013C07840000
2026-10-13T14:06:57-04:00 FILL_REPORTED order_id=514128125 price=8.15
```

Unrecognized vendor prose, local time-only lines, unlabelled price numbers and
ambiguous dates are **not guessed**; `OO_TEXT_LINES_UNPARSED` identifies that
coverage gap. For native OO exports, normalize explicit log events into the JSON
contract while preserving their original offset-bearing timestamps. The parser
does not treat incidental language such as “Returning to normal trade management”
as proof of exhausted retries unless the supplied event explicitly identifies it.
Raw text is never echoed, even on errors.

An explicit order ID matches the broker order; supplied leg identities must agree.
Exact leg-only matches are candidate evidence, not retry-chain or campaign proof.
Explicit campaign references associate individual broker IDs; multiple conflicting
campaign labels cannot establish realized campaign P/L. A strategy name alone
does not attribute any broker order to that strategy.

Attempts include available working intervals, receipt-to-route/cancel latency,
explicit replacement latency and per-leg fills. Absence of fills is limited to
the returned history, not continuous execution telemetry. Episodes calculate
stop-to-first-route and stop-to-final-fill only for explicitly associated orders.
Cross-source latency is uncalibrated OO-to-broker timing, not a measured clock
offset. `oo_minus_broker_ms` preserves both original clocks; e.g. 14:06:57 versus
14:06:53 is +4000 ms without adjusting either clock.

Order-leg fills and transactions remain separate observations. `legs[].fills`
retains order `id` (the fill-ID namespace), `exec_id` and `ext_exec_id`; transactions
retain `exec_id` and `ext_exec_id` separately. The legacy transaction `fill_id` is
an execution-ID alias, **not** proof that it matches an order fill ID. Equal text
across different namespaces never establishes identity. Like-named execution IDs,
including `ext-exec-id` when both sources supply it, must uniquely match within
the same order, OCC leg and action; duplicate or contradictory identities are gaps.
No undocumented mapping from order `ext-exec-id` to transaction `exec-id` is assumed.

For supplied order-fill legs, exact positive quantities, nonnegative prices and
offset-normalized timestamps must agree with transaction executions. Without
shared identity, reconciliation compares summed quantities in identical
price/timestamp buckets, not individual execution identity. This supports split
rows at the same price/time without treating a weighted average or last timestamp
as equivalent to distinct executions. Distinct prices/times, unsupported fields,
missing transaction evidence or ambiguous identities block definitive results.
Timestamp matching retains fractional seconds through nine digits; reported
latencies remain milliseconds. Original strings and UTC/ET representations are
preserved. Absent optional order fills create no fabricated gap: transactions
can establish evidence, with `order_fill_scope: NOT_SUPPLIED`. If only some legs
supply fills, `SUPPLIED_LEGS_ONLY` explicitly limits cross-source reconciliation.

Attempt `broker_first_fill`, `broker_last_fill`, working-interval fill endpoints
and OO clock differences derive only from reconciled transactions, never a union
of order and transaction clocks. `execution_evidence` exposes the timing basis
and reconciliation gaps; raw observations remain in order legs and transactions.
Conflicting sources produce `coverage.gaps` and `UNRESOLVED`, suppress affected
timing, closure, package cost, side/campaign realized P/L and definitive summary
claims. An episode containing uncertain executed/filled attempts cannot substitute
an earlier valid fill as its definitive final close. Observed fill presence and
independent lifecycle route/cancel timestamps remain available.

## Exact cash flows, independent sides and root cause

Financial inputs remain decimal strings and use `ExactDecimal`, never JS
floating-point cash arithmetic. Side/campaign cash flows, episode package debit
and full-closure confirmation share per-transaction reconciliation: supported
USD trades, exact symbols and opening/closing actions, positive quantities,
nonnegative per-leg prices, execution timestamps and no unreconciled reversals.
Signed gross cash flow uses provider value/effect, cross-checking per-leg
price × quantity × SPX multiplier 100. If provider value is absent, supported
price/quantity arithmetic can establish gross cash flow; an invalid supplied
value/effect cannot be ignored.
Independent expiration CALL/PUT groups support verticals, iron condors and
partial fills; they do not merge a put stop into a call stop.
Quantities and opening-before-closing inventory are reconciled. Window round-trip
gross P/L requires balanced opened/closed inventory, known actions, supported
transactions and complete provider pagination. Unmatched/prewindow entries,
reversals, mismatched leg values and open/partial inventory block realized claims.

Fees retain every component and cash-flow effect. Missing components are **not
zero**. Estimated fees, missing net values/effects or net-versus-fee discrepancies
block realized net completeness, while supported gross P/L can remain available.
Observed fee/net arithmetic is distinct from verified realized amounts.
Side totals describe the requested expiration/side window, not strategy or
full-lifetime campaign attribution. Campaign totals cover only explicitly
caller-referenced order IDs; no field claims that these comprise all strategy
history. Filled status alone is insufficient for `CLOSED_CONFIRMED`: all closing
legs require matching, reconciled execution quantities/actions/prices/times and
complete provider pagination. Episode package debit, threshold-to-fill cost
difference and final-fill latency require that same complete closure; package
debit additionally requires equal positive leg quantities. Conflicts or missing
gross execution evidence suppress those definitive claims and propagate into
`coverage.gaps` and `UNRESOLVED`. Valid evidence on an unrelated side remains
available; a valid closure and `UNRESOLVED` can coexist when another order has
gaps. Observed cash-flow totals are not verified realized amounts, including in
the Traditional Chinese summary. Fee/net-only gaps do not invalidate a
reconciled gross package debit or full closure.

Incident tags: `STOP_TRIGGERED`, `EXIT_WORKING`, `RETRY_LIMIT_EXHAUSTED`,
`BROKER_CANCELLED`, `BROKER_REJECTED`, `CLOSED_CONFIRMED`, `UNRESOLVED`.
Root-cause matrix uses `CONFIRMED / POSSIBLE / UNVERIFIED`. Confirmed attempt
references are not confirmed malfunction; confirmed rejected orders are not
evidence of a systemic broker outage.

This transport has no supported contemporaneous historical bid/ask source for
both legs or executable package quotes. It returns
`QUOTE_EVIDENCE_UNAVAILABLE`; marketability/liquidity and avoidable slippage remain
`UNVERIFIED`. Candles, snapshots, midpoint estimates, recorded order limits and
fills are **not** contemporaneous executable quote evidence. No stale quote flag
is fabricated when no quote exists.

## FinPilot example and acceptance boundary

See [example payload](examples/oo-broker-audit-synthetic.json).
The compact report has `coverage` (including ET-day gaps), `oo_events`,
`attempts`, `episodes`, `transactions`, `side_cash_flows`, `campaigns`,
`quote_evidence`, `evidence_matrix`, and `summary_zh_tw`.

The **SYNTHETIC issue replay** fixture tests ten canceled 3.85–4.30 attempts,
the given final order 514128125 at 8.15, per-leg 8.37/0.22 and entry 2.22/0.12:
2.10 credit, -605 USD gross and +450 USD relative to the 3.65 threshold.
The +450 is not all labelled avoidable slippage. Generated attempt/entry IDs
are synthetic, not incident evidence. For October 12, no synthetic IDs or
root-cause explanations are created; missing eligible evidence is a definite gap.

**Outstanding operational acceptance:** authorized retrieval of the real eligible
October 12 and 13 Traditional IRA histories, all unsuccessful attempts and their
actual IDs, full pagination/entitlement validation, actual transaction/fee
reconciliation and original OO log correlation. No credentials or broker network
acquisition were authorized or performed during implementation. Fixture success
does not close or satisfy that live-acquisition criterion; issue #102 stays open.

## Official API sources

Consulted during implementation:

- [Historical account orders](https://developer.tastytrade.com/reference/orders/getAccountsAccountNumberOrders/)
- [Orders OpenAPI (per-page maximum 200)](https://developer.tastytrade.com/openapi/orders.json)
- [Historical transactions](https://developer.tastytrade.com/reference/transactions/getAccountsAccountNumberTransactions/)
- [Current customer accounts](https://developer.tastytrade.com/reference/accounts-and-customers/getCustomersCustomerIdAccounts/)

Those documented GET endpoints include historical filters, pagination envelopes,
order lifecycle/replacement fields and transaction execution/fee fields. Actual
credential entitlements and historical retention must still be verified through
the separately authorized live gate.
