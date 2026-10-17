# Provider-native SPX capability slice

## Outcome

**2026-10-17: `NO_GO` for expanding this baseline to March-August 2026;
the slice's empirical results are `NOT_ASSESSABLE`.** The existing authenticated
OptionOmega MCP rejected the sole `run_backtest` invocation during parameter
validation because a saved leg selector did not meet its accepted delta domain.
No run ID or job status was returned. This is an actual rejected request,
not a completed simulation, an empty trade log, or a historical-data coverage pass.
The evidence does not establish whether the rejection originated inside the
MCP adapter or its upstream service.

## Source and freeze

Anonymous baseline **SPX-A** was fixed by admission's deterministic selection:
the first SPX saved backtest in provider name order among 14 active saved tests,
not by performance. The worker read that exact saved source without reselection.
Existing saved results had already been viewed; this four-week historical
capability slice is **not untouched OOS**, a six-month study, or an optimization.

The complete source response, private source identity, full frozen request and
submission intent were persisted outside Git before submission. Freeze time:
`2026-10-17T16:06:31.351472+00:00`. Only `rangeStart` and `rangeEnd` changed, to
`2026-03-02` and `2026-03-27`; all returned strategy, risk, capital, fee, slippage,
exit and leg fields and IDs remained unchanged. Omitted source fields remained
omitted. The conflicting source selector encoding was not repaired or reinterpreted.
Usage limits were checked immediately before the one invocation; quota was
available. The rejection had been received by `2026-10-17T16:06:55Z`; exact
invocation/response timestamps were not separately instrumented.

Frozen parameters SHA256:
`a288013cd3d8e670461fd1f537e07daa2f8a7443973d0831cba696fc8f5d3fa8`.
Hash input is UTF-8 JSON with recursively sorted object keys, compact separators,
ASCII escaping, original array order and no final newline. Exact reproduction
requires the owner's private frozen artifacts: the hash is neither a public
parameter preimage nor vendor-data proof. Raw source/configuration, account-scoped
metrics, IDs and service error output are intentionally not published here.

## Requested versus observed support

| Aspect | Frozen request and observed limitation |
| --- | --- |
| Dates | Four-week range above requested; no executed range or March history support verified. |
| Legs and expiry | Source selectors, quantities, DTE policy, relationships and IDs preserved privately; selector validation rejected the request. No exact historical symbols, strikes or executed expirations observed. |
| Entry/exit | Original clock strings, entry filters and exit rules preserved without normalization. MCP describes market time/US market time; `America/New_York` is the SPX interpretation, not an explicit provider IANA/DST guarantee or submitted override. Actual timing support unverified. |
| Fees | Returned opening-fee field preserved; closing fees absent in source and left absent. Effective default, fee units/application and total fees unverified; absence does not mean zero. |
| Slippage/fills | All returned entry, exit and stop-loss slippage fields preserved. Effective fill/quote model and application unverified. Any accepted backtest would report provider-simulated fills, never broker fills. |
| Capital/open positions | Returned sizing/risk fields and end-of-test close policy preserved. Actual sizing, end-of-test treatment and open-trade count unavailable. |
| Results/logs/equity | No slice metrics or daily equity returned. Trade columns, offsets, `totalCount`, ignored/excluded rows, monthly trade counts and open trades unavailable, not zero. Pagination is inapplicable, not verified complete; no results/log/equity calls made without a run ID. |
| Metadata/rights | Dataset/revision, corrections, coverage denominators and contractual output-retention/reuse rights undisclosed. The MCP save-tool description says unsaved run records expire about an hour after start; that technical lifetime is not a retention license. No saved result was created or replaced. |

No retry, parameter repair, fallback, status poll, optimizer or portfolio run
followed the rejection. Private evidence retains the exact error, source and
request hashes, freeze/submission order, quota response and acceptance mapping.
Prior saved metrics are not results for this slice.

## Interpretation and decision

Provider tool contracts distinguish closed-trade `endingFunds`/`profit` from
mark-to-market `netLiquidity`, CAGR, drawdown and annual metrics; trade logs
exclude still-open positions, whose count belongs to the whole-run result.
None of those slice outputs exists here, so no page-derived metric or
realized-versus-marked reconciliation is claimed.

The attributable capability finding is that this unchanged saved configuration
cannot pass the observed MCP submission validation. It does **not** establish
independent quotes, raw history completeness, IV/Greeks paths, dynamic exits,
staged SIC, cross-expiry execution fidelity, local replay equivalence or broker
execution. Those claims still need their own exact-leg observations/replay.
A native-quote archive was not imposed as a prerequisite for this attempt.

**Do not expand this baseline to March-August 2026 on this evidence.** Resolving
source/tool compatibility would require a separately authorized decision and
new frozen attempt, not silent tuning or another baseline. Issue #111's honest
failure-documentation path is exercised; successful simulation acceptance is
not claimed. No full WF/OOS study, production promotion, runtime change or study
contract change is included. [The #42 external-adapter decision](historical-provider-decision.md)
remains `DO_NOT_ENABLE`.
