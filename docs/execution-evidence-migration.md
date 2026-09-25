# Execution evidence contract migration

Contract version `1.0.0` makes execution provenance explicit without changing
or rewriting existing paper-simulation events.

## Existing log migration

1. Keep the original log record unchanged.
2. Add a sibling `execution_evidence` object that conforms to
   [`execution-evidence.schema.json`](./execution-evidence.schema.json).
3. Copy stable identifiers into `references.checkpoint_id`,
   `references.paper_order_id`, and `references.position_id` when available.
4. Classify the original live observation as `LIVE_CHECKPOINT`.
5. Append later Backtester or historical-path results as separate
   `POST_SESSION_REGRESSION` records. Never replace an earlier
   `PAPER_ORDER_PENDING`, assumed fill, or no-fill decision.

## Legacy field mapping

| Legacy meaning | Version 1.0.0 field |
| --- | --- |
| Combined/package quote from an exchange or broker | `evidence_type: NATIVE_PACKAGE` |
| Adverse-side arithmetic across legs | `evidence_type: SYNTHETIC_NATURAL` |
| Midpoint arithmetic | `evidence_type: SYNTHETIC_MID_REFERENCE` |
| Accepted dry-run response | `evidence_type: BROKER_DRY_RUN` |
| Later quote/candle path check | `evidence_type: HISTORICAL_PATH`, `evidence_phase: POST_SESSION_REGRESSION` |
| tastytrade Backtester output | `evidence_type: BACKTESTER_SIMULATION`, `evidence_phase: POST_SESSION_REGRESSION` |

`BROKER_DRY_RUN` confirms request validity only. It must use
`fill_model: NOT_APPLICABLE` and must not be interpreted as fillability.
Likewise, `SYNTHETIC_MID_REFERENCE` is valuation-only.

Consumers should reject unknown major versions and tolerate additive fields
within the same major version.
