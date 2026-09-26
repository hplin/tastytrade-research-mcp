import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { TastytradeHistoricalCandlesClient } from "../dist/historical-candles.js";
import {
  CachedHistoricalCandlesService,
  evidenceCacheFromEnv,
  stableEvidenceContentId,
} from "../dist/evidence-cache.js";
import {
  prepareHistoricalSpxCandidates,
} from "../dist/historical-spx-candidates.js";
import {
  reconstructHistoricalSpxCandidates,
} from "../dist/historical-spx-reconstruction.js";
import { resolveCheckpoint } from "../dist/time.js";

const WINDOW = [
  {
    local_date: "2026-08-24",
    plus_3_date: "2026-08-27",
    plus_5_date: "2026-08-31",
  },
  {
    local_date: "2026-08-25",
    plus_3_date: "2026-08-28",
    plus_5_date: "2026-09-01",
  },
  {
    local_date: "2026-08-26",
    plus_3_date: "2026-08-31",
    plus_5_date: "2026-09-02",
  },
  {
    local_date: "2026-08-27",
    plus_3_date: "2026-09-01",
    plus_5_date: "2026-09-03",
  },
  {
    local_date: "2026-08-28",
    plus_3_date: "2026-09-02",
    plus_5_date: "2026-09-04",
  },
];
const LOCAL_TIME = "07:30";
const TIMEZONE = "America/Los_Angeles";
const PROFILE = {
  profile_id: "DEFAULT_5M",
  profile_version: "1.0.0",
  max_observation_age_minutes: 60,
  max_temporal_skew_minutes: 10,
};
const CANDIDATE_PROFILE = {
  version: "issue-49-live-smoke/1.0.0",
  baseline_policy_version: "SPX-SPREAD-V1",
  research_policy_version: "DD_MILD_BACK_RICH_V1",
  purpose:
    "timestamp-safe candidate discovery only; downstream grading is not implemented in this MCP",
};
const SELECTORS = [
  { method: "DELTA", value: "20", days_until_expiration: 28 },
  {
    method: "PERCENTAGE_OTM",
    value: "0.01",
    days_until_expiration: 28,
  },
];
const SOURCE = {
  provider_id: "tastytrade-dxlink",
  dataset_id: "dxlink-candles",
  license_scope_id: "authorized-private-research",
  source_revision: "dxlink-candle-api/2026-09-26",
};

function parseArguments(argv) {
  let output = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--output") {
      output = argv[index + 1];
      if (!output || output.startsWith("--")) {
        throw new Error("--output requires a path.");
      }
      index += 1;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      return { help: true, output: null };
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return { help: false, output };
}

function usage() {
  return [
    "Usage:",
    "  npm run live:historical-replay-week -- [--output <manifest.json>]",
    "",
    "Requires tastytrade credentials and TASTYTRADE_EVIDENCE_CACHE_DIR.",
    "The fixed window is 2026-08-24 through 2026-08-28 at 07:30 America/Los_Angeles.",
  ].join("\n");
}

function checkpoint(localDate) {
  return resolveCheckpoint(undefined, {
    local_date: localDate,
    local_time: LOCAL_TIME,
    timezone: TIMEZONE,
  }).instant;
}

function evidenceRequest(role, asOf, checkpointId) {
  return {
    mode: "READ_WRITE",
    dataset_id: SOURCE.dataset_id,
    license_scope_id: SOURCE.license_scope_id,
    normalization_version: "historical-replay-smoke/1.0.0",
    model_version: "historical-spx-reconstruction/1.0.0",
    source_revision: SOURCE.source_revision,
    as_of: asOf,
    evidence_role: role,
    references: { checkpoint_id: checkpointId },
  };
}

function evidenceIds(summary) {
  return summary
    ? {
        manifest_ids: [...summary.manifest_ids].sort(),
        normalized_content_ids: [
          ...summary.normalized_content_ids,
        ].sort(),
        provider_payload_content_ids: [
          ...summary.provider_payload_content_ids,
        ].sort(),
      }
    : {
        manifest_ids: [],
        normalized_content_ids: [],
        provider_payload_content_ids: [],
      };
}

function resultEvidenceIds(results) {
  return {
    manifest_ids: [
      ...new Set(
        results
          .map((result) => result.evidence_cache?.manifest_id)
          .filter(Boolean),
      ),
    ].sort(),
    normalized_content_ids: [
      ...new Set(
        results
          .map(
            (result) =>
              result.evidence_cache?.normalized_content_id,
          )
          .filter(Boolean),
      ),
    ].sort(),
    provider_payload_content_ids: [
      ...new Set(
        results
          .map(
            (result) =>
              result.evidence_cache?.provider_payload_content_id,
          )
          .filter(Boolean),
      ),
    ].sort(),
  };
}

function latestCompletedCandle(result, scheduledExitAt) {
  const scheduledMs = Date.parse(scheduledExitAt);
  return (
    result.candles
      .filter(
        (candle) =>
          Date.parse(candle.bar_end) <= scheduledMs &&
          Date.parse(candle.available_at) <= scheduledMs,
      )
      .sort(
        (left, right) =>
          Date.parse(right.bar_end) - Date.parse(left.bar_end),
      )[0] ?? null
  );
}

async function outcomeSnapshot(
  candles,
  candidates,
  entryDate,
  horizonId,
  tradingDays,
  localDate,
) {
  const scheduledExitAt = checkpoint(localDate);
  if (candidates.length === 0) {
    return {
      horizon_id: horizonId,
      trading_days: tradingDays,
      local_date: localDate,
      scheduled_exit_at: scheduledExitAt,
      status: "NOT_AVAILABLE",
      source_evidence_ids: evidenceIds(null),
      observations: [],
      warnings: ["NO_ENTRY_CANDIDATES"],
    };
  }
  const start = new Date(
    Date.parse(scheduledExitAt) - 10 * 60_000,
  ).toISOString();
  const results = await candles.getHistoricalCandlesBatch({
    instruments: candidates.map((candidate) => ({
      symbol: candidate.provider_symbol,
      streamer_symbol: candidate.simulation_symbol,
      instrument_type: "OPTION",
      lifecycle: "EXPIRED",
    })),
    interval: "5m",
    start_time: start,
    end_time: scheduledExitAt,
    session: {
      kind: "ALL",
      timezone: "UTC",
    },
    resolution_profile: PROFILE,
    max_output_candles: 20000,
    max_received_events: 20000,
    max_buffer_bytes: 33554432,
    evidence_cache: evidenceRequest(
      tradingDays === 3
        ? "OUTCOME_3_TRADING_DAYS"
        : "OUTCOME_5_TRADING_DAYS",
      scheduledExitAt,
      `issue-49-${entryDate}-${horizonId}`,
    ),
  });
  const observations = results.map((result) => {
    const candle = latestCompletedCandle(result, scheduledExitAt);
    return {
      provider_symbol: result.symbol,
      streamer_symbol: result.streamer_symbol,
      provider_status: result.status,
      evidence_class: "VALUATION_ONLY",
      observed_reference: candle
        ? {
            close: candle.close,
            implied_volatility: candle.implied_volatility,
            bar_start: candle.bar_start,
            bar_end: candle.bar_end,
            available_at: candle.available_at,
            retrieved_at: candle.retrieved_at,
          }
        : null,
      source_evidence_ids: resultEvidenceIds([result]),
      failure_reasons: result.failure_reasons,
    };
  });
  return {
    horizon_id: horizonId,
    trading_days: tradingDays,
    local_date: localDate,
    scheduled_exit_at: scheduledExitAt,
    status: observations.every(
      (observation) => observation.observed_reference !== null,
    )
      ? "VALUATION_REFERENCES_AVAILABLE"
      : observations.some(
            (observation) => observation.observed_reference !== null,
          )
        ? "PARTIAL"
        : "NOT_AVAILABLE",
    source_evidence_ids: resultEvidenceIds(results),
    observations,
    warnings: [
      "CANDLE_CLOSE_IS_VALUATION_ONLY",
      "HISTORICAL_BID_ASK_AND_SIZE_UNSUPPORTED",
    ],
  };
}

async function run() {
  const cache = evidenceCacheFromEnv();
  if (!cache) {
    throw new Error(
      "TASTYTRADE_EVIDENCE_CACHE_DIR is required to preserve immutable source manifests.",
    );
  }
  const candles = new CachedHistoricalCandlesService(
    new TastytradeHistoricalCandlesClient(),
    cache,
  );
  const dailyResults = [];
  for (const day of WINDOW) {
    const asOf = checkpoint(day.local_date);
    try {
      const plan = prepareHistoricalSpxCandidates({
        underlying: "SPX",
        local_checkpoint: {
          local_date: day.local_date,
          local_time: LOCAL_TIME,
          timezone: TIMEZONE,
        },
        min_dte: 21,
        max_dte: 35,
        sides: ["CALL", "PUT"],
        selector_grid: SELECTORS,
        lookback_calendar_days: 0,
        resolution_profile: PROFILE,
        candidate_construction_profile: CANDIDATE_PROFILE,
        phase: "REGRESSION_RESEARCH",
        references: {
          checkpoint_id: `issue-49-${day.local_date}-0730-pt`,
        },
        evidence_cache: evidenceRequest(
          "ENTRY",
          asOf,
          `issue-49-${day.local_date}-0730-pt`,
        ),
      });
      const reconstruction = await reconstructHistoricalSpxCandidates(
        plan,
        candles,
      );
      const selected = reconstruction.candidates
        .map((candidate, index) => ({
          candidate,
          request: plan.items[index],
        }))
        .filter((item) => item.candidate !== null)
        .map(({ candidate, request }) => ({
          selector: {
            option_side: request.option_side,
            method: request.selector.method,
            value: request.selector.value,
            days_until_expiration:
              request.selector.days_until_expiration,
          },
          provider_symbol: candidate.provider_symbol,
          simulation_symbol: candidate.simulation_symbol,
          expiration: candidate.expiration,
          strike: candidate.strike,
          selected_at: candidate.selected_at,
          bar_start: candidate.bar_start,
          bar_end: candidate.bar_end,
          available_at: candidate.available_at,
          retrieved_at: candidate.retrieved_at,
          historical_price: candidate.historical_price,
          historical_delta: candidate.selected_historical_delta,
          historical_iv: candidate.selected_historical_iv,
          evidence_class: "VALUATION_ONLY",
          entry_fill_status: "NOT_ASSESSABLE",
          exit_fill_status: {
            PLUS_3_TRADING_DAYS: "NOT_ASSESSABLE",
            PLUS_5_TRADING_DAYS: "NOT_ASSESSABLE",
          },
        }));
      const exactCandidates = reconstruction.candidates.filter(Boolean);
      const outcomes = [];
      outcomes.push(
        await outcomeSnapshot(
          candles,
          exactCandidates,
          day.local_date,
          "PLUS_3_TRADING_DAYS",
          3,
          day.plus_3_date,
        ),
      );
      outcomes.push(
        await outcomeSnapshot(
          candles,
          exactCandidates,
          day.local_date,
          "PLUS_5_TRADING_DAYS",
          5,
          day.plus_5_date,
        ),
      );
      dailyResults.push({
        local_date: day.local_date,
        checkpoint: plan.as_of,
        checkpoint_source: "DIRECT_PATH_B_RECONSTRUCTION",
        later_selector_fallback_used: false,
        requested_selector_count: plan.items.length,
        reconstructed_candidate_count: selected.length,
        candidate_status:
          selected.length === plan.items.length
            ? "COMPLETE"
            : selected.length > 0
              ? "PARTIAL"
              : "NOT_AVAILABLE",
        candidate_construction_profile:
          plan.candidate_construction_profile,
        resolution_profile: plan.resolution_profile,
        entry_source_evidence_ids: evidenceIds(
          reconstruction.evidence_cache,
        ),
        selected_candidates: selected,
        outcomes,
        quote_execution_status: "NOT_ASSESSABLE",
        quote_execution_reason_codes: [
          "HISTORICAL_BID_UNSUPPORTED",
          "HISTORICAL_ASK_UNSUPPORTED",
          "HISTORICAL_BID_SIZE_UNSUPPORTED",
          "HISTORICAL_ASK_SIZE_UNSUPPORTED",
          "NO_QUOTE_BACKED_SIMULATED_EXECUTION",
        ],
        warnings: [...new Set(reconstruction.warnings)].sort(),
      });
    } catch (error) {
      dailyResults.push({
        local_date: day.local_date,
        checkpoint: asOf,
        checkpoint_source: "DIRECT_PATH_B_RECONSTRUCTION",
        later_selector_fallback_used: false,
        candidate_status: "ERROR",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const exactCandidateCount = dailyResults.reduce(
    (total, result) =>
      total + (result.reconstructed_candidate_count ?? 0),
    0,
  );
  const failedDayCount = dailyResults.filter(
    (result) =>
      result.candidate_status === "NOT_AVAILABLE" ||
      result.candidate_status === "ERROR",
  ).length;
  const request = {
    window: {
      start_date: WINDOW[0].local_date,
      end_date: WINDOW.at(-1).local_date,
      checkpoint_local_time: LOCAL_TIME,
      timezone: TIMEZONE,
    },
    horizons: [
      { horizon_id: "PLUS_3_TRADING_DAYS", trading_days: 3 },
      { horizon_id: "PLUS_5_TRADING_DAYS", trading_days: 5 },
    ],
    per_entry_scheduled_exit_dates: WINDOW,
    selectors: SELECTORS,
    resolution_profile: PROFILE,
    candidate_construction_profile: CANDIDATE_PROFILE,
    source: SOURCE,
    study_stage: "IN_SAMPLE",
    prior_outcome_accessed: true,
    later_selector_fallback_used: false,
  };
  const report = {
    contract_version: "1.0.0",
    probe: "HISTORICAL_REPLAY_WEEK_SMOKE",
    smoke_id: stableEvidenceContentId({
      request,
      daily_results: dailyResults,
    }),
    generated_at: new Date().toISOString(),
    status:
      exactCandidateCount > 0 && failedDayCount < WINDOW.length
        ? "NOT_ASSESSABLE"
        : "NOT_AVAILABLE",
    complete_performance_acceptance: false,
    provider_enablement_changed: false,
    external_provider_used: false,
    replay_report_built: false,
    replay_blockers: [
      "HISTORICAL_BID_ASK_AND_SIZE_UNSUPPORTED",
      "QUOTE_BACKED_ENTRY_AND_EXIT_EVIDENCE_UNAVAILABLE",
      "FROZEN_UPSTREAM_GRADING_OUTPUTS_NOT_SUPPLIED",
    ],
    request,
    summary: {
      requested_trading_days: WINDOW.length,
      days_with_any_reconstructed_candidate:
        dailyResults.filter(
          (result) =>
            (result.reconstructed_candidate_count ?? 0) > 0,
        ).length,
      failed_day_count: failedDayCount,
      exact_candidate_count: exactCandidateCount,
      quote_backed_simulation_count: 0,
      valuation_only_outcome_count: dailyResults.reduce(
        (total, result) =>
          total +
          (result.outcomes ?? []).reduce(
            (subtotal, outcome) =>
              subtotal +
              outcome.observations.filter(
                (observation) =>
                  observation.observed_reference !== null,
              ).length,
            0,
          ),
        0,
      ),
    },
    daily_results: dailyResults,
    warnings: [
      "ORIGINAL_2026_08_24_TO_2026_08_28_WINDOW_PRESERVED",
      "OLD_12_45_BACKTESTER_PATH_NOT_USED",
      "CANDLE_REFERENCES_ARE_VALUATION_ONLY",
      "PARTIAL_OR_VALUATION_ONLY_OUTPUT_IS_NOT_PERFORMANCE_ACCEPTANCE",
      "NO_WINNER_SELECTED",
      "NO_GRADING_CHANGED",
      "NO_FORWARD_PAPER_OR_MONTHLY_STATE_WRITTEN",
    ],
  };
  return report;
}

try {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
  } else {
    const missingEnvironment = [
      "TASTYTRADE_CLIENT_ID",
      "TASTYTRADE_CLIENT_SECRET",
      "TASTYTRADE_REFRESH_TOKEN",
      "TASTYTRADE_EVIDENCE_CACHE_DIR",
    ].filter((name) => !process.env[name]);
    if (missingEnvironment.length > 0) {
      throw new Error(
        `Missing required environment: ${missingEnvironment.join(", ")}`,
      );
    }
    const report = await run();
    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    if (options.output) {
      await writeFile(resolve(options.output), serialized, "utf8");
    } else {
      process.stdout.write(serialized);
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(usage());
  process.exitCode = 1;
}
