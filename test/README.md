# Test coverage

Run:

```bash
npm test
```

The suite builds the TypeScript project before running Jest and covers:

- exact decimal arithmetic;
- execution-evidence contract invariants;
- debit and credit vertical package pricing;
- iron condor and multi-expiration double diagonal pricing;
- native versus synthetic provenance;
- stale, missing, crossed, and timestamp-misaligned quote handling;
- midpoint valuation-only semantics;
- completed-bar historical exact-leg package valuation;
- checkpoint observation age and multi-leg temporal-skew rejection;
- bounded 1-minute to 5-minute package-path fallback without resampling;
- exact package-path gaps without interpolation or forward fill;
- default five-minute and explicit native-hour resolution profiles;
- requested/native/effective aggregation and provider-cohort separation;
- completed versus incomplete native-hour RTH bars at a 07:30 PT checkpoint;
- IANA-local checkpoint conversion before and after Pacific DST, including
  rejection of ambiguous and nonexistent local instants;
- preservation of bar start/end, availability, retrieval, and opaque
  candidate-construction metadata;
- versioned Double Diagonal selected-leg, matched-delta, and
  matched-forward-moneyness IV cohorts;
- exact decimal-to-vol-point conversion, PUT/CALL divergence, null/NaN,
  stale/incomplete/future-bar rejection, delta/moneyness coverage gaps,
  bounded interpolation, no extrapolation, and ambiguous legacy-unit
  preservation;
- deterministic regeneration of the grading/regression handoff fixture
  without embedding downstream bucket or routing policy;
- immutable content-addressed evidence objects and revision manifests;
- exact DD/DV cache-only replay with zero provider calls and stable hashes;
- cache identity separation by provider, source revision, profile, and
  aggregation, with reference-only object reuse;
- partial coverage, retryable-failure isolation, corruption, concurrent
  deduplication, bounded concurrency, atomic writes, and disk quotas;
- cross-month entry/+3/+5 trading-day manifest sets with outcome evidence
  excluded from entry candidate selection;
- `LIMIT_TOUCH` and `CONSERVATIVE_CROSS`;
- sparse first-touch intervals, complete no-touch paths, and
  `NOT_VERIFIABLE`/`NOT_ASSESSABLE`;
- entry and exit verification;
- live-paper disagreement without event mutation;
- broker dry-run acceptance without implied fillability;
- SPX adapter normalization and 0DTE exclusion;
- double-diagonal aggregate Backtester limitations;
- Backtester simulation normalization;
- checkpoint-safe SPX selector candidate discovery;
- exact provider identity recovery from captured Backtester logs;
- strict exclusion of stale and future selector trials that do not occur
  exactly at `as_of`;
- empirical coverage proving undocumented Backtester `entryTime` is ignored
  and must not be trusted;
- point-in-time price/delta enrichment for recovered SPX contracts;
- provider log-shape drift returning `NOT_AVAILABLE` instead of guessed identity;
- DXLink compact Candle parsing and snapshot flags;
- regular and custom overnight session windows;
- untrusted DXLink-host rejection;
- MCP tool discovery and dispatch;
- authenticated Streamable HTTP access, public health checks, and request
  body limits;
- Entra JWT signature, issuer, audience, expiry, and scope validation;
- RFC 9728 protected-resource metadata and OAuth challenges.

Live credentials are not used by automated tests. The sanitized
`spx-candidate-2026-04-15.json` identity fixture and
`spx-candidate-entry-time-ignored-2026-08-25.json` checkpoint fixture were
captured from research-only Backtester and simulation investigation. Provider
smoke tests should load credentials from the environment, must not print them,
and should use research-only endpoints.
