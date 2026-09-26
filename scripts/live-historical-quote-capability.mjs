import { TastytradeHistoricalCandlesClient } from "../dist/historical-candles.js";
import { getHistoricalSpxCandidateUniverse } from "../dist/historical-spx-reconstruction.js";

const probes = [
  {
    label: "older",
    local_date: "2026-03-02",
    expirations: ["2026-03-23", "2026-03-30", "2026-04-06"],
    strike_min: 6500,
    strike_max: 7500,
  },
  {
    label: "recent",
    local_date: "2026-08-25",
    expirations: ["2026-09-15", "2026-09-22", "2026-09-29"],
    strike_min: 7000,
    strike_max: 8000,
  },
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
        contract_version: "1.0.0",
        probe: "HISTORICAL_QUOTE_CAPABILITY",
        status: "NOT_RUN",
        reason: "MISSING_TASTYTRADE_CREDENTIALS",
        missing_environment: missingEnvironment,
      },
      null,
      2,
    ),
  );
  process.exitCode = 2;
} else {
  const candles = new TastytradeHistoricalCandlesClient();
  const results = [];
  for (const probe of probes) {
    try {
      const result = await getHistoricalSpxCandidateUniverse(candles, {
        underlying: "SPX",
        local_checkpoint: {
          local_date: probe.local_date,
          local_time: "07:30",
          timezone: "America/Los_Angeles",
        },
        min_dte: 21,
        max_dte: 35,
        expirations: probe.expirations,
        strike_min: probe.strike_min,
        strike_max: probe.strike_max,
        strike_step: 250,
        option_sides: ["CALL", "PUT"],
        max_contracts: 100,
        resolution_profile: {
          profile_id: "DEFAULT_5M",
          profile_version: "1.0.0",
          max_observation_age_minutes: 60,
          max_temporal_skew_minutes: 10,
        },
        candidate_construction_profile: {
          version: "issue-47-quote-capability/1.0.0",
          purpose: "field support probe only; no grading or leg selection",
        },
        phase: "REGRESSION_RESEARCH",
        references: {
          checkpoint_id: `issue-47-${probe.local_date}-0730-pt`,
        },
      });
      results.push({
        label: probe.label,
        local_date: probe.local_date,
        checkpoint: result.checkpoint,
        provider_status: result.status,
        request_id: result.request_id,
        provider_id: result.resolution_profile.provider_id,
        resolution_profile: {
          profile_id: result.resolution_profile.profile_id,
          profile_version: result.resolution_profile.profile_version,
          requested_aggregation:
            result.resolution_profile.requested_aggregation,
          effective_aggregation:
            result.resolution_profile.effective_aggregation,
        },
        exact_symbol_count: result.contracts.length,
        exact_symbol_sample: result.contracts
          .map((contract) => contract.provider_symbol)
          .slice(0, 8),
        field_support: {
          candle_close: {
            supported: result.field_coverage.historical_price.available > 0,
            available: result.field_coverage.historical_price.available,
            missing: result.field_coverage.historical_price.missing,
            evidence_class: "VALUATION_ONLY",
          },
          candle_iv: {
            supported: result.field_coverage.historical_iv.available > 0,
            available: result.field_coverage.historical_iv.available,
            missing: result.field_coverage.historical_iv.missing,
            evidence_class: "VALUATION_ONLY",
          },
          historical_bid: {
            supported: result.capabilities.historical_bid_ask,
            available: 0,
            missing: result.contracts.length,
            reason: "TASTYTRADE_DXLINK_CANDLE_SOURCE_HAS_NO_HISTORICAL_BID",
          },
          historical_ask: {
            supported: result.capabilities.historical_bid_ask,
            available: 0,
            missing: result.contracts.length,
            reason: "TASTYTRADE_DXLINK_CANDLE_SOURCE_HAS_NO_HISTORICAL_ASK",
          },
          bid_size: {
            supported: false,
            available: 0,
            missing: result.contracts.length,
            reason:
              "TASTYTRADE_DXLINK_CANDLE_SOURCE_HAS_NO_HISTORICAL_BID_SIZE",
          },
          ask_size: {
            supported: false,
            available: 0,
            missing: result.contracts.length,
            reason:
              "TASTYTRADE_DXLINK_CANDLE_SOURCE_HAS_NO_HISTORICAL_ASK_SIZE",
          },
          native_package_quote: {
            supported: false,
            available: 0,
            missing: 1,
            reason:
              "TASTYTRADE_DXLINK_CANDLE_SOURCE_HAS_NO_NATIVE_PACKAGE_QUOTE",
          },
          broker_execution: {
            supported: false,
            available: 0,
            missing: 1,
            reason: "NO_BROKER_FILL_SOURCE_QUERIED",
          },
        },
        warnings: result.warnings,
      });
    } catch (error) {
      results.push({
        label: probe.label,
        local_date: probe.local_date,
        provider_status: "ERROR",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  console.log(
    JSON.stringify(
      {
        contract_version: "1.0.0",
        probe: "HISTORICAL_QUOTE_CAPABILITY",
        status: results.some(
          (result) =>
            result.field_support?.historical_bid.supported === true,
        )
          ? "QUOTE_FIELDS_PRESENT"
          : "QUOTE_FIELDS_UNSUPPORTED",
        provider_enablement_changed: false,
        six_month_coverage_pass: false,
        results,
      },
      null,
      2,
    ),
  );
}
