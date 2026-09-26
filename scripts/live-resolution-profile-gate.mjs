import { TastytradeHistoricalCandlesClient } from "../dist/historical-candles.js";
import { getHistoricalSpxCandidateUniverse } from "../dist/historical-spx-reconstruction.js";

const dates = [
  "2026-03-02",
  "2026-04-01",
  "2026-05-01",
  "2026-06-01",
  "2026-07-01",
  "2026-08-03",
  "2026-08-25",
];

const requiredEnvironment = [
  "TASTYTRADE_CLIENT_ID",
  "TASTYTRADE_CLIENT_SECRET",
  "TASTYTRADE_REFRESH_TOKEN",
];
const missingEnvironment = requiredEnvironment.filter(
  (name) => !process.env[name],
);
if (missingEnvironment.length > 0) {
  console.error(
    JSON.stringify(
      {
        status: "NOT_RUN",
        reason: "MISSING_TASTYTRADE_CREDENTIALS",
        missing_environment: missingEnvironment,
        dates,
      },
      null,
      2,
    ),
  );
  process.exitCode = 2;
} else {
  const candles = new TastytradeHistoricalCandlesClient();
  const manifest = [];
  for (const localDate of dates) {
    try {
      const result = await getHistoricalSpxCandidateUniverse(candles, {
        underlying: "SPX",
        local_checkpoint: {
          local_date: localDate,
          local_time: "07:30",
          timezone: "America/Los_Angeles",
        },
        min_dte: 21,
        max_dte: 35,
        strike_min: 5_000,
        strike_max: 9_000,
        strike_step: 250,
        option_sides: ["CALL", "PUT"],
        max_contracts: 500,
        resolution_profile: {
          profile_id: "HOURLY_VALUATION_RESEARCH",
          profile_version: "1.0.0",
          max_observation_age_minutes: 60,
          max_temporal_skew_minutes: 0,
        },
        candidate_construction_profile: {
          version: "issue-40-live-gate/1.0.0",
          purpose: "coverage-only; no grading or final leg selection",
        },
        phase: "REGRESSION_RESEARCH",
        references: {
          checkpoint_id: `issue-40-${localDate}-0730-pt`,
        },
      });
      const expirations = [...new Set(result.contracts.map((item) => item.expiration))];
      const optionBarStarts = result.contracts
        .map((item) => item.bar_start)
        .sort();
      manifest.push({
        local_date: localDate,
        checkpoint: result.checkpoint,
        status:
          result.status === "COMPLETE"
            ? "SUPPORTED"
            : result.contracts.length > 0
              ? "PARTIAL"
              : "BLOCKED",
        provider_status: result.status,
        request_id: result.request_id,
        resolution_profile: result.resolution_profile,
        candidate_construction_profile:
          result.candidate_construction_profile,
        underlying_price: result.underlying_price,
        expiration_dates: result.expiration_dates,
        front_expiration: expirations.at(0) ?? null,
        back_expiration: expirations.at(-1) ?? null,
        option_coverage: {
          requested: result.coverage.requested_contract_count,
          verified: result.coverage.verified_contract_count,
          missing: result.coverage.missing_contract_count,
          calls: result.contracts.filter(
            (item) => item.option_side === "CALL",
          ).length,
          puts: result.contracts.filter(
            (item) => item.option_side === "PUT",
          ).length,
          price: result.field_coverage.historical_price,
          iv: result.field_coverage.historical_iv,
          delta: result.field_coverage.historical_delta,
        },
        actual_option_bar_range:
          optionBarStarts.length === 0
            ? null
            : {
                start: optionBarStarts[0],
                end: optionBarStarts.at(-1),
              },
        exact_symbols: result.contracts.map(
          (item) => item.provider_symbol,
        ),
        provider_errors: result.coverage.provider_errors,
        warnings: result.warnings,
      });
    } catch (error) {
      manifest.push({
        local_date: localDate,
        status: "BLOCKED",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  console.log(
    JSON.stringify(
      {
        contract_version: "1.0.0",
        gate: "ISSUE_40_NATIVE_HOUR_RTH",
        outcome:
          manifest.every((item) => item.status === "SUPPORTED")
            ? "SUPPORTED"
            : manifest.some((item) => item.status === "SUPPORTED")
              ? "PARTIAL"
              : "BLOCKED",
        note:
          "Coverage output is evidence only. Missing or partial dates are never promoted to PASS.",
        manifest,
      },
      null,
      2,
    ),
  );
}
