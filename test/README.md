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
- `LIMIT_TOUCH` and `CONSERVATIVE_CROSS`;
- sparse first-touch intervals, complete no-touch paths, and
  `NOT_VERIFIABLE`;
- entry and exit verification;
- live-paper disagreement without event mutation;
- broker dry-run acceptance without implied fillability;
- SPX adapter normalization and 0DTE exclusion;
- double-diagonal aggregate Backtester limitations;
- Backtester simulation normalization;
- timestamp-safe SPX selector candidate discovery;
- exact provider identity recovery from captured Backtester logs;
- strict exclusion of trials and outcomes later than `as_of`;
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
`spx-candidate-2026-04-15.json` fixture was captured from research-only
Backtester and simulation endpoints. Provider smoke tests should load
credentials from the environment, must not print them, and should use
research-only endpoints.
