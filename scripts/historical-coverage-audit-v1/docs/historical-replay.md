# Historical replay acceptance

`tastytrade_build_historical_replay_report` is a local-only aggregation tool
for frozen historical-research inputs. It compares one
`SPX-SPREAD-V1` baseline policy with one research policy, preserves the union
of their accepted candidates, and reports execution-model results without
changing candidate selection, grading, or paper state.

The output contract is `1.0.0`; its machine-readable schema is
[`historical-replay.schema.json`](historical-replay.schema.json).

## Monthly and multi-month candidate acquisition

Use `tastytrade_discover_historical_spx_candidates_range` to acquire the
frozen checkpoint-level candidate inputs for a monthly or approximately
six-month replay. Supply the authoritative trading-session list explicitly;
the MCP never infers sessions from weekdays.

The request may cover the full study window while
`max_checkpoints_per_run` bounds one invocation. If a provider timeout,
rate-limit, cache error, or invocation limit leaves work unresolved, retain
the completed checkpoint payloads and call the same logical request again
with the returned opaque `continuation_cursor`. The resumed response is
incremental and does not repeat completed checkpoints.

Use `READ_WRITE` to build immutable source evidence and retain the aggregate
manifest IDs. A deterministic replay supplies those exact IDs with
`CACHE_ONLY`; this preserves request fingerprints and disables Backtester
fallback. Keep distinct checkpoint populations separate when extending a
study beyond the 07:30 `INITIAL` population.

The 2026-09-27 August acceptance resolved all 21 sessions in one logical
request. Provider rate limiting left 16 partial checkpoints resumable while
preserving 169 reconstructed candidates; continuation did not repeat the five
terminal checkpoints. A subsequent full-range `CACHE_ONLY` invocation
completed all 21 checkpoints from 399 immutable cache hits, avoided 399
provider calls, and made no candle-provider or Backtester request.

## Frozen inputs

Freeze these values before retrieving or inspecting forward outcome evidence:

- experiment version, `run_id`, study stage, and outcome-access timestamp;
- date window and 07:30 `America/Los_Angeles` checkpoint;
- candidate-construction and measurement-basis versions and hashes;
- the baseline and research policy IDs, versions, hashes, decisions, and
  freeze timestamps;
- exact candidate symbols, leg ratios, expirations, settlements, and
  multipliers;
- separate +3 and +5 trading-day exit timestamps for every available
  candidate;
- source contract, execution profiles, and fee model; and
- immutable entry/exit source manifest IDs.

Historical candidate evidence may predate the research freeze in a
retrospective replay; the required ordering is that policy/profile decisions
are frozen before `outcome_accessed_at`, not before the historical trade
itself. The replay rejects `later_selector_fallback_used=true`. A later Backtester
trial cannot replace evidence missing at the frozen checkpoint. Samples whose
outcomes were already inspected must remain `IN_SAMPLE`.

`DD_MILD_BACK_RICH_V1` must declare `MILD_BACK_RICH_ONLY`.
`DD_RELAXED_SURFACE_V1` changes both BACK_RICH and FALLING_IV behavior and is
rejected if it is labeled as a mild-only experiment.

## Candidate and execution matrix

The report calculates these sets from the two complete decision lists:

- candidates accepted by both policies;
- candidates added by the research policy;
- candidates removed by the research policy; and
- the union of all accepted candidates.

Every candidate in the accepted union needs one record for every scenario and
both horizons. Optimistic, baseline, and stress scenarios must use the same
source contract and the same immutable manifests for a candidate/horizon
cell. Their execution profiles remain distinct:

| Role | V1 model |
| --- | --- |
| `OPTIMISTIC` | `QUOTE_PRICE_IMPROVEMENT` with zero midpoint-to-adverse fraction and zero additional cost |
| `BASELINE` | `QUOTE_PRICE_IMPROVEMENT` with caller-frozen non-optimistic assumptions |
| `STRESS` | `QUOTE_CROSS` |
| `REFERENCE` | `REFERENCE_COST`, kept in a separate `REFERENCE_MODEL` cohort |

Quote-backed and reference-model records never share a reporting cohort.
Raw candle/trade/model references remain `VALUATION_ONLY` and do not enter
performance metrics. A separately frozen #48 `REFERENCE_COST` simulation may
produce simulated metrics, but remains labeled `REFERENCE_MODEL`.
Simulation content IDs, profile/fee hashes, source contracts, candidate
identity, exact symbols, and horizon timestamps are revalidated before
aggregation.

The horizon workflow's optional research valuation keeps three source tiers
separate before execution modeling:

| Horizon `valuation_basis` | Reference type | Interpretation |
| --- | --- | --- |
| `EXACT_PACKAGE_REFERENCE` | `CANDLE_REFERENCE` | Every exact leg came from strict completed-candle evidence |
| `MIXED_OBSERVED_MODELED` | `MODEL_REFERENCE` | Observed values are unchanged and only missing exact legs are theoretical |
| `MODEL_SURFACE` | `MODEL_REFERENCE` | Every exact leg is theoretical from caller-frozen SPX and IV/surface inputs |

`MIXED_OBSERVED_MODELED` and `MODEL_SURFACE` are analysis strata, not new
execution-reference enums. Feed the emitted `execution_evidence_input` to
`tastytrade_normalize_historical_execution_evidence`; use its
`CANDLE_REFERENCE` or `MODEL_REFERENCE` only with a separately frozen
`REFERENCE_COST` profile. Never merge these cohorts with quote-backed
execution scenarios or describe them as historical fills.

## Metrics and denominators

Only `SIMULATED_FILLED` records with a closed exit enter win rate,
expectancy, profit factor, independent-trade P&L sum, and close-sequence
drawdown. The report counts but excludes:

- `NO_FILL_UNDER_MODEL`;
- `NOT_ASSESSABLE`;
- `OPEN_EXIT_UNRESOLVED`;
- `VALUATION_ONLY`; and
- `MISSING_EVIDENCE`.

Gross and net results are separate. A missing fee model keeps net P&L and the
net denominator unavailable rather than treating fees as zero. Profit factor
reports explicit `NO_LOSSES`, `NO_GAINS`, or `NO_CLOSED_POSITIONS` states
instead of inventing a numeric value.

`CLOSE_SEQUENCE_DRAWDOWN` is based on independent trades ordered by close
time. It is not portfolio mark-to-market drawdown. `account_return` remains
`null` until capital, concurrency, and sizing policies are supplied.

Execution sensitivity compares conclusions only within the same policy,
horizon, source group, and evidence strength. The report never selects a
winning scenario and never modifies a DD grade.

## CLI and MCP runner

Build a report from a frozen request:

```bash
npm run report:historical-replay -- \
  --input /private/path/replay-request.json \
  --output /private/path/replay-report.json
```

The input file is the object inside the MCP tool's `request` property. The
output file is created only when absent, which avoids silently overwriting an
earlier frozen report. The equivalent MCP call is
`tastytrade_build_historical_replay_report`.

A Skills or regression runner should execute the chain in this order:

1. acquire the complete timestamp-safe candidate set with
   `tastytrade_discover_historical_spx_candidates_range`, resuming only its
   unresolved checkpoints;
2. obtain both frozen policy outputs from the authoritative grader;
3. preserve every accepted candidate in their union, plus missing/rejected
   candidates used for the missing-data denominator;
4. retrieve frozen exact packages with
   `tastytrade_get_historical_option_package_horizons` using an authoritative
   caller-supplied trading-session calendar, then inspect its aggregate
   strict and valuation-tier coverage diagnostics;
5. normalize exact-leg quote or reference evidence with
   `tastytrade_normalize_historical_execution_evidence` (the optional horizon
   fallback supplies a complete `execution_evidence_input`);
6. run each caller-frozen execution profile with
   `tastytrade_simulate_historical_execution`;
7. assemble the complete candidate × scenario × horizon matrix; and
8. call the replay report builder, then validate the result against the JSON
   schema before handing it to regression reporting.

The runner must not write `SPX-Paper-Sim` monthly files or
forward-paper current state.

## Fixed one-week live smoke

Run the preserved initial window with a private evidence cache:

```bash
TASTYTRADE_EVIDENCE_CACHE_DIR=/private/cache \
npm run live:historical-replay-week -- \
  --output /private/replay-week.json
```

The script uses direct Path B reconstruction only; it never submits or
accepts the old 12:45 Backtester path. It fixes these 07:30 PT checkpoints and
exit dates:

| Entry | +3 trading days | +5 trading days |
| --- | --- | --- |
| 2026-08-24 | 2026-08-27 | 2026-08-31 |
| 2026-08-25 | 2026-08-28 | 2026-09-01 |
| 2026-08-26 | 2026-08-31 | 2026-09-02 |
| 2026-08-27 | 2026-09-01 | 2026-09-03 |
| 2026-08-28 | 2026-09-02 | 2026-09-04 |

The 2026-09-26 run reconstructed 16 exact selector candidates across all five
days: 2, 4, 4, 2, and 4 respectively. Every day retained immutable entry
manifests. No exact-symbol +3/+5 candle was available at its frozen 07:30
checkpoint, and the authorized DXLink candle source still exposes no
historical bid, ask, bid size, or ask size. Therefore:

- status is `NOT_ASSESSABLE`;
- quote-backed simulation count is zero;
- no replay performance report is built;
- complete performance acceptance is false; and
- no provider enablement, policy, grade, winner, or paper state changed.

The sanitized evidence is retained in
[`historical-replay-smoke-2026-09-26.json`](historical-replay-smoke-2026-09-26.json).
The private immutable cache contains the source payloads and is intentionally
not committed.
