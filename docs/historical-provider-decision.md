# Historical provider capability and entitlement decision

## Decision

**`DO_NOT_ENABLE`**

No external historical-data provider is selected, purchased, configured, or
connected by #42. The public material reviewed does not establish all of the
following for one approved dataset:

- exact SPX index and expired SPXW contract coverage from 2026-03-01 through
  2026-08-31;
- timestamp-safe price, IV, delta, and quote semantics around 10:30 ET;
- the same-method evidence needed for frozen legs at +3 and +5 trading days;
- contractual permission to retain and replay provider observations in the
  private immutable evidence cache;
- final rate limits, credentials, fees, and intended-use approval.

An endpoint existing, a vendor advertising broad options history, or a
tastytrade DXLink quote token working does not satisfy those requirements.
Any paid sample, subscription, license acceptance, credential provisioning,
or external-provider activation still requires separate explicit user
approval.

## Existing coverage evidence

The #40 native-hour capability run sampled seven 07:30 America/Los_Angeles
checkpoints:

`2026-03-02`, `2026-04-01`, `2026-05-01`, `2026-06-01`, `2026-07-01`,
`2026-08-03`, and `2026-08-25`.

Each checkpoint requested 102 contract observations. Only five of 714
requested observations were eligible, all on `2026-08-25`; the other six
checkpoints had zero eligible contracts. That is approximately 0.7% sampled
coverage, so the result is **not** a six-month pass and does not establish
+3/+5 trading-day coverage.

The empty or ineligible observations are not assigned a single speculative
cause. #38 and #39 fixed independent client budgets and native-hour symbol
matching, but remaining gaps may still reflect provider retention, an
unsupported expired symbol, no qualifying bar, dataset coverage, or
entitlement. Empty data alone is not proof of any one cause.

## Provider comparison

| Candidate | Publicly documented capability | Still unconfirmed for this project | Decision |
| --- | --- | --- | --- |
| tastytrade DXLink entitlement | tastytrade documents a short-lived quote token used with the returned DXLink WebSocket URL for streaming market data. | No tastytrade document reviewed grants that token access to dxFeed Candlewebservice or TickData. Six-month expired-SPXW coverage remains insufficient in the measured path. | Keep the existing DXLink path fail-closed; do not treat the quote token as a historical-service credential. |
| dxFeed Candlewebservice | Accepts `Candle` or `TimeAndSale`, explicit `start`/`stop`, and documents a maximum seven-day range. Candle examples expose OHLC, volume, VWAP, bid/ask volume, implied volatility, and open interest. History depth can depend on permissions. | Separate service entitlement, exact expired SPXW symbols, retention, rate limits, price/IV semantics, final cost, and storage/reuse rights. Candle data does not itself prove historical NBBO or provider-native delta. | Technically plausible, but not approved or enabled. |
| dxFeed TickData | Documents historical access from 2014 subject to entitlement, with separate service-level and symbol-level permissions. Missing rights may return an empty response or an error. Quote and trade records can support independent reconstruction. | Exact expired SPXW entitlement, available event fields, request limits, cost, redistribution/storage terms, and the model required for comparable IV/delta. | Technically plausible, but not approved or enabled. |
| Cboe DataShop | Option Quote Intervals advertise one-minute/custom intervals, NBBO, OHLC, volume, optional IV/Greeks, and U.S. index options history from January 2012. Option Trades advertise trade price/size, contemporaneous NBBO, optional IV/Greeks, and the same historical start. | A legal sample proving the exact requested SPXW contracts and timestamps, product/file delivery fit, final order price, calculation methodology/version, CGIF implications for SPX underlying data, and storage/reuse terms. | Candidate for a paid sample only after explicit approval. |
| ThetaData | Offers options-data services and a separate subscriber agreement. | The public Terms limit service use to personal, non-commercial use and prohibit archiving/downloading/data extraction. This repository's immutable replay design therefore needs a negotiated written commercial license and explicit storage rights. | Do not use under the public individual terms. |

Historical bid/ask or NBBO, if later licensed, improves evidence but does not
turn a synthetic multi-leg quote or a `TOUCHED` path into a broker fill.
Production grading and execution claims remain unchanged.

## Approval-gated adapter

The repository includes a provider-neutral contract in
`src/bounded-history-provider.ts`, but no concrete vendor transport, endpoint,
credential, environment variable, automatic fallback, or MCP tool wiring.
It cannot be instantiated unless configuration carries an approval reference
whose provider, dataset, and license scope exactly match the adapter.

The dormant contract enforces:

- a fixed HTTPS endpoint and exact public-host allowlist, with redirects left
  disabled by the concrete transport;
- provider-specific credential variable names and rejection of
  `TASTYTRADE_*` credential reuse;
- confirmed field entitlements, a provider-specific native-field allowlist,
  and confirmed expired-symbol coverage before the adapter can retrieve any
  part of this historical research scope;
- start-inclusive/stop-exclusive UTC windows, IANA conversion, deterministic
  bounded sharding, bounded pagination, timeout, retry/backoff, record, byte,
  and output limits;
- exact requested/native symbols, timestamp-safe availability, provider
  revision/method provenance, explicit nulls, and rejection of undeclared or
  credential-shaped provider data;
- `PARTIAL` or `NOT_AVAILABLE` results for incomplete evidence rather than
  success-shaped fallback;
- exact provider/dataset/license/source identity, end-time `as_of`, declared
  lifecycle, and separately confirmed cache storage/reuse permission before
  #41 manifests can be written or read.

The contract tests use synthetic records only. They prove adapter behavior,
not vendor capability or entitlement.

## Blocked acceptance items

Because no source is approved, these conditional #42 checks remain
**BLOCKED**, not passed:

- one recent external-provider SPX plus exact-four-leg fixture;
- one March 2026 external-provider SPX plus exact-four-leg fixture;
- field/timestamp/method comparison against overlapping DXLink evidence;
- monthly six-month coverage and frozen-leg +3/+5 horizon coverage.

They become actionable only after the approvals below. Synthetic contract
fixtures must not be cited as market-data coverage.

## Required confirmations before enablement

1. Obtain written vendor confirmation for the exact provider, dataset,
   account, SPX index, expired SPXW symbology, historical range, and requested
   fields.
2. Obtain a legal sample covering one recent checkpoint and one March 2026
   checkpoint, including the exact four frozen legs and +3/+5 dates.
3. Record timestamp boundaries, timezone, revisions, corrections, pagination,
   rate limits, and whether IV/delta are native or derived (including model
   and inputs).
4. Obtain written storage, retention, derived-data, and replay permission for
   the private content-addressed cache.
5. Obtain the final price and explicit user approval for every purchase,
   subscription, or license.
6. Provision provider-specific credentials without reusing tastytrade
   credentials, implement a concrete transport that refuses redirects and
   bounds response bytes, then run the blocked fixtures and coverage matrix.
7. Enable a provider only if those results satisfy the declared cohort and
   timestamp rules. Otherwise retain `DO_NOT_ENABLE`.

## Sources reviewed

- tastytrade, [Stream market data](https://developer.tastytrade.com/docs/guides/stream-market-data/)
- tastytrade, [Get API Quote Token](https://developer.tastytrade.com/reference/accounts-and-customers/getApiQuoteTokens/)
- dxFeed, [Candlewebservice](https://kb.dxfeed.com/en/data-services/aggregated-services/candlewebservice.html)
- dxFeed, [Candle types and historical availability](https://kb.dxfeed.com/en/data-services/aggregated-services/candle-types.html)
- dxFeed, [How to request TickData](https://kb.dxfeed.com/en/data-services/historical-services/how-to-request-tick-data.html)
- Cboe DataShop, [Option Quote Intervals](https://datashop.cboe.com/option-quote-intervals)
- Cboe DataShop, [Option Trades](https://datashop.cboe.com/option-trades)
- ThetaData, [Terms and Conditions](https://www.thetadata.net/terms-and-conditions)
- ThetaData, [Subscriber Agreement](https://www.thetadata.net/subscriber-agreement)
- ThetaData, [Commercial use](https://www.thetadata.net/commercial-use)
