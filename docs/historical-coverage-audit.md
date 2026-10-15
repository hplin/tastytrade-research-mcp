# Six-month exact-leg coverage audit (#98)

## Result: BLOCKED; source remains DO_NOT_ENABLE

This is a bounded **offline inventory of checked-in evidence**, not an
acquisition, quote service, six-month market-coverage pass, or performance
backtest. [#42's provider decision](historical-provider-decision.md) remains
the source of truth for entitlement, licensing, storage, and cost. No provider,
credentials, `.env`, private cache, live endpoints, or other worktrees are
consulted. No grading, trade decisions, or production runtime tools change.

The reproducible report is
[`historical-coverage-audit-issue-98.json`](historical-coverage-audit-issue-98.json).
It records all six entry months, March–August 2026, with **unknown/null** frozen
denominators and BLOCKED family coverage. Nothing is extrapolated from recent
data to March or from isolated samples to the full time series.

## Reproduce and resume

```bash
npm run report:historical-coverage -- --check --output docs/historical-coverage-audit-issue-98.json
# New report: exclusive creation; refuses to replace existing evidence.
npm run report:historical-coverage -- --output coverage-audit.json
# Independent, deterministic month shards; rerun only a missing shard.
npm run report:historical-coverage -- --month 2026-03 --output coverage-2026-03.json
```

These commands build and import **this checkout's** `dist/`. The script resolves
all source paths relative to itself, not a caller's working directory. Its only
source inputs are seven explicitly named, byte-SHA-256-pinned repository
artifacts/documents, at most 128 KiB each. A changed, unknown, symlinked, or
oversized source fails closed. It accepts no arbitrary evidence input or provider
configuration. Seven local reads and 56 observation rows bound the entire
inventory; no pagination, retries, or network requests are needed.

Each month shard shares the full audit's `audit_id`, source identities, and
generator hash. Select shards by `scope.months` and require one of each month
under the same `audit_id` before concatenating their `family_matrix` and
`observations`; never sum repeated `separate_prior_art` cohorts. Repeating a
month returns identical bytes. There is no mutable cursor, checkpoint database,
clock-dependent output, or query fallback. `report_id` uses #41's canonical
`stableEvidenceContentId` over the report excluding `report_id`; the audit ID
binds the generator bytes, seven source identities, and full six-month scope.
This report is **not** a #41 provider manifest and grants no storage rights.

Input changes require a deliberate new audit revision after inspecting the new
evidence, updating pins and interpretation, and rerunning tests. Do not relax
pin checks to ingest arbitrary or synthetic fixtures as measured coverage.
Preserve the original report in version history; `--check` never writes.

## What the matrix can actually establish

| Evidence cohort (never pooled) | Known numerator/denominator | Limits |
| --- | --- | --- |
| #40 native-hour summary | 5 eligible reference observations / 714 requested observations; seven checkpoints, 102 each | Aggregate summary only; all five eligible on August 25. No frozen per-symbol inventory, six-month time series, exact package, or +3/+5 proof. |
| September 26 capability, March 2 checkpoint | NOT_AVAILABLE; 0 reconstructed contracts; expected frozen denominator unknown | No listed exact contracts, native historical bid/ask/size, or complete SPX candle. Zero returned is not zero expected. |
| September 26 capability, August 25 checkpoint | 12 reported reconstructed contracts; 8 named; 4 identities absent; 12 candle closes and 11 candle IV reported | Aggregate field counts are not per-symbol observations. No identities invented for the omitted four. Bid/ask/size absent for the 12 returned contracts; 12 is not an eligible frozen denominator. |
| September 26 replay smoke, August 24–28 | 16 enumerated entry candle-reference rows, 32 requested +3/+5 contract observations without references | These are discovery contracts, not frozen graded family packages. Zero quote-backed rows; no early-exit or INITIAL inventory. Exact scheduled exits into September retained. |
| PR105 documented BID/ASK 1m probe | October 13: two exact symbols with 9/9 and 6/7 BID/ASK bars. July 2 exact symbol: 0/0 BID/ASK bars, SNAPSHOT_SNIP | October is outside scope. July LAST 1h (7 bars) and 1d (1 bar) are separate resolutions, not minute quote substitutes. No synchronized quote events/sizes or frozen denominator. |

The report's **56 enumerated artifact rows** comprise eight capability sample
identities, 16 entry reference observations, and 32 missing exit references.
Their artifact-row classification is 0 quote-backed, 16 reference-only,
0 modeled, 40 NOT_ASSESSABLE. This is a denominator for *enumerated artifact
rows only*, not six-month market coverage, family coverage, or licensed native
observations. The eight sample identities are NOT_ASSESSABLE because they lack
per-symbol event observations. The smoke has 16 candidate discoveries and five
dates, not 16 completed trades or five passing trading sessions.

Every known exact OCC symbol is parsed using #61's existing strict SPX/SPXW
parser. Strike, expiry, option type, root, entry date, checkpoint timestamp,
session date, and calendar DTE are retained. Front/back DTE, family membership,
and INITIAL identity remain null: discovery selectors do not define frozen
leg roles. `trading_month` is the entry month, including when an outcome session
falls in September.

Each observation separates native bid/ask/size, native quote IV/Greeks,
completed candle close/IV, reported historical delta of unverified origin,
independent modeled valuation, and missing observations. No native Greeks are
inferred from historical delta. Candle start/end/availability/retrieval are
distinct; unknown native event time remains null. Age is computed from
availability to checkpoint using the original 60-minute smoke freshness limit,
not retrieval time. Unknown crossed/stale states are null, not false. Entry
reference values are summary observations, not independently recovered cache
payloads; `cache_content_verified` is false. Manifest/content IDs retain their
original provenance but are not treated as recovered #41 objects.

## Family and synchronization gate

There are 48 family/month rows and 258 required family/checkpoint cells:

- DEBIT_VERTICAL and CREDIT_VERTICAL: two exact legs.
- Single CALL_CALENDAR and PUT_CALENDAR: two exact legs with frozen front/back
  expiry roles; never double calendars inferred from discovery symbols.
- BWB: three distinct exact legs plus frozen quantities (including the body).
- IRON_CONDOR and DOUBLE_DIAGONAL: four exact legs.
- SIC: frozen stage/event inventory, active exact legs and quantities at each
  open/adjust/exit event; the number of legs cannot be assumed globally.

Each row names INITIAL, ENTRY, EARLY_EXIT, +3 session, and +5 session checkpoints.
SIC additionally names stage open/adjust/exit requirements; these are required
dimensions, **not evidence that any such events occurred**. A family/month
row's null metrics apply independently to every listed checkpoint. No packages
are assembled from ungraded discovery contracts. Numerators, expected
observations, entry/exit counts, exclusion counts, synchronized checkpoint
counts, and classified coverage all remain null until a frozen inventory is
supplied. No percent or 0/0 success is produced.

#61 already supports frozen exact-leg ENTRY/+3/+5 session requests without
manufacturing trading calendars; #49 separates quote/reference/model evidence
and performance acceptance; #41 provides immutable sanitized content identities.
This audit reuses their semantics and #41 hashing/#61 symbol parsing, without
expanding MCP runtime family support. Existing package tools support two-leg
verticals and four-leg IC/DD, **not** calendar/BWB/SIC valuation; this inventory
does not claim to implement those valuations.

To assess actual coverage, the missing authorized input must define every
INITIAL family package, leg action/quantity/role, exact symbol, front/back DTE,
session calendar, entry and scheduled/actual early exits, and SIC stage events.
Then every checkpoint needs native event and availability times, provider/
dataset/license scope/revision, exact immutable manifest/payload identities,
resolution/method/synthetic cohort, native bid/ask and size, IV/Greeks origin,
freshness threshold, crossed/stale/missing reasons, leg temporal skew, and
complete synchronized active-leg count. A missing quote cannot be replaced by
a candle, modeled valuation, synthetic midpoint, newer contract, or current data.
Synchronized quotes still are not evidence of a broker fill.

## Vendor/rights/cost decision and acceptance

No new entitlement experiment was conducted. The existing #42 comparison
remains unchanged: tastytrade DXLink quote tokens do not establish historical
service rights; dxFeed Candlewebservice/TickData require separate exact-symbol/
service entitlement; Cboe DataShop needs a legally approved exact-leg sample and
final price; ThetaData's public individual terms do not permit this immutable
archive design. No vendor selected. Final cost, written historical entitlement,
legal storage scope, retention/replay/derived-data rights remain unknown.
A `license_scope_id` string in an old report is **not** license authorization.

| #98 acceptance | Result |
| --- | --- |
| AC1: complete six-month per-month/per-symbol/per-family numerators, denominators, entry/exits and exclusions | **BLOCKED**: frozen INITIAL package inventory, session/event inventory and actual cache payloads unavailable. All required dimensions represented; counts not fabricated. |
| AC2: separate quote-backed/reference-only/modeled/NOT_ASSESSABLE with exact times and legal storage scope | **BLOCKED overall**: available artifact classes and timestamps separated; native events, actual six-month coverage and written legal storage scope unavailable. |
| AC3: recent and older bounded historical evidence, or explicit BLOCKED evidence | **PASS for explicit blocked-evidence alternative only**: pinned March 2 failure vs August 25 partial capability, plus the five-day smoke. Not a historical quote-coverage pass. |
| AC4: no quote-backed performance without bid/ask; midpoint is not execution | **PASS**: no quote-backed performance claim or synthesized fill. |
| AC5: no paid enablement/production grading/trade decision changes | **PASS**: local audit/report/tests only; DO_NOT_ENABLE preserved. |

**Full #98 acceptance remains unfulfilled.** Closing the real-data gaps requires
separate owner authorization for any acquisition, paid sample, provisioning,
license acceptance, or provider enablement. Authorization alone does not prove
coverage: retain DO_NOT_ENABLE unless licensed, frozen, exact-leg observations
actually satisfy the declared checkpoints and cohorts.
