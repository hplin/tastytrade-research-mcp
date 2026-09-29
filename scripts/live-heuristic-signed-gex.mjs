import {
  BASELINE_SIGNING_MODEL_ID,
  BASELINE_SIGNING_MODEL_VERSION,
  computeLiveHeuristicSignedGex,
} from "../dist/heuristic-signed-gex.js";
import { TastytradeLiveOptionSnapshotClient } from "../dist/live-option-snapshot.js";

const requiredEnvironment = [
  "TASTYTRADE_CLIENT_ID",
  "TASTYTRADE_CLIENT_SECRET",
  "TASTYTRADE_REFRESH_TOKEN",
  "TASTYTRADE_LIVE_OPTION_EXPIRATIONS",
  "TASTYTRADE_LIVE_OPTION_AROUND_PRICE",
  "TASTYTRADE_HEURISTIC_GEX_SPOT_MINIMUM",
  "TASTYTRADE_HEURISTIC_GEX_SPOT_MAXIMUM",
  "TASTYTRADE_HEURISTIC_GEX_SPOT_STEP",
  "TASTYTRADE_HEURISTIC_GEX_ROOT_TOLERANCE",
  "TASTYTRADE_HEURISTIC_GEX_RISK_FREE_RATE",
  "TASTYTRADE_HEURISTIC_GEX_DIVIDEND_YIELD",
  "TASTYTRADE_HEURISTIC_GEX_MINIMUM_YEARS",
];
const missingEnvironment = requiredEnvironment.filter(
  (name) => !process.env[name]?.trim(),
);

if (missingEnvironment.length > 0) {
  console.error(
    JSON.stringify(
      {
        status: "NOT_RUN",
        reason: "MISSING_LIVE_HEURISTIC_SIGNED_GEX_CONFIGURATION",
        missing_environment: missingEnvironment,
      },
      null,
      2,
    ),
  );
  process.exitCode = 2;
} else {
  const expirations = process.env.TASTYTRADE_LIVE_OPTION_EXPIRATIONS.split(
    ",",
  )
    .map((value) => value.trim())
    .filter(Boolean);
  const client = new TastytradeLiveOptionSnapshotClient();
  const result = await computeLiveHeuristicSignedGex(client, {
    snapshot_request: {
      underlying:
        process.env.TASTYTRADE_LIVE_OPTION_UNDERLYING?.trim().toUpperCase() ??
        "SPX",
      expirations,
      around_price: process.env.TASTYTRADE_LIVE_OPTION_AROUND_PRICE,
      strike_count: Number(
        process.env.TASTYTRADE_LIVE_OPTION_STRIKE_COUNT ?? "5",
      ),
      include_quotes: true,
      include_greeks: true,
      include_summary: true,
      phase: "LIVE_SUPPORT",
      deadline_ms: Number(
        process.env.TASTYTRADE_LIVE_OPTION_DEADLINE_MS ?? "5000",
      ),
      max_temporal_skew_ms: Number(
        process.env.TASTYTRADE_LIVE_OPTION_MAX_TEMPORAL_SKEW_MS ?? "5000",
      ),
    },
    phase: "REGRESSION_RESEARCH",
    signing_model: {
      model_id: BASELINE_SIGNING_MODEL_ID,
      model_version: BASELINE_SIGNING_MODEL_VERSION,
    },
    spot_repricing: {
      pricing_model: "BLACK_SCHOLES_GAMMA",
      model_version: "1.0.0",
      annualized_risk_free_rate:
        process.env.TASTYTRADE_HEURISTIC_GEX_RISK_FREE_RATE,
      annualized_dividend_yield:
        process.env.TASTYTRADE_HEURISTIC_GEX_DIVIDEND_YIELD,
      minimum_years_to_expiration:
        process.env.TASTYTRADE_HEURISTIC_GEX_MINIMUM_YEARS,
      spot_range: {
        minimum:
          process.env.TASTYTRADE_HEURISTIC_GEX_SPOT_MINIMUM,
        maximum:
          process.env.TASTYTRADE_HEURISTIC_GEX_SPOT_MAXIMUM,
        step: process.env.TASTYTRADE_HEURISTIC_GEX_SPOT_STEP,
        root_tolerance:
          process.env.TASTYTRADE_HEURISTIC_GEX_ROOT_TOLERANCE,
      },
    },
  });
  const flipStatus = result.heuristic_gamma_flip.status;
  const outcome =
    result.status === "AVAILABLE" &&
    result.source_snapshot.snapshot_complete &&
    result.source_snapshot.transport.failed_batches === 0 &&
    result.source_snapshot.transport.partial_batches === 0 &&
    result.source_snapshot.transport.timed_out_batches === 0 &&
    result.source_snapshot.contracts.length > 0 &&
    result.snapshot.level_2_unsigned_status === "COMPLETE" &&
    result.heuristic_signed_gex.status === "AVAILABLE" &&
    result.spot_repriced_signed_gex.status === "AVAILABLE" &&
    (flipStatus === "AVAILABLE" ||
      flipStatus === "NOT_FOUND_IN_RANGE") &&
    result.gamma_evidence_scope === "HEURISTIC_SIGNED_MODEL" &&
    result.evidence_role === "RESEARCH_ONLY" &&
    result.production_gate_eligible === false
      ? "PASS"
      : "FAIL";
  console.log(
    JSON.stringify(
      {
        gate: "LIVE_SPX_HEURISTIC_SIGNED_GEX",
        outcome,
        verified: {
          result_id: result.result_id,
          snapshot_id: result.snapshot.snapshot_id,
          selected_contracts:
            result.source_snapshot.contracts.length,
          transport: result.source_snapshot.transport,
          cohort_alignment:
            result.source_snapshot.cohort_alignment,
          oi_freshness: result.source_snapshot.oi_freshness,
          greeks_freshness:
            result.source_snapshot.greeks_freshness,
          level_2_unsigned_status:
            result.snapshot.level_2_unsigned_status,
          signing_model: result.signing_model,
          current_gamma_status:
            result.heuristic_signed_gex.status,
          current_gamma_total_signed_gex:
            result.heuristic_signed_gex.aggregation
              ?.total_signed_gex ?? null,
          spot_repriced_status:
            result.spot_repriced_signed_gex.status,
          scenario_count:
            result.spot_repriced_signed_gex.scenarios.length,
          heuristic_gamma_flip: result.heuristic_gamma_flip,
          semantic_boundaries: result.semantic_boundaries,
          evidence_role: result.evidence_role,
          production_gate_eligible:
            result.production_gate_eligible,
        },
        result,
      },
      null,
      2,
    ),
  );
  if (outcome !== "PASS") process.exitCode = 1;
}
