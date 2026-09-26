# Private historical evidence cache

The source cache is an opt-in, private research facility for historical
provider evidence. It is not the live decision log, the paper-simulation
archive, or the canonical SPX Drive archive. Enabling it does not change
routing, retention, frozen grades, candidate legs, fills, or P&L.

## Storage model

The filesystem backend separates immutable content from mutable lookup state:

```text
<private-cache>/
  objects/sha256/      immutable sanitized provider and normalized objects
  manifests/sha256/    immutable evidence revisions and manifest sets
  indexes/requests/    mutable request-fingerprint to revision lists
  failures/requests/   mutable short-lived retryable-failure pointers
```

Directories are created with mode `0700` and files with mode `0600`.
Writes use a same-directory temporary file, `fsync`, atomic publication, and
read-back verification. Objects and manifests are addressed by SHA-256 over
canonical JSON. Mutable indexes have their own checksums.
The versioned machine-readable manifest contract is
[`evidence-cache.schema.json`](evidence-cache.schema.json).

The backend does not evict immutable evidence. A write that would exceed the
configured quota fails with `EVIDENCE_CACHE_QUOTA_EXCEEDED`, leaving existing
objects untouched. This ensures raw evidence is never removed as part of an
unverified cleanup or replacement.

## Identity and revision contract

The mutable lookup fingerprint covers:

- provider ID and non-sensitive dataset/license-scope IDs;
- exact symbol, streamer symbol, and instrument type in request order;
- requested, native, and effective aggregation;
- session, alignment, and fixed `LAST` price type;
- exact request range and `as_of`;
- the complete versioned resolution profile, including age/skew and fallback
  policy;
- normalized resource policy;
- normalization, model, and source revisions.

`retrieved_at` is unknown before a provider call, so it is not part of the
mutable lookup fingerprint. It is part of every immutable revision manifest,
whose own content-addressed ID is the frozen cache identity. References and
evidence roles are also manifest context rather than source lookup identity.
Changing only `checkpoint_id`, `paper_order_id`, or `position_id` therefore
creates a new immutable contextual revision over the same verified objects
without refetching candles.

Each evidence manifest links:

1. a sanitized provider-observation object;
2. the normalized historical-candle result object;
3. the normalized object's `derived_from` content ID;
4. per-result status, actual coverage, END/SNIP state, failure reasons, and
   warnings;
5. exact bar `source_time`, `bar_start`, `bar_end`, `available_at`, and
   `retrieved_at` fields.

`retrieved_at` is preserved as retrieval provenance and never substituted for
`available_at`. `REFRESH` always writes a new immutable revision and a
machine-readable diff; it never overwrites frozen evidence.

## Configuration

Set the backend on a private, provider-license-compliant volume:

```bash
export TASTYTRADE_EVIDENCE_CACHE_DIR=/private/tastytrade-evidence
export TASTYTRADE_EVIDENCE_CACHE_DEFAULT_MODE=BYPASS
export TASTYTRADE_EVIDENCE_CACHE_MAX_BYTES=1073741824
export TASTYTRADE_EVIDENCE_CACHE_MAX_CONCURRENCY=4
export TASTYTRADE_EVIDENCE_CACHE_RETRYABLE_FAILURE_TTL_MS=30000
```

Optional identity defaults are:

```bash
export TASTYTRADE_EVIDENCE_CACHE_DATASET_ID=tastytrade-dxlink-candles
export TASTYTRADE_EVIDENCE_CACHE_LICENSE_SCOPE_ID=private-research
export TASTYTRADE_EVIDENCE_CACHE_NORMALIZATION_VERSION=historical-candles/1.0.0
export TASTYTRADE_EVIDENCE_CACHE_MODEL_VERSION=no-model/1.0.0
export TASTYTRADE_EVIDENCE_CACHE_SOURCE_REVISION=dxlink-indexed-candle/1
```

The cache is disabled when `TASTYTRADE_EVIDENCE_CACHE_DIR` is absent. It is
bypassed by default even when configured, preserving existing behavior.
Neither the path nor provider payload is exposed as an MCP tool argument.

## MCP handoff

The existing historical-candle, SPX candidate/universe, and exact-package
tools accept `evidence_cache`; the tool count remains 17.

An online read-through request uses:

```json
{
  "evidence_cache": {
    "mode": "READ_WRITE",
    "dataset_id": "tastytrade-dxlink-candles",
    "license_scope_id": "private-research",
    "source_revision": "dxlink-indexed-candle/1",
    "normalization_version": "historical-candles/1.0.0",
    "model_version": "no-model/1.0.0",
    "evidence_role": "ENTRY"
  }
}
```

Direct candle results return one `evidence_cache` record. Higher-level
candidate, universe, checkpoint, and path results return an aggregate with
the exact `manifest_ids`, normalized/provider content IDs, hit/miss counts,
bytes, and avoided provider calls.

Replay only immutable manifests:

```json
{
  "evidence_cache": {
    "mode": "CACHE_ONLY",
    "manifest_ids": [
      "sha256:<immutable-source-manifest-or-manifest-set>"
    ],
    "dataset_id": "tastytrade-dxlink-candles",
    "license_scope_id": "private-research",
    "source_revision": "dxlink-indexed-candle/1",
    "normalization_version": "historical-candles/1.0.0",
    "model_version": "no-model/1.0.0",
    "evidence_role": "ENTRY"
  }
}
```

`CACHE_ONLY` never calls the provider. A missing manifest/shard, checksum
failure, source revision mismatch, provider/profile/aggregation mismatch,
resource-policy mismatch, or undeclared resolution fails closed. A manifest
set can bind `ENTRY`, `OUTCOME_3_TRADING_DAYS`, and
`OUTCOME_5_TRADING_DAYS` evidence across month boundaries. Candidate
discovery accepts only `ENTRY`, so forward outcomes cannot enter the entry
selector.

## Partial and failed retrievals

Completed `AVAILABLE`, `PARTIAL`, and `NOT_AVAILABLE` responses are immutable
evidence revisions. Their actual ranges, warnings, snapshot flags, and
failure reasons replay exactly.

Provider exceptions create immutable failure manifests. Retryable failures
also receive a separate mutable TTL pointer. They never enter the valid
evidence index, never overwrite a valid historical revision, and expire as a
retry suppression signal rather than becoming permanent contract-absence
facts. If valid evidence already exists, normal `READ_WRITE` requests prefer
it over a later temporary failure.

Normalized results carrying `SNAPSHOT_TIMEOUT` or a local receive, buffer, or
output budget failure follow the same short-lived path: the full response is
preserved immutably for provenance and exact replay, but only the TTL failure
index points to it. A later normal read retries after expiry instead of
treating the temporary `NOT_AVAILABLE` result as permanent contract absence.

## Migration

1. Provision a private volume and set the cache environment variables. Do not
   point the backend into the repository or a public artifact directory.
2. Keep `BYPASS` while validating permissions and quota.
3. Opt selected regression calls into `READ_WRITE` and persist the returned
   manifest IDs with the research run. Do not rewrite live decision events.
4. Re-run with `CACHE_ONLY` and those exact IDs. Treat any mismatch or missing
   shard as a failed replay.
5. Use `REFRESH` only for a new research run. Compare its manifest `diff` and
   retain the earlier revision.
6. Bundle entry and post-entry source manifests when a run needs cross-month
   +3/+5 trading-day evidence. Keep outcome manifests outside candidate
   discovery.

Existing archives are not imported, migrated, deleted, or reclassified by
this feature.

## Reproducible synthetic report

Run:

```bash
npm run report:evidence-cache
```

The command uses only generated synthetic values in a temporary private
directory. It prints the first-run miss, second-run exact cache-only hit,
stable normalized SHA-256 ID, bytes read/written, and provider-call
reduction. No licensed market payload is written to repository fixtures.

Expected report for the fixed synthetic input:

| Measurement | Result |
| --- | ---: |
| First run | `MISS` |
| First-run provider calls | 1 |
| First-run bytes written | 9,485 |
| Second run | `CACHE_ONLY_HIT` |
| Second-run provider calls | 0 |
| Second-run bytes read | 9,111 |
| Normalized hash stable | `true` |
| Calls avoided versus two uncached runs | 1 of 2 (50%) |
