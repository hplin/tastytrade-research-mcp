import { createHash } from "node:crypto";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { stableEvidenceContentId } from "../dist/evidence-cache.js";
import { parseHistoricalOptionSymbol } from "../dist/historical-option-package.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const VERSION = "issue-98-offline-coverage/1";
const MONTHS = ["2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08"];
const CHECKPOINTS = ["INITIAL", "ENTRY", "EARLY_EXIT", "PLUS_3_TRADING_DAYS", "PLUS_5_TRADING_DAYS"];
const FAMILIES = [
  ["DEBIT_VERTICAL", 2], ["CREDIT_VERTICAL", 2],
  ["CALL_CALENDAR", 2], ["PUT_CALENDAR", 2],
  ["BWB", 3], ["IRON_CONDOR", 4], ["DOUBLE_DIAGONAL", 4], ["SIC", null],
];
const PINS = Object.freeze({
  "docs/historical-provider-decision.md": "2ad9f2c7ea524701a6111368bf6e21bdc748849efb221da3195b82cc2ebb4445",
  "docs/historical-candles.md": "dd67a4be1f209cda7cb7ca885dd5d550d1fa1aa67dfd0f90ffa84e844110e03f",
  "docs/historical-option-package.md": "b8e2096b22f49147d2130f85c4b1418d3ad06f4166b251529637a6f777e23a43",
  "docs/historical-replay.md": "029abff6613c02ca9c7fbd0f82f89698dfda35c4591bc33865d14089829c5e62",
  "docs/evidence-cache.md": "05743fdade5d19b7cfbd208cf71380ce5462a14758c16c865dac8965254373c7",
  "docs/historical-quote-capability-2026-09-26.json": "221258ffee16f94386a982a09f666a6b25017d3f4a9838cec66a4ff0830ec069",
  "docs/historical-replay-smoke-2026-09-26.json": "4f3d31163c76f3fb1c072b4da6e8623cf6f6e2ba11e584c03cb31f6cca22896b",
});
const BLOCKERS = [
  "SIX_MONTH_FROZEN_INITIAL_INVENTORY_NOT_SUPPLIED",
  "EXACT_FAMILY_LEGS_QUANTITIES_AND_STAGE_EVENTS_NOT_SUPPLIED",
  "EARLY_EXIT_AND_COMPLETE_TRADING_SESSION_CHECKPOINTS_NOT_SUPPLIED",
  "NATIVE_HISTORICAL_BID_ASK_SIZE_NOT_SUPPLIED",
  "REFERENCED_CACHE_OBJECTS_AND_MANIFESTS_NOT_RECOVERED",
  "WRITTEN_ENTITLEMENT_STORAGE_REPLAY_RIGHTS_AND_FINAL_COST_UNCONFIRMED",
];
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function verifyPinnedSource(path, bytes) {
  if (!Object.hasOwn(PINS, path) || sha256(bytes) !== PINS[path]) {
    throw new Error(`Unrecognized or changed audit source: ${path}`);
  }
}

async function loadSources() {
  const sources = {};
  for (const path of Object.keys(PINS)) {
    const url = new URL(path, pathToFileURL(`${ROOT}/`));
    const stat = await lstat(url);
    if (!stat.isFile() || stat.size > 131072) throw new Error(`Unsafe audit source: ${path}`);
    const bytes = await readFile(url);
    verifyPinnedSource(path, bytes);
    sources[path] = bytes.toString("utf8");
  }
  return sources;
}

function contract(symbol, sessionDate) {
  const parsed = parseHistoricalOptionSymbol(symbol);
  return {
    exact_occ_symbol: symbol,
    root: symbol.slice(0, 6).trim(),
    option_type: parsed.option_side,
    strike: parsed.strike,
    expiry: parsed.expiration,
    calendar_dte: (Date.parse(parsed.expiration.slice(0, 10)) - Date.parse(sessionDate)) / 86400000,
    front_dte: null,
    back_dte: null,
    family: null,
    frozen_initial_id: null,
  };
}

function observation(symbol, entryDate, sessionDate, checkpoint, checkpointAt, cohort) {
  return {
    ...contract(symbol, sessionDate),
    trading_month: entryDate.slice(0, 7),
    entry_date: entryDate,
    session_date: sessionDate,
    checkpoint,
    checkpoint_at: checkpointAt,
    cohort,
    coverage_denominator: null,
    evidence_class: "NOT_ASSESSABLE",
    native_bid: null,
    native_ask: null,
    bid_size: null,
    ask_size: null,
    native_quote_iv: null,
    native_quote_greeks: null,
    candle_close: null,
    candle_iv: null,
    reported_historical_delta: null,
    reported_delta_origin: "UNKNOWN",
    modeled_value: null,
    source_time: null,
    bar_start: null,
    bar_end: null,
    available_at: null,
    retrieved_at: null,
    age_minutes: null,
    stale: null,
    crossed: null,
    synchronized_exact_package: null,
    usable_for_execution: false,
    missing_fields: ["NATIVE_BID", "NATIVE_ASK", "BID_SIZE", "ASK_SIZE", "NATIVE_QUOTE_IV", "NATIVE_QUOTE_GREEKS"],
    exclusion: "NOT_A_FROZEN_FAMILY_PACKAGE",
  };
}

function buildObservations(capability, smoke) {
  const rows = [];
  for (const result of capability.results) {
    for (const symbol of result.exact_symbol_sample ?? []) {
      rows.push({
        ...observation(symbol, result.local_date, result.local_date, "CAPABILITY_SAMPLE", result.checkpoint, "CAPABILITY_DEFAULT_5M"),
        provenance: {
          artifact: "docs/historical-quote-capability-2026-09-26.json",
          request_id: result.request_id,
          provider_id: result.provider_id,
          resolution_profile: result.resolution_profile,
        },
        missing_observation: null,
        exclusion: "SUMMARY_ONLY_NO_PER_SYMBOL_EVENT_TIMESTAMPS",
      });
    }
  }
  for (const day of smoke.daily_results) {
    for (const candidate of day.selected_candidates) {
      const age = (Date.parse(day.checkpoint) - Date.parse(candidate.available_at)) / 60000;
      if (age < 0 || Date.parse(candidate.bar_end) > Date.parse(day.checkpoint)) {
        throw new Error("Future candle evidence is forbidden.");
      }
      rows.push({
        ...observation(candidate.provider_symbol, day.local_date, day.local_date, "ENTRY", day.checkpoint, "SMOKE_DEFAULT_5M"),
        evidence_class: "REFERENCE_ONLY",
        candle_close: candidate.historical_price,
        candle_iv: candidate.historical_iv,
        reported_historical_delta: candidate.historical_delta,
        bar_start: candidate.bar_start,
        bar_end: candidate.bar_end,
        available_at: candidate.available_at,
        retrieved_at: candidate.retrieved_at,
        age_minutes: age,
        stale: age > smoke.request.resolution_profile.max_observation_age_minutes,
        missing_observation: false,
        provenance: {
          artifact: "docs/historical-replay-smoke-2026-09-26.json",
          source: smoke.request.source,
          resolution_profile: day.resolution_profile,
          selector: candidate.selector,
          source_evidence_ids: day.entry_source_evidence_ids,
          cache_content_verified: false,
        },
      });
    }
    for (const outcome of day.outcomes) {
      for (const item of outcome.observations) {
        // This pinned smoke contains no observed exit references; never synthesize one.
        if (item.observed_reference !== null) throw new Error("Unexpected exit reference in pinned smoke.");
        rows.push({
          ...observation(item.provider_symbol, day.local_date, outcome.local_date, outcome.horizon_id, outcome.scheduled_exit_at, "SMOKE_DEFAULT_5M"),
          missing_observation: true,
          failure_reasons: item.failure_reasons,
          provenance: {
            artifact: "docs/historical-replay-smoke-2026-09-26.json",
            source: smoke.request.source,
            resolution_profile: day.resolution_profile,
            source_evidence_ids: item.source_evidence_ids,
            cache_content_verified: false,
          },
        });
      }
    }
  }
  return rows;
}

function familyMatrix(months) {
  return months.flatMap((month) => FAMILIES.map(([family, exactLegCount]) => ({
    trading_month: month,
    family,
    required_exact_leg_count: exactLegCount,
    stage_rule: family === "SIC" ? "REQUIRE_FROZEN_ACTIVE_LEGS_AND_QUANTITIES_AT_EACH_STAGE_EVENT" : null,
    checkpoints: family === "SIC" ? [...CHECKPOINTS, "SIC_STAGE_OPEN", "SIC_STAGE_ADJUST", "SIC_STAGE_EXIT"] : CHECKPOINTS,
    status: "BLOCKED",
    expected_frozen_packages: null,
    expected_exact_leg_observations: null,
    quote_backed: null,
    reference_only: null,
    modeled: null,
    not_assessable: null,
    entry_count: null,
    early_exit_count: null,
    plus_3_exit_count: null,
    plus_5_exit_count: null,
    synchronized_checkpoint_count: null,
    excluded_count: null,
    exclusion: "FROZEN_INVENTORY_AND_CHECKPOINT_DENOMINATORS_UNKNOWN",
  })));
}

export async function buildHistoricalCoverageAudit(month = null) {
  if (month !== null && !MONTHS.includes(month)) throw new Error("Month must be 2026-03 through 2026-08.");
  const sources = await loadSources();
  const capability = JSON.parse(sources["docs/historical-quote-capability-2026-09-26.json"]);
  const smoke = JSON.parse(sources["docs/historical-replay-smoke-2026-09-26.json"]);
  const months = month === null ? MONTHS : [month];
  const allRows = buildObservations(capability, smoke);
  const observations = allRows.filter((row) => months.includes(row.trading_month));
  const inputIdentities = Object.entries(PINS).map(([path, digest]) => ({ path, byte_sha256: `sha256:${digest}` }));
  const generatorId = `sha256:${sha256(await readFile(fileURLToPath(import.meta.url)))}`;
  const body = {
    contract_version: "1.0.0",
    generator_version: VERSION,
    generator_byte_sha256: generatorId,
    audit_id: stableEvidenceContentId({ generator: generatorId, sources: inputIdentities, months: MONTHS }),
    status: "BLOCKED",
    source_decision: "DO_NOT_ENABLE",
    source_of_truth: "#42 docs/historical-provider-decision.md",
    six_month_coverage_pass: false,
    complete_issue_acceptance: false,
    provider_enablement_changed: false,
    production_grading_changed: false,
    trade_decisions_changed: false,
    scope: {
      start_date: "2026-03-01",
      end_date: "2026-08-31",
      months,
      month_attribution: "ENTRY_MONTH; explicit +3/+5 exits may be in September",
      bounds: { source_files: 7, max_bytes_per_source: 131072, max_observation_rows: 56, network_requests: 0 },
      clock_used: false,
      current_data_fallback: false,
    },
    inputs: inputIdentities,
    rights: {
      entitlement: "UNCONFIRMED",
      legal_storage_scope: null,
      replay_storage_permission: "UNCONFIRMED",
      final_cost: null,
      license_scope_labels_are_authorization: false,
      decision: "NO_ACQUISITION_OR_ENABLEMENT; separate owner authorization required",
    },
    blockers: BLOCKERS,
    measurement_rules: {
      null_means: "UNKNOWN_OR_NOT_SUPPLIED_NOT_ZERO",
      family_checkpoint_metrics: "All metrics on a family/month row apply separately to each listed checkpoint and remain unknown.",
      frozen_denominator: "Only a frozen INITIAL exact-family leg and event inventory can define six-month denominators; discoveries and returned symbol counts cannot.",
      summary_counts: "Source-reported aggregate counts stay in separate cohorts; they are not pooled with symbol rows.",
      source_time: "Unknown native event time remains null; candle bar_start/bar_end/available_at are distinct.",
      delta: "Reported historical_delta origin is unverified, not promoted to provider-native quote Greeks.",
      quote_rule: "Require native bid/ask/size, event time, availability, freshness, uncrossed markets and synchronized exact active legs at every checkpoint; midpoint is not execution.",
      synchronization: "No family assembled from discovery symbols. Front/back DTE require frozen leg roles; calendar_dte alone is not a family assignment.",
      cache: "Manifest/content IDs are references only; no cache lookup, provider query, or recovery from other worktrees.",
    },
    monthly_inventory: months.map((tradingMonth) => ({
      trading_month: tradingMonth,
      status: "BLOCKED",
      frozen_initial_inventory_id: null,
      trading_session_calendar_id: null,
      expected_symbols: null,
      expected_packages: null,
      coverage_fraction: null,
    })),
    family_matrix: familyMatrix(months),
    capability_cohorts: capability.results.filter((r) => months.includes(r.local_date.slice(0, 7))).map((r) => ({
      cohort: "CAPABILITY_DEFAULT_5M",
      checkpoint_at: r.checkpoint,
      provider_status: r.provider_status,
      frozen_expected_denominator: null,
      reported_reconstructed_symbol_count: r.exact_symbol_count,
      enumerated_symbol_count: r.exact_symbol_sample?.length ?? 0,
      unenumerated_returned_symbols: r.exact_symbol_count - (r.exact_symbol_sample?.length ?? 0),
      field_support: r.field_support,
      resolution_profile: r.resolution_profile,
      request_id: r.request_id,
      source_run_date: capability.run_date_utc,
      native_event_time: null,
      legal_storage_scope: null,
      warnings: r.warnings,
    })),
    smoke_cohorts: smoke.daily_results.filter((d) => months.includes(d.local_date.slice(0, 7))).map((d) => ({
      cohort: "SMOKE_DEFAULT_5M",
      entry_date: d.local_date,
      checkpoint_at: d.checkpoint,
      requested_selectors: d.requested_selector_count,
      discovered_contracts: d.reconstructed_candidate_count,
      enumerated_entry_reference_rows: d.selected_candidates.length,
      quote_backed_entry_rows: 0,
      plus_3: { requested_contracts: d.outcomes[0].observations.length, reference_only: 0, quote_backed: 0, not_assessable: d.outcomes[0].observations.length },
      plus_5: { requested_contracts: d.outcomes[1].observations.length, reference_only: 0, quote_backed: 0, not_assessable: d.outcomes[1].observations.length },
      frozen_family_denominator: null,
      early_exit_denominator: null,
    })),
    observations,
    enumerated_artifact_rows_only: {
      denominator: observations.length,
      quote_backed: 0,
      reference_only: observations.filter((r) => r.evidence_class === "REFERENCE_ONLY").length,
      modeled: 0,
      not_assessable: observations.filter((r) => r.evidence_class === "NOT_ASSESSABLE").length,
      disclaimer: "Inventory of checked-in rows, not measured six-month market coverage or verified cache contents.",
    },
    separate_prior_art: [
      {
        cohort: "ISSUE_40_NATIVE_1H_SAMPLE",
        source: "docs/historical-provider-decision.md",
        eligible_reference_observations: 5,
        requested_contract_observations: 714,
        scope: "Seven sampled checkpoints; 102 each; eligible five only August 25",
        exact_symbol_inventory: null,
        six_month_pass: false,
      },
      {
        cohort: "PR_105_BID_ASK_1M_DOCUMENTED_PROBE",
        source: "docs/historical-candles.md",
        recent: "2026-10-13T18:03:00Z/2026-10-13T18:12:00Z; outside March-August scope",
        recent_counts: [
          { symbol: "SPXW  261013C07800000", bid_bars: 9, ask_bars: 9 },
          { symbol: "SPXW  261013C07840000", bid_bars: 6, ask_bars: 7 },
        ],
        older: { date: "2026-07-02", symbol: "SPXW  260702C07475000", bid_bars: 0, ask_bars: 0, result: "SNAPSHOT_SNIP" },
        separate_last_resolutions: { "1h": 7, "1d": 1 },
        evidence_class: "VALUATION_ONLY",
        synchronized_quotes: false,
        native_sizes: null,
        frozen_expected_denominator: null,
        included_in_matrix_numerators: false,
      },
    ],
    acceptance: {
      AC1: "BLOCKED: six-month frozen per-symbol/per-family entry/exit inventory and exclusions unavailable",
      AC2: "BLOCKED: enumerated artifact classes/timestamps separated; native events, complete market coverage and legal storage scope unknown",
      AC3: "PASS_BLOCKED_EVIDENCE: pinned March NOT_AVAILABLE and recent partial historical evidence, not a coverage pass",
      AC4: "PASS: no quote-backed performance or synthetic execution claims",
      AC5: "PASS: offline only; no paid enablement, production grading or trade decision changes",
    },
  };
  if (allRows.length !== 56) throw new Error("Unexpected pinned observation inventory.");
  return { ...body, report_id: stableEvidenceContentId(body) };
}

async function main(argv) {
  let month = null;
  let output = null;
  let check = false;
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (seen.has(arg)) throw new Error(`Duplicate argument: ${arg}`);
    seen.add(arg);
    if (arg === "--check") check = true;
    else if (arg === "--month" || arg === "--output") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value.`);
      if (arg === "--month") month = value;
      else output = resolve(ROOT, value);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (check && !output) throw new Error("--check requires --output.");
  const serialized = `${JSON.stringify(await buildHistoricalCoverageAudit(month), null, 2)}\n`;
  if (check) {
    if (await readFile(output, "utf8") !== serialized) throw new Error("Audit report differs from pinned offline sources.");
  } else if (output) {
    await writeFile(output, serialized, { flag: "wx", mode: 0o600 });
  } else process.stdout.write(serialized);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
