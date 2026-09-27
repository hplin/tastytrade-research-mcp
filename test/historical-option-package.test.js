import { readFileSync } from "node:fs";
import { describe, expect, jest, test } from "@jest/globals";
import {
  getHistoricalOptionPackageAtCheckpoint,
  getHistoricalOptionPackagePath,
} from "../dist/historical-option-package.js";
import { getHistoricalOptionPackageHorizons } from "../dist/historical-option-package-horizons.js";
import { EvidenceCacheError } from "../dist/evidence-cache.js";
import { normalizeHistoricalExecutionEvidence } from "../dist/historical-execution-evidence.js";
import {
  historicalExecutionProfileHash,
  simulateHistoricalExecution,
} from "../dist/historical-execution-model.js";
import { verifyHistoricalFill } from "../dist/historical-fill.js";

const fixture = JSON.parse(
  readFileSync(
    new URL(
      "./fixtures/historical-option-package-2026-08-27.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

const REFERENCES = {
  checkpoint_id: "spx-2026-08-27-0730-pt",
  paper_order_id: "paper-35",
};

function candleResult(instrument, interval, candles) {
  return {
    contract_version: "1.0.0",
    symbol: instrument.symbol,
    streamer_symbol: instrument.streamer_symbol,
    instrument_type: "OPTION",
    interval,
    requested_range: {
      start: "2026-08-27T13:00:00.000Z",
      end: fixture.path_end,
    },
    actual_range:
      candles.length === 0
        ? null
        : {
            start: candles[0].source_time,
            end: candles.at(-1).source_time,
          },
    timezone: "UTC",
    session: "ALL",
    retrieved_at: "2026-08-27T16:00:00.000Z",
    source: "tastytrade-dxlink",
    source_timestamp_unit: "epoch_milliseconds",
    snapshot_complete: true,
    snapshot_truncated: false,
    resampled: false,
    candles,
    warnings: [],
  };
}

function fixtureService() {
  const bySymbol = new Map(
    fixture.legs.map((leg) => [leg.provider_symbol, leg]),
  );
  return {
    getHistoricalCandlesBatch: jest.fn(async (request) =>
      request.instruments.map((instrument) => {
        const leg = bySymbol.get(instrument.symbol);
        return candleResult(
          instrument,
          request.interval,
          leg
            ? structuredClone(
                leg.candles.filter(
                  (candle) =>
                    candle.source_time >= request.start_time &&
                    candle.source_time <= request.end_time,
                ),
              )
            : [],
        );
      }),
    ),
  };
}

function checkpointRequest(overrides = {}) {
  return {
    family: fixture.family,
    underlying: fixture.underlying,
    as_of: fixture.checkpoint,
    legs: fixture.legs.map(({ provider_symbol, action }) => ({
      provider_symbol,
      action,
    })),
    max_observation_age_minutes: 60,
    max_temporal_skew_minutes: 30,
    phase: "REGRESSION_RESEARCH",
    references: REFERENCES,
    ...overrides,
  };
}

function pathRequest(overrides = {}) {
  return {
    family: fixture.family,
    underlying: fixture.underlying,
    start_time: fixture.checkpoint,
    end_time: fixture.path_end,
    resolution: "1m",
    legs: fixture.legs.map(({ provider_symbol, action }) => ({
      provider_symbol,
      action,
    })),
    phase: "REGRESSION_RESEARCH",
    references: REFERENCES,
    ...overrides,
  };
}

describe("historical exact-leg option packages", () => {
  test("reconstructs the acceptance vertical from completed pre-checkpoint evidence", async () => {
    const service = fixtureService();
    const result = await getHistoricalOptionPackageAtCheckpoint(
      service,
      checkpointRequest(),
    );
    expect(service.getHistoricalCandlesBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        max_output_candles: 20_000,
        max_received_events: 20_000,
        max_buffer_bytes: 32 * 1024 * 1024,
      }),
    );

    expect(result).toMatchObject({
      request_id: expect.stringMatching(/^[a-f0-9]{64}$/),
      status: "AVAILABLE",
      evidence_type: "HISTORICAL_OPTION_PACKAGE_REFERENCE",
      family: "DEBIT_VERTICAL",
      underlying: "SPX",
      as_of: fixture.checkpoint,
      effective_resolution: "5m",
      resolution_profile: {
        profile_id: "DEFAULT_5M",
        requested_aggregation: "5m",
        native_aggregation: "5m",
        effective_aggregation: "5m",
      },
      candidate_construction_profile: null,
      reference_value: {
        value: "21.06",
        price_effect: "DEBIT",
        reference_type: "CANDLE_REFERENCE",
        evidence_class: "VALUATION_ONLY",
        guaranteed_executable: false,
      },
      synthetic_mid: null,
      synthetic_natural: null,
      freshness_status: "FRESH",
      temporal_alignment: "ALIGNED",
      temporal_skew_minutes: 30,
      execution_quality: "VALUATION_ONLY",
      usable_for_execution: false,
    });
    expect(result.legs).toEqual([
      expect.objectContaining({
        provider_symbol: "SPXW  260924C07750000",
        streamer_symbol: ".SPXW260924C7750",
        option_side: "CALL",
        strike: "7750",
        expiration: "2026-09-24",
        source_timestamp: "2026-08-27T13:35:00.000Z",
        bar_start: "2026-08-27T13:35:00.000Z",
        bar_end: "2026-08-27T13:40:00.000Z",
        available_at: "2026-08-27T13:40:00.000Z",
        retrieved_at: "2026-08-27T16:00:00.000Z",
        observation_age_minutes: 50,
        reconstruction_status: "AVAILABLE",
        failure_reason: null,
        reference_value: "81.31",
        bid: null,
        ask: null,
      }),
      expect.objectContaining({
        provider_symbol: "SPXW  260924C07800000",
        streamer_symbol: ".SPXW260924C7800",
        source_timestamp: "2026-08-27T14:05:00.000Z",
        available_at: "2026-08-27T14:10:00.000Z",
        observation_age_minutes: 20,
        reference_value: "60.25",
      }),
    ]);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        "HISTORICAL_BID_ASK_NOT_AVAILABLE",
        "VALUATION_ONLY_NOT_EXECUTABLE",
      ]),
    );
    expect(service.getHistoricalCandlesBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        interval: "5m",
        end_time: fixture.checkpoint,
        instruments: [
          expect.objectContaining({
            symbol: "SPXW  260924C07750000",
            streamer_symbol: ".SPXW260924C7750",
          }),
          expect.objectContaining({
            symbol: "SPXW  260924C07800000",
            streamer_symbol: ".SPXW260924C7800",
          }),
        ],
      }),
    );
  });

  test("fails closed under the issue's 30-minute age and 10-minute skew limits", async () => {
    const result = await getHistoricalOptionPackageAtCheckpoint(
      fixtureService(),
      checkpointRequest({
        max_observation_age_minutes: 30,
        max_temporal_skew_minutes: 10,
      }),
    );

    expect(result).toMatchObject({
      status: "NOT_AVAILABLE",
      reference_value: null,
      freshness_status: "STALE",
      temporal_alignment: "MISALIGNED",
      failure_reasons: [
        "STALE_OBSERVATION",
        "ALIGNMENT_MISMATCH",
      ],
      execution_quality: "NOT_AVAILABLE",
    });
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        "CHECKPOINT_PACKAGE_STALE",
        "TEMPORAL_ALIGNMENT_FAILED",
      ]),
    );
    expect(result.legs[0]).toMatchObject({
      freshness_status: "STALE",
      observation_age_minutes: 50,
      reconstruction_status: "NOT_AVAILABLE",
      failure_reason: "STALE_OBSERVATION",
    });
  });

  test("ignores a candle whose interval was not complete by the checkpoint", async () => {
    const service = fixtureService();
    const original = service.getHistoricalCandlesBatch;
    service.getHistoricalCandlesBatch = jest.fn(async (request) => {
      const results = await original(request);
      results[1].candles.push({
        ...results[1].candles.at(-1),
        source_time: fixture.checkpoint,
        close: "1",
      });
      return results;
    });

    const result = await getHistoricalOptionPackageAtCheckpoint(
      service,
      checkpointRequest(),
    );

    expect(result.legs[1].source_timestamp).toBe(
      "2026-08-27T14:05:00.000Z",
    );
    expect(result.warnings).toContain(
      "INCOMPLETE_OR_FUTURE_CANDLES_IGNORED:SPXW  260924C07800000:1",
    );
  });

  test("uses completed native-hour RTH legs and never the bar starting at the checkpoint", async () => {
    const bySymbol = new Map(
      fixture.legs.map((leg) => [leg.provider_symbol, leg]),
    );
    const service = {
      getHistoricalCandlesBatch: jest.fn(async (request) =>
        request.instruments.map((instrument) => {
          const leg = bySymbol.get(instrument.symbol);
          const selected =
            leg.candles.find(
              (candle) =>
                candle.source_time === "2026-08-27T14:05:00.000Z",
            ) ?? leg.candles.at(-1);
          return {
            ...candleResult(instrument, request.interval, [
              {
                ...structuredClone(selected),
                source_time: "2026-08-27T13:30:00.000Z",
              },
              {
                ...structuredClone(selected),
                source_time: fixture.checkpoint,
                close: "0.01",
              },
            ]),
            timezone: "America/New_York",
            session: "REGULAR",
          };
        }),
      ),
    };
    const candidateConstructionProfile = {
      version: "candidate-construction/7",
      final_selection: { implemented_elsewhere: true },
    };
    const result = await getHistoricalOptionPackageAtCheckpoint(
      service,
      checkpointRequest({
        resolution_profile: {
          profile_id: "HOURLY_VALUATION_RESEARCH",
          profile_version: "1.0.0",
          max_observation_age_minutes: 60,
          max_temporal_skew_minutes: 30,
        },
        candidate_construction_profile: candidateConstructionProfile,
      }),
    );

    expect(result).toMatchObject({
      status: "AVAILABLE",
      requested_resolution: "1h",
      effective_resolution: "1h",
      reference_value: { value: "21.06", price_effect: "DEBIT" },
      temporal_skew_minutes: 0,
      resolution_profile: {
        profile_id: "HOURLY_VALUATION_RESEARCH",
        requested_aggregation: "1h",
        native_aggregation: "h",
        effective_aggregation: "1h",
        alignment: "SESSION",
      },
    });
    expect(result.candidate_construction_profile).toBe(
      candidateConstructionProfile,
    );
    expect(result.legs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          bar_start: "2026-08-27T13:30:00.000Z",
          bar_end: fixture.checkpoint,
          available_at: fixture.checkpoint,
          retrieved_at: "2026-08-27T16:00:00.000Z",
        }),
      ]),
    );
    expect(
      result.legs.some((leg) => leg.reference_value === "0.01"),
    ).toBe(false);
    expect(service.getHistoricalCandlesBatch).toHaveBeenCalledTimes(1);
    expect(service.getHistoricalCandlesBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        interval: "1h",
        session: {
          kind: "REGULAR",
          timezone: "America/New_York",
        },
      }),
    );
  });

  test("accepts provider-clock hourly option bars only in the provider-aligned cohort", async () => {
    const bySymbol = new Map(
      fixture.legs.map((leg) => [leg.provider_symbol, leg]),
    );
    const service = {
      getHistoricalCandlesBatch: jest.fn(async (request) =>
        request.instruments.map((instrument) => {
          const leg = bySymbol.get(instrument.symbol);
          const selected =
            leg.candles.find(
              (candle) =>
                candle.source_time === "2026-08-27T14:05:00.000Z",
            ) ?? leg.candles.at(-1);
          return {
            ...candleResult(instrument, request.interval, [
              {
                ...structuredClone(selected),
                source_time: "2026-08-27T13:00:00.000Z",
              },
              {
                ...structuredClone(selected),
                source_time: "2026-08-27T13:30:00.000Z",
              },
            ]),
            timezone: "America/New_York",
            session: "REGULAR",
          };
        }),
      ),
    };
    const result = await getHistoricalOptionPackageAtCheckpoint(
      service,
      checkpointRequest({
        max_observation_age_minutes: 120,
        max_temporal_skew_minutes: 0,
        resolution_profile: {
          profile_id: "HOURLY_PROVIDER_ALIGNED_RESEARCH",
          profile_version: "1.0.0",
          max_observation_age_minutes: 120,
          max_temporal_skew_minutes: 0,
        },
      }),
    );

    expect(result).toMatchObject({
      status: "AVAILABLE",
      requested_resolution: "1h",
      effective_resolution: "1h",
      temporal_skew_minutes: 0,
      resolution_profile: {
        profile_id: "HOURLY_PROVIDER_ALIGNED_RESEARCH",
        alignment: "MIDNIGHT",
        effective_aggregation: "1h",
      },
    });
    expect(result.legs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          bar_start: "2026-08-27T13:00:00.000Z",
          bar_end: "2026-08-27T14:00:00.000Z",
          available_at: "2026-08-27T14:00:00.000Z",
        }),
      ]),
    );
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        "PROVIDER_BAR_ALIGNMENT_MISMATCH_IGNORED:SPXW  260924C07750000:1",
        "PROVIDER_BAR_ALIGNMENT_MISMATCH_IGNORED:SPXW  260924C07800000:1",
      ]),
    );
  });

  test("does not silently downgrade an hourly research cohort", async () => {
    const service = {
      getHistoricalCandlesBatch: jest.fn(async (request) =>
        request.instruments.map((instrument) => ({
          ...candleResult(instrument, request.interval, []),
          status: "NOT_AVAILABLE",
          snapshot_complete: false,
          provider_snapshot_complete: false,
          failure_reasons: [
            "REQUESTED_WINDOW_NOT_COVERED",
            "MISSING_CONTRACT_EVIDENCE",
          ],
        })),
      ),
    };
    const result = await getHistoricalOptionPackageAtCheckpoint(
      service,
      checkpointRequest({
        resolution_profile: {
          profile_id: "HOURLY_VALUATION_RESEARCH",
          profile_version: "1.0.0",
        },
      }),
    );

    expect(result).toMatchObject({
      status: "NOT_AVAILABLE",
      requested_resolution: "1h",
      effective_resolution: null,
      resolution_attempts: [
        {
          resolution: "1h",
          status: "UNAVAILABLE",
          reason: "DXLINK_SNAPSHOT_INCOMPLETE",
        },
      ],
      resolution_profile: {
        profile_id: "HOURLY_VALUATION_RESEARCH",
        effective_aggregation: null,
        effective_cohort_id: null,
        fallback_policy: { allowed: false, aggregations: [] },
      },
    });
    expect(result.failure_reasons).toEqual([
      "HISTORICAL_CANDLE_UNAVAILABLE",
    ]);
    expect(
      result.legs.every(
        (leg) =>
          leg.reconstruction_status === "NOT_AVAILABLE" &&
          leg.failure_reason === "HISTORICAL_CANDLE_UNAVAILABLE",
      ),
    ).toBe(true);
    expect(service.getHistoricalCandlesBatch).toHaveBeenCalledTimes(1);
  });

  test("does not mask provider failures as missing contracts", async () => {
    const service = {
      getHistoricalCandlesBatch: jest.fn(async (request) =>
        request.instruments.map((instrument) => ({
          ...candleResult(instrument, request.interval, []),
          status: "NOT_AVAILABLE",
          snapshot_complete: false,
          provider_snapshot_complete: false,
          failure_reasons: [
            "PROVIDER_TIMEOUT",
            "MISSING_CONTRACT_EVIDENCE",
          ],
        })),
      ),
    };
    const result = await getHistoricalOptionPackageAtCheckpoint(
      service,
      checkpointRequest({
        resolution_profile: {
          profile_id: "HOURLY_VALUATION_RESEARCH",
          profile_version: "1.0.0",
        },
      }),
    );

    expect(result.failure_reasons).toEqual(["PROVIDER_ERROR"]);
    expect(
      result.legs.every(
        (leg) =>
          leg.reconstruction_status === "NOT_AVAILABLE" &&
          leg.failure_reason === "PROVIDER_ERROR",
      ),
    ).toBe(true);
  });

  test("fails closed on provider hourly bars outside the declared session grid", async () => {
    const service = {
      getHistoricalCandlesBatch: jest.fn(async (request) =>
        request.instruments.map((instrument, index) =>
          candleResult(instrument, request.interval, [
            {
              source_time: "2026-08-27T13:00:00.000Z",
              open: index === 0 ? "81.31" : "60.25",
              high: index === 0 ? "81.31" : "60.25",
              low: index === 0 ? "81.31" : "60.25",
              close: index === 0 ? "81.31" : "60.25",
              volume: "1",
              vwap: index === 0 ? "81.31" : "60.25",
              bid_volume: null,
              ask_volume: "1",
              implied_volatility: "0.1",
              open_interest: "10",
            },
          ]),
        ),
      ),
    };

    const result = await getHistoricalOptionPackageAtCheckpoint(
      service,
      checkpointRequest({
        resolution_profile: {
          profile_id: "HOURLY_VALUATION_RESEARCH",
          profile_version: "1.0.0",
        },
      }),
    );

    expect(result.status).toBe("NOT_AVAILABLE");
    expect(result.reference_value).toBeNull();
    expect(result.failure_reasons).toEqual(["ALIGNMENT_MISMATCH"]);
    expect(
      result.legs.every(
        (leg) =>
          leg.reconstruction_status === "NOT_AVAILABLE" &&
          leg.failure_reason === "ALIGNMENT_MISMATCH",
      ),
    ).toBe(true);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        "PROVIDER_BAR_ALIGNMENT_MISMATCH_IGNORED:SPXW  260924C07750000:1",
        "PROVIDER_BAR_ALIGNMENT_MISMATCH_IGNORED:SPXW  260924C07800000:1",
      ]),
    );
  });

  test("returns missing evidence instead of a success-shaped package", async () => {
    const service = fixtureService();
    const original = service.getHistoricalCandlesBatch;
    service.getHistoricalCandlesBatch = jest.fn(async (request) => {
      const results = await original(request);
      results[0] = {
        ...candleResult(request.instruments[0], request.interval, []),
        status: "NOT_AVAILABLE",
        failure_reasons: ["MISSING_CONTRACT_EVIDENCE"],
      };
      return results;
    });

    const result = await getHistoricalOptionPackageAtCheckpoint(
      service,
      checkpointRequest(),
    );

    expect(result.status).toBe("NOT_AVAILABLE");
    expect(result.reference_value).toBeNull();
    expect(result.temporal_alignment).toBe("UNKNOWN");
    expect(result.missing_provider_symbols).toEqual([
      "SPXW  260924C07750000",
    ]);
    expect(result.legs[0]).toMatchObject({
      reconstruction_status: "NOT_AVAILABLE",
      failure_reason: "CONTRACT_ABSENT_FROM_RECONSTRUCTED_UNIVERSE",
    });
    expect(result.failure_reasons).toContain(
      "CONTRACT_ABSENT_FROM_RECONSTRUCTED_UNIVERSE",
    );
    expect(result.warnings).toContain(
      "MISSING_LEG_EVIDENCE:SPXW  260924C07750000",
    );
  });

  test("downgrades an unavailable 1m replay to aligned 5m points consumable by fill verification", async () => {
    const sources = [
      "2026-08-27T14:30:00.000Z",
      "2026-08-27T14:35:00.000Z",
      "2026-08-27T14:40:00.000Z",
      "2026-08-27T14:45:00.000Z",
    ];
    const prices = new Map([
      [
        fixture.legs[0].provider_symbol,
        ["10", "9.5", "9", "8.5"],
      ],
      [
        fixture.legs[1].provider_symbol,
        ["4", "4", "4", "4"],
      ],
    ]);
    const service = {
      getHistoricalCandlesBatch: jest.fn(async (request) => {
        if (request.interval === "1m") {
          return request.instruments.map((instrument) => ({
            ...candleResult(instrument, request.interval, []),
            status: "NOT_AVAILABLE",
            snapshot_complete: false,
            provider_snapshot_complete: false,
            failure_reasons: ["LOCAL_RECEIVE_BUDGET_EXCEEDED"],
          }));
        }
        return request.instruments.map((instrument) =>
          candleResult(
            instrument,
            request.interval,
            sources.map((source_time, index) => ({
              source_time,
              open: prices.get(instrument.symbol)[index],
              high: prices.get(instrument.symbol)[index],
              low: prices.get(instrument.symbol)[index],
              close: prices.get(instrument.symbol)[index],
              volume: "1",
              vwap: prices.get(instrument.symbol)[index],
              bid_volume: null,
              ask_volume: "1",
              implied_volatility: "0.1",
              open_interest: "10",
            })),
          ),
        );
      }),
    };

    const result = await getHistoricalOptionPackagePath(
      service,
      pathRequest(),
    );

    expect(result).toMatchObject({
      status: "AVAILABLE",
      requested_resolution: "1m",
      effective_resolution: "5m",
      expected_point_count: 4,
      observed_point_count: 4,
      gaps: [],
      fill_verification_compatible: true,
    });
    expect(result.resolution_attempts).toEqual([
      {
        resolution: "1m",
        status: "UNAVAILABLE",
        reason: "LOCAL_CANDLE_BUDGET_EXCEEDED",
      },
      { resolution: "5m", status: "SELECTED", reason: null },
    ]);
    expect(result.path.map((point) => point.as_of)).toEqual([
      "2026-08-27T14:35:00.000Z",
      "2026-08-27T14:40:00.000Z",
      "2026-08-27T14:45:00.000Z",
      "2026-08-27T14:50:00.000Z",
    ]);
    expect(
      result.path.every(
        (point) =>
          point.temporal_alignment === "ALIGNED" &&
          point.temporal_skew_minutes === 0 &&
          point.execution_quality === "VALUATION_ONLY" &&
          point.usable_for_execution === false,
      ),
    ).toBe(true);
    expect(result.fill_verification_path.map((point) => point.price)).toEqual([
      "6",
      "5.5",
      "5",
      "4.5",
    ]);

    const verification = verifyHistoricalFill({
      submitted_at: fixture.checkpoint,
      valid_until: fixture.path_end,
      working_limit: "5.5",
      price_effect: "DEBIT",
      verification_side: "ENTRY",
      fill_model: "LIMIT_TOUCH",
      path: result.fill_verification_path,
      evidence_source: result.source,
      references: REFERENCES,
      max_observation_gap_ms: 300_000,
    });
    expect(verification).toMatchObject({
      status: "TOUCHED",
      assessment_status: "TOUCHED",
      first_touch_at: "2026-08-27T14:40:00.000Z",
    });
  });

  test("reports exact path gaps without carrying stale checkpoint values forward", async () => {
    const service = fixtureService();
    const original = service.getHistoricalCandlesBatch;
    service.getHistoricalCandlesBatch = jest.fn(async (request) => {
      if (request.interval === "1m") {
        throw new Error(
          "DXLink replays from start_time through the present and does not honor toTime; this request may require 42000 snapshot events, exceeding max_candles=20000.",
        );
      }
      return original(request);
    });

    const result = await getHistoricalOptionPackagePath(
      service,
      pathRequest(),
    );

    expect(result).toMatchObject({
      status: "NOT_AVAILABLE",
      effective_resolution: "5m",
      expected_point_count: 4,
      observed_point_count: 0,
      path: [],
      fill_verification_path: [],
      fill_verification_compatible: true,
    });
    expect(result.gaps).toHaveLength(4);
    expect(result.gaps.at(-1)).toMatchObject({
      source_timestamp: "2026-08-27T14:45:00.000Z",
      available_at: "2026-08-27T14:50:00.000Z",
      missing_provider_symbols: ["SPXW  260924C07750000"],
    });
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        "RESOLUTION_DOWNGRADED:1m_TO_5m",
        "PATH_GAPS_PRESENT:4",
        "NO_INTERPOLATION_OR_FORWARD_FILL",
      ]),
    );
  });

  test("aligns an hourly package path to the New York RTH session", async () => {
    const service = {
      getHistoricalCandlesBatch: jest.fn(async (request) =>
        request.instruments.map((instrument, index) =>
          candleResult(instrument, request.interval, [
            {
              source_time: "2026-08-27T13:30:00.000Z",
              open: index === 0 ? "81.31" : "60.25",
              high: index === 0 ? "81.31" : "60.25",
              low: index === 0 ? "81.31" : "60.25",
              close: index === 0 ? "81.31" : "60.25",
              volume: "1",
              vwap: index === 0 ? "81.31" : "60.25",
              bid_volume: null,
              ask_volume: "1",
              implied_volatility: "0.1",
              open_interest: "10",
            },
          ]),
        ),
      ),
    };
    const result = await getHistoricalOptionPackagePath(
      service,
      pathRequest({
        start_time: "2026-08-27T13:30:00.000Z",
        end_time: fixture.checkpoint,
        resolution: "1h",
        resolution_profile: {
          profile_id: "HOURLY_VALUATION_RESEARCH",
          profile_version: "1.0.0",
        },
      }),
    );

    expect(result).toMatchObject({
      status: "AVAILABLE",
      requested_resolution: "1h",
      effective_resolution: "1h",
      expected_point_count: 1,
      observed_point_count: 1,
      resolution_profile: {
        profile_id: "HOURLY_VALUATION_RESEARCH",
        alignment: "SESSION",
        effective_aggregation: "1h",
      },
      path: [
        expect.objectContaining({
          as_of: fixture.checkpoint,
          source_timestamp: "2026-08-27T13:30:00.000Z",
          bar_start: "2026-08-27T13:30:00.000Z",
          bar_end: fixture.checkpoint,
          available_at: fixture.checkpoint,
        }),
      ],
    });
    expect(service.getHistoricalCandlesBatch).toHaveBeenCalledTimes(1);
  });

  test("surfaces provider failures that are not bounded-resolution limitations", async () => {
    const service = {
      getHistoricalCandlesBatch: jest.fn(async () => {
        throw new Error("provider authentication failed");
      }),
    };

    await expect(
      getHistoricalOptionPackagePath(service, pathRequest()),
    ).rejects.toThrow("provider authentication failed");
  });
});

const DD_LEGS = [
  {
    role: "FRONT_PUT",
    provider_symbol: "SPXW  260915P07400000",
    action: "SELL_TO_OPEN",
    lifecycle: "EXPIRED",
  },
  {
    role: "FRONT_CALL",
    provider_symbol: "SPXW  260915C07850000",
    action: "SELL_TO_OPEN",
    lifecycle: "EXPIRED",
  },
  {
    role: "BACK_PUT",
    provider_symbol: "SPXW  260929P07500000",
    action: "BUY_TO_OPEN",
    lifecycle: "ACTIVE",
  },
  {
    role: "BACK_CALL",
    provider_symbol: "SPXW  260929C07825000",
    action: "BUY_TO_OPEN",
    lifecycle: "ACTIVE",
  },
];

const HORIZON_CALENDAR = {
  timezone: "America/Los_Angeles",
  local_time: "07:30",
  session_dates: [
    "2026-08-25",
    "2026-08-26",
    "2026-08-28",
    "2026-08-31",
    "2026-09-01",
    "2026-09-02",
  ],
};

function horizonRequest(overrides = {}) {
  return {
    underlying: "SPX",
    trading_calendar: HORIZON_CALENDAR,
    horizons: [
      "ENTRY",
      "OUTCOME_3_TRADING_DAYS",
      "OUTCOME_5_TRADING_DAYS",
    ],
    candidates: [
      {
        candidate_id: "dd-2026-08-25",
        family: "DOUBLE_DIAGONAL",
        entry_date: "2026-08-25",
        legs: DD_LEGS,
        references: {
          checkpoint_id: "candidate-dd-2026-08-25",
        },
      },
    ],
    max_observation_age_minutes: 120,
    max_temporal_skew_minutes: 0,
    resolution_profile: {
      profile_id: "HOURLY_PROVIDER_ALIGNED_RESEARCH",
      profile_version: "1.0.0",
      max_observation_age_minutes: 120,
      max_temporal_skew_minutes: 0,
    },
    candidate_construction_profile: {
      version: "SPX-CANDIDATE-RESEARCH-V1",
    },
    phase: "REGRESSION_RESEARCH",
    evidence_cache: {
      mode: "READ_WRITE",
      dataset_id: "fixture-dataset",
      license_scope_id: "fixture-license",
      normalization_version: "fixture-normalization/1",
      model_version: "fixture-model/1",
      source_revision: "fixture-source/1",
    },
    ...overrides,
  };
}

function contentId(character) {
  return `sha256:${character.repeat(64)}`;
}

function modelSource(date, character) {
  return {
    observed_at: `${date}T13:00:00.000Z`,
    available_at: `${date}T14:00:00.000Z`,
    retrieved_at: `${date}T16:00:00.000Z`,
    source: "fixture-model-surface",
    dataset_id: "fixture-surface",
    license_scope_id: "fixture-license",
    source_revision: "fixture-surface/1",
    manifest_ids: [contentId(character)],
    normalized_content_ids: [contentId(character === "f" ? "e" : "f")],
  };
}

function modelCheckpoint(
  sessionDate,
  legs = DD_LEGS,
  overrides = {},
) {
  return {
    session_date: sessionDate,
    underlying: {
      value: "7800",
      ...modelSource(sessionDate, "d"),
    },
    leg_inputs: legs.map((leg, index) => ({
      provider_symbol: leg.provider_symbol,
      implied_volatility: String(0.2 + index * 0.01),
      iv_origin: "INTERPOLATED_SURFACE",
      surface_id: `fixture-surface-${sessionDate}`,
      source_symbols: [
        `${leg.provider_symbol.slice(0, 13)}${String(
          Number(leg.provider_symbol.slice(13)) - 25000,
        ).padStart(8, "0")}`,
        `${leg.provider_symbol.slice(0, 13)}${String(
          Number(leg.provider_symbol.slice(13)) + 25000,
        ).padStart(8, "0")}`,
      ],
      ...modelSource(sessionDate, String(index + 1)),
    })),
    ...overrides,
  };
}

function modelFallback(checkpoints, overrides = {}) {
  return {
    mode: "MODEL_IF_LEG_MISSING",
    pricing_model: "BLACK_SCHOLES_SPOT",
    model_version: "1.0.0",
    source_contract: {
      provider_id: "local-research-model",
      dataset_id: "fixture-option-model",
      license_scope_id: "fixture-license",
      resolution_profile: {
        profile_id: "HISTORICAL_OPTION_MODEL_VALUATION",
        profile_version: "1.0.0",
        native_resolution: "MODEL_INPUTS",
        effective_resolution: "MODEL_REFERENCE",
      },
      source_revision: "fixture-option-model/1",
    },
    annualized_risk_free_rate: "0.04",
    annualized_dividend_yield: "0.01",
    volatility_shift_fraction: "0.1",
    max_input_age_minutes: 120,
    checkpoints,
    ...overrides,
  };
}

function horizonService() {
  const priceBySymbol = new Map([
    [DD_LEGS[0].provider_symbol, "10"],
    [DD_LEGS[1].provider_symbol, "8"],
    [DD_LEGS[2].provider_symbol, "14"],
    [DD_LEGS[3].provider_symbol, "12"],
  ]);
  return {
    getHistoricalCandlesBatch: jest.fn(async (request) => {
      const date = request.end_time.slice(0, 10);
      return request.instruments.map((instrument, index) => ({
        ...candleResult(instrument, request.interval, [
          {
            source_time: `${date}T13:00:00.000Z`,
            open: priceBySymbol.get(instrument.symbol),
            high: priceBySymbol.get(instrument.symbol),
            low: priceBySymbol.get(instrument.symbol),
            close: priceBySymbol.get(instrument.symbol),
            volume: "1",
            vwap: priceBySymbol.get(instrument.symbol),
            bid_volume: null,
            ask_volume: "1",
            implied_volatility: "0.2",
            open_interest: "10",
          },
        ]),
        requested_range: {
          start: request.start_time,
          end: request.end_time,
        },
        retrieved_at: `${date}T16:00:00.000Z`,
        status: "AVAILABLE",
        failure_reasons: [],
        evidence_cache: {
          contract_version: "1.0.0",
          cache_status: "HIT",
          manifest_id: contentId(String(index + 1)),
          manifest_set_id: null,
          request_fingerprint: contentId("a"),
          revision: 1,
          evidence_role: request.evidence_cache.evidence_role,
          provider_payload_content_id: contentId("b"),
          normalized_content_id: contentId("c"),
          bytes_read: 100,
          bytes_written: 0,
          provider_calls_avoided: 1,
        },
      }));
    }),
  };
}

describe("historical exact-leg package horizons", () => {
  test("reconstructs frozen 21/35-DTE Double Diagonal legs on caller-supplied trading sessions", async () => {
    const service = horizonService();
    const result = await getHistoricalOptionPackageHorizons(
      service,
      horizonRequest(),
    );

    expect(result).toMatchObject({
      status: "COMPLETE",
      evidence_type: "HISTORICAL_OPTION_PACKAGE_HORIZONS",
      evidence_class: "VALUATION_ONLY",
      reference_type: "CANDLE_REFERENCE",
      coverage: {
        requested_candidates: 1,
        requested_package_checkpoints: 3,
        complete_entry_packages: 1,
        complete_outcome_3_trading_days_packages: 1,
        complete_outcome_5_trading_days_packages: 1,
        complete_packages: 3,
        missing_leg_count_by_role: [],
        missing_reason_counts: [],
      },
    });
    expect(result).not.toHaveProperty("valuation_status");
    expect(
      result.candidates[0].horizons.every(
        (horizon) => horizon.valuation === undefined,
      ),
    ).toBe(true);
    expect(
      result.candidates[0].horizons.map((horizon) => ({
        horizon_id: horizon.horizon_id,
        session_date: horizon.session_date,
        scheduled_checkpoint: horizon.scheduled_checkpoint,
        status: horizon.status,
        value: horizon.package.reference_value.value,
      })),
    ).toEqual([
      {
        horizon_id: "ENTRY",
        session_date: "2026-08-25",
        scheduled_checkpoint: "2026-08-25T14:30:00.000Z",
        status: "AVAILABLE",
        value: "8",
      },
      {
        horizon_id: "OUTCOME_3_TRADING_DAYS",
        session_date: "2026-08-31",
        scheduled_checkpoint: "2026-08-31T14:30:00.000Z",
        status: "AVAILABLE",
        value: "8",
      },
      {
        horizon_id: "OUTCOME_5_TRADING_DAYS",
        session_date: "2026-09-02",
        scheduled_checkpoint: "2026-09-02T14:30:00.000Z",
        status: "AVAILABLE",
        value: "8",
      },
    ]);
    expect(
      service.getHistoricalCandlesBatch.mock.calls.map(([request]) =>
        request.instruments.map((instrument) => ({
          symbol: instrument.symbol,
          lifecycle: instrument.lifecycle,
        })),
      ),
    ).toEqual([
      DD_LEGS.map(({ provider_symbol: symbol, lifecycle }) => ({
        symbol,
        lifecycle,
      })),
      DD_LEGS.map(({ provider_symbol: symbol, lifecycle }) => ({
        symbol,
        lifecycle,
      })),
      DD_LEGS.map(({ provider_symbol: symbol, lifecycle }) => ({
        symbol,
        lifecycle,
      })),
    ]);
    expect(
      result.candidates[0].horizons.every((horizon) =>
        horizon.legs.every(
          (leg) =>
            leg.reconstruction_status === "AVAILABLE" &&
            leg.failure_reason === null &&
            Date.parse(leg.observation.bar_end) <=
              Date.parse(leg.observation.available_at) &&
            Date.parse(leg.observation.available_at) <=
              Date.parse(horizon.scheduled_checkpoint) &&
            leg.observation.provenance.source_revision ===
              "fixture-source/1" &&
            leg.observation.provenance.evidence_cache.manifest_id.startsWith(
              "sha256:",
            ) &&
            leg.observation.provenance.resolution_profile.profile_id ===
              "HOURLY_PROVIDER_ALIGNED_RESEARCH",
        ),
      ),
    ).toBe(true);
    expect(result.coverage.by_strategy).toEqual([
      {
        strategy: "DOUBLE_DIAGONAL",
        requested_packages: 3,
        complete_packages: 3,
        unavailable_packages: 0,
      },
    ]);
    expect(result.coverage.by_expiration).toEqual([
      {
        expiration: "2026-09-15",
        requested_leg_observations: 6,
        available_leg_observations: 6,
        missing_leg_observations: 0,
      },
      {
        expiration: "2026-09-29",
        requested_leg_observations: 6,
        available_leg_observations: 6,
        missing_leg_observations: 0,
      },
    ]);
    expect(result.coverage.by_dte_at_entry).toEqual([
      {
        dte_at_entry: 21,
        requested_leg_observations: 6,
        available_leg_observations: 6,
        missing_leg_observations: 0,
      },
      {
        dte_at_entry: 35,
        requested_leg_observations: 6,
        available_leg_observations: 6,
        missing_leg_observations: 0,
      },
    ]);
    expect(result.coverage.by_resolution_profile).toEqual([
      {
        profile_id: "HOURLY_PROVIDER_ALIGNED_RESEARCH",
        profile_version: "1.0.0",
        requested_aggregation: "1h",
        effective_aggregation: "1h",
        requested_packages: 3,
        complete_packages: 3,
        unavailable_packages: 0,
      },
    ]);
  });

  test("reports cache and provider failures per exact leg without replacing the inventory", async () => {
    const providerCandidate = {
      candidate_id: "provider-error",
      family: "CREDIT_VERTICAL",
      entry_date: "2026-08-25",
      legs: [
        {
          role: "SHORT_PUT",
          provider_symbol: "SPXW  260922P07400000",
          action: "SELL_TO_OPEN",
        },
        {
          role: "LONG_PUT",
          provider_symbol: "SPXW  260922P07350000",
          action: "BUY_TO_OPEN",
        },
      ],
    };
    const cacheCandidate = {
      candidate_id: "cache-error",
      family: "DEBIT_VERTICAL",
      entry_date: "2026-08-25",
      legs: [
        {
          role: "LONG_CALL",
          provider_symbol: "SPXW  260924C07750000",
          action: "BUY_TO_OPEN",
        },
        {
          role: "SHORT_CALL",
          provider_symbol: "SPXW  260924C07800000",
          action: "SELL_TO_OPEN",
        },
      ],
    };
    const service = {
      getHistoricalCandlesBatch: jest.fn(async (request) => {
        if (
          request.instruments[0].symbol ===
          cacheCandidate.legs[0].provider_symbol
        ) {
          throw new EvidenceCacheError(
            "EVIDENCE_CACHE_OBJECT_MISSING",
            "fixture cache miss",
          );
        }
        throw new EvidenceCacheError(
          "EVIDENCE_CACHE_PROVIDER_ERROR",
          "fixture provider failure",
        );
      }),
    };

    const result = await getHistoricalOptionPackageHorizons(
      service,
      horizonRequest({
        horizons: ["ENTRY"],
        candidates: [cacheCandidate, providerCandidate],
        evidence_cache: undefined,
        valuation_fallback: modelFallback([
          modelCheckpoint("2026-08-25", [
            ...cacheCandidate.legs,
            ...providerCandidate.legs,
          ]),
        ]),
      }),
    );

    expect(result.status).toBe("NOT_AVAILABLE");
    expect(
      result.candidates.map((candidate) => ({
        candidate_id: candidate.candidate_id,
        status: candidate.horizons[0].status,
        failure_reasons: candidate.horizons[0].failure_reasons,
        exact_symbols: candidate.horizons[0].legs.map(
          (leg) => leg.provider_symbol,
        ),
      })),
    ).toEqual([
      {
        candidate_id: "cache-error",
        status: "ERROR",
        failure_reasons: ["CACHE_ERROR"],
        exact_symbols: cacheCandidate.legs.map(
          (leg) => leg.provider_symbol,
        ),
      },
      {
        candidate_id: "provider-error",
        status: "ERROR",
        failure_reasons: ["PROVIDER_ERROR"],
        exact_symbols: providerCandidate.legs.map(
          (leg) => leg.provider_symbol,
        ),
      },
    ]);
    expect(result.coverage).toMatchObject({
      requested_candidates: 2,
      requested_package_checkpoints: 2,
      complete_entry_packages: 0,
      complete_packages: 0,
      missing_leg_count_by_role: [
        { role: "LONG_CALL", count: 1 },
        { role: "LONG_PUT", count: 1 },
        { role: "SHORT_CALL", count: 1 },
        { role: "SHORT_PUT", count: 1 },
      ],
      missing_reason_counts: [
        { reason: "CACHE_ERROR", count: 2 },
        { reason: "PROVIDER_ERROR", count: 2 },
      ],
      valued_packages: 0,
    });
    expect(result.valuation_status).toBe("NOT_AVAILABLE");
    expect(
      result.candidates.every((candidate) => {
        const valuation = candidate.horizons[0].valuation;
        return (
          valuation.status === "NOT_AVAILABLE" &&
          valuation.modeled_leg_count === 0 &&
          valuation.failure_reasons.includes(
            "STRICT_RECONSTRUCTION_NOT_MODELABLE",
          )
        );
      }),
    ).toBe(true);
  });

  test("stratifies an exact package without replacing its candle reference", async () => {
    const result = await getHistoricalOptionPackageHorizons(
      horizonService(),
      horizonRequest({
        horizons: ["ENTRY"],
        valuation_fallback: modelFallback([
          modelCheckpoint("2026-08-25"),
        ]),
      }),
    );
    const horizon = result.candidates[0].horizons[0];

    expect(horizon).toMatchObject({
      status: "AVAILABLE",
      reference_type: "CANDLE_REFERENCE",
      package: {
        reference_value: {
          value: "8",
          reference_type: "CANDLE_REFERENCE",
        },
      },
      valuation: {
        status: "AVAILABLE",
        valuation_basis: "EXACT_PACKAGE_REFERENCE",
        quality: "HIGH",
        reference_type: "CANDLE_REFERENCE",
        observed_leg_count: 4,
        modeled_leg_count: 0,
        reference_value: {
          value: "8",
          reference_type: "CANDLE_REFERENCE",
        },
        regression_reference: {
          evidence_type: "CANDLE_REFERENCE",
          signed_value: "8",
          model_version: null,
        },
      },
    });
    const normalizedEvidence = normalizeHistoricalExecutionEvidence(
      horizon.valuation.execution_evidence_input,
    );
    expect(normalizedEvidence.coverage).toMatchObject({
      candle_coverage: "COMPLETE",
      model_coverage: "NONE",
    });
    expect(result.coverage).toMatchObject({
      complete_packages: 1,
      valued_packages: 1,
      valuation_basis_counts: [
        { valuation_basis: "EXACT_PACKAGE_REFERENCE", count: 1 },
      ],
    });
  });

  test("models only a missing exact leg and preserves observed values", async () => {
    const original = horizonService();
    const missingSymbol = DD_LEGS[3].provider_symbol;
    const service = {
      getHistoricalCandlesBatch: jest.fn(async (request) => {
        const results = await original.getHistoricalCandlesBatch(request);
        return results.map((result) =>
          result.symbol === missingSymbol
            ? {
                ...result,
                status: "NOT_AVAILABLE",
                actual_range: null,
                candles: [],
                failure_reasons: ["MISSING_CONTRACT_EVIDENCE"],
              }
            : result,
        );
      }),
    };

    const result = await getHistoricalOptionPackageHorizons(
      service,
      horizonRequest({
        horizons: ["ENTRY"],
        valuation_fallback: modelFallback([
          modelCheckpoint("2026-08-25"),
        ]),
      }),
    );
    const horizon = result.candidates[0].horizons[0];
    const modeled = horizon.valuation.legs.find(
      (leg) => leg.provider_symbol === missingSymbol,
    );
    const observed = horizon.valuation.legs.filter(
      (leg) => leg.provider_symbol !== missingSymbol,
    );

    expect(horizon.status).toBe("NOT_AVAILABLE");
    expect(horizon.valuation).toMatchObject({
      status: "AVAILABLE",
      valuation_basis: "MIXED_OBSERVED_MODELED",
      quality: "MEDIUM",
      observed_leg_count: 3,
      modeled_leg_count: 1,
      unavailable_leg_count: 0,
      reference_value: {
        evidence_type: "HISTORICAL_OPTION_PACKAGE_MODEL_VALUATION",
        reference_type: "MODEL_REFERENCE",
        evidence_class: "VALUATION_ONLY",
        guaranteed_executable: false,
      },
      regression_reference: {
        evidence_type: "MODEL_REFERENCE",
        price_semantics: "SIGNED_CASH_FLOW_PER_UNIT",
        model_version: "BLACK_SCHOLES_SPOT/1.0.0",
      },
    });
    expect(
      observed.map((leg) => ({
        role: leg.role,
        valuation_source: leg.valuation_source,
        value: leg.value,
      })),
    ).toEqual([
      { role: "FRONT_PUT", valuation_source: "OBSERVED", value: "10" },
      { role: "FRONT_CALL", valuation_source: "OBSERVED", value: "8" },
      { role: "BACK_PUT", valuation_source: "OBSERVED", value: "14" },
    ]);
    expect(modeled).toMatchObject({
      role: "BACK_CALL",
      provider_symbol: missingSymbol,
      valuation_source: "MODELED",
      valuation_basis: "MODEL_SURFACE",
      model_provenance: {
        pricing_model: "BLACK_SCHOLES_SPOT",
        model_version: "1.0.0",
        checkpoint: "2026-08-25T14:30:00.000Z",
        underlying_value: "7800",
        strike: "7825",
        expiration: "2026-09-29",
        option_side: "CALL",
        implied_volatility: "0.23",
        iv_origin: "INTERPOLATED_SURFACE",
        annualized_risk_free_rate: "0.04",
        annualized_dividend_yield: "0.01",
        multiplier: "100",
        settlement: "PM",
        underlying_input: {
          input_age_minutes: 90,
        },
        iv_input: {
          input_age_minutes: 90,
        },
        manifest_ids: expect.arrayContaining([
          contentId("4"),
          contentId("d"),
        ]),
      },
    });
    expect(Number(modeled.uncertainty.value_low)).toBeLessThan(
      Number(modeled.value),
    );
    expect(Number(modeled.uncertainty.value_high)).toBeGreaterThan(
      Number(modeled.value),
    );
    expect(Number(horizon.valuation.uncertainty.signed_value_low)).toBeLessThan(
      Number(horizon.valuation.regression_reference.signed_value),
    );
    expect(Number(horizon.valuation.uncertainty.signed_value_high)).toBeGreaterThan(
      Number(horizon.valuation.regression_reference.signed_value),
    );
    expect(result.valuation_status).toBe("COMPLETE");
    expect(result.coverage).toMatchObject({
      complete_entry_packages: 0,
      valued_entry_packages: 1,
      valued_packages: 1,
      valuation_basis_counts: [
        { valuation_basis: "MIXED_OBSERVED_MODELED", count: 1 },
      ],
      modeled_leg_count_by_role: [{ role: "BACK_CALL", count: 1 }],
    });
    const normalizedEvidence = normalizeHistoricalExecutionEvidence(
      horizon.valuation.execution_evidence_input,
    );
    expect(normalizedEvidence).toMatchObject({
      candidate_fingerprint:
        horizon.valuation.execution_evidence_input
          .candidate_fingerprint,
      coverage: {
        quote_coverage: "NONE",
        model_coverage: "COMPLETE",
      },
      observations: [
        {
          model_coverage: "COMPLETE",
          references: [
            {
              evidence_type: "MODEL_REFERENCE",
              signed_value:
                horizon.valuation.regression_reference.signed_value,
              status: "AVAILABLE",
            },
          ],
        },
      ],
    });
  });

  test("fully models an exact package when all candles are unavailable", async () => {
    const service = {
      getHistoricalCandlesBatch: jest.fn(async (request) =>
        request.instruments.map((instrument) => ({
          ...candleResult(instrument, request.interval, []),
          status: "NOT_AVAILABLE",
          failure_reasons: ["MISSING_CONTRACT_EVIDENCE"],
        })),
      ),
    };

    const result = await getHistoricalOptionPackageHorizons(
      service,
      horizonRequest({
        horizons: ["ENTRY"],
        valuation_fallback: modelFallback([
          modelCheckpoint("2026-08-25"),
        ]),
      }),
    );
    const valuation = result.candidates[0].horizons[0].valuation;

    expect(result.status).toBe("NOT_AVAILABLE");
    expect(result.valuation_status).toBe("COMPLETE");
    expect(valuation).toMatchObject({
      status: "AVAILABLE",
      valuation_basis: "MODEL_SURFACE",
      quality: "LOW",
      observed_leg_count: 0,
      modeled_leg_count: 4,
      unavailable_leg_count: 0,
      regression_reference: {
        evidence_type: "MODEL_REFERENCE",
        price_semantics: "SIGNED_CASH_FLOW_PER_UNIT",
        model_version: "BLACK_SCHOLES_SPOT/1.0.0",
      },
    });
    expect(
      valuation.legs.every(
        (leg) =>
          leg.valuation_source === "MODELED" &&
          leg.valuation_basis === "MODEL_SURFACE" &&
          leg.model_provenance !== null,
      ),
    ).toBe(true);
    expect(result.coverage).toMatchObject({
      complete_packages: 0,
      valued_packages: 1,
      valuation_basis_counts: [
        { valuation_basis: "MODEL_SURFACE", count: 1 },
      ],
      modeled_leg_count_by_role: [
        { role: "BACK_CALL", count: 1 },
        { role: "BACK_PUT", count: 1 },
        { role: "FRONT_CALL", count: 1 },
        { role: "FRONT_PUT", count: 1 },
      ],
    });
  });

  test("keeps valuation unavailable when a missing leg lacks frozen model inputs", async () => {
    const original = horizonService();
    const missingSymbol = DD_LEGS[3].provider_symbol;
    const service = {
      getHistoricalCandlesBatch: jest.fn(async (request) => {
        const results = await original.getHistoricalCandlesBatch(request);
        return results.map((result) =>
          result.symbol === missingSymbol
            ? {
                ...result,
                status: "NOT_AVAILABLE",
                actual_range: null,
                candles: [],
                failure_reasons: ["MISSING_CONTRACT_EVIDENCE"],
              }
            : result,
        );
      }),
    };
    const result = await getHistoricalOptionPackageHorizons(
      service,
      horizonRequest({
        horizons: ["ENTRY"],
        valuation_fallback: modelFallback([]),
      }),
    );
    const valuation = result.candidates[0].horizons[0].valuation;

    expect(valuation).toMatchObject({
      status: "NOT_AVAILABLE",
      observed_leg_count: 3,
      modeled_leg_count: 0,
      unavailable_leg_count: 1,
      failure_reasons: ["MODEL_CHECKPOINT_UNAVAILABLE"],
      regression_reference: null,
      execution_evidence_input: null,
    });
  });

  test("models ENTRY, +3, and +5 only at caller-supplied sessions", async () => {
    const service = {
      getHistoricalCandlesBatch: jest.fn(async (request) =>
        request.instruments.map((instrument) => ({
          ...candleResult(instrument, request.interval, []),
          status: "NOT_AVAILABLE",
          failure_reasons: ["MISSING_CONTRACT_EVIDENCE"],
        })),
      ),
    };
    const result = await getHistoricalOptionPackageHorizons(
      service,
      horizonRequest({
        valuation_fallback: modelFallback([
          modelCheckpoint("2026-08-25"),
          modelCheckpoint("2026-08-31"),
          modelCheckpoint("2026-09-02"),
        ]),
      }),
    );

    expect(
      result.candidates[0].horizons.map((horizon) => ({
        horizon_id: horizon.horizon_id,
        session_date: horizon.session_date,
        checkpoint:
          horizon.valuation.legs[0].model_provenance.checkpoint,
        basis: horizon.valuation.valuation_basis,
      })),
    ).toEqual([
      {
        horizon_id: "ENTRY",
        session_date: "2026-08-25",
        checkpoint: "2026-08-25T14:30:00.000Z",
        basis: "MODEL_SURFACE",
      },
      {
        horizon_id: "OUTCOME_3_TRADING_DAYS",
        session_date: "2026-08-31",
        checkpoint: "2026-08-31T14:30:00.000Z",
        basis: "MODEL_SURFACE",
      },
      {
        horizon_id: "OUTCOME_5_TRADING_DAYS",
        session_date: "2026-09-02",
        checkpoint: "2026-09-02T14:30:00.000Z",
        basis: "MODEL_SURFACE",
      },
    ]);
    expect(result.valuation_status).toBe("COMPLETE");
    expect(result.coverage).toMatchObject({
      complete_packages: 0,
      valued_entry_packages: 1,
      valued_outcome_3_trading_days_packages: 1,
      valued_outcome_5_trading_days_packages: 1,
      valued_packages: 3,
    });
  });

  test("keeps one frozen source contract across mixed and full model horizons", async () => {
    const original = horizonService();
    const missingSymbol = DD_LEGS[3].provider_symbol;
    const service = {
      getHistoricalCandlesBatch: jest.fn(async (request) => {
        if (request.end_time.startsWith("2026-08-25")) {
          const results = await original.getHistoricalCandlesBatch(request);
          return results.map((result) =>
            result.symbol === missingSymbol
              ? {
                  ...result,
                  status: "NOT_AVAILABLE",
                  actual_range: null,
                  candles: [],
                  failure_reasons: ["MISSING_CONTRACT_EVIDENCE"],
                }
              : result,
          );
        }
        return request.instruments.map((instrument) => ({
          ...candleResult(instrument, request.interval, []),
          status: "NOT_AVAILABLE",
          failure_reasons: ["MISSING_CONTRACT_EVIDENCE"],
        }));
      }),
    };
    const fallback = modelFallback([
      modelCheckpoint("2026-08-25"),
      modelCheckpoint("2026-08-31"),
    ]);
    const result = await getHistoricalOptionPackageHorizons(
      service,
      horizonRequest({
        horizons: ["ENTRY", "OUTCOME_3_TRADING_DAYS"],
        valuation_fallback: fallback,
      }),
    );
    const [entry, exit] = result.candidates[0].horizons;
    const entryEvidence = normalizeHistoricalExecutionEvidence(
      entry.valuation.execution_evidence_input,
    );
    const exitEvidence = normalizeHistoricalExecutionEvidence(
      exit.valuation.execution_evidence_input,
    );
    const sourceIdentity = (reference) => ({
      provider_id: reference.source.provider_id,
      dataset_id: reference.source.dataset_id,
      license_scope_id: reference.source.license_scope_id,
      resolution_profile: reference.source.resolution_profile,
      source_revision: reference.source.source_revision,
    });

    expect(entry.valuation.valuation_basis).toBe(
      "MIXED_OBSERVED_MODELED",
    );
    expect(exit.valuation.valuation_basis).toBe("MODEL_SURFACE");
    expect(
      sourceIdentity(entryEvidence.observations[0].references[0]),
    ).toEqual(fallback.source_contract);
    expect(
      sourceIdentity(exitEvidence.observations[0].references[0]),
    ).toEqual(fallback.source_contract);

    const profileBody = {
      profile_id: "issue-64-reference-cost",
      profile_version: "1.0.0",
      model: "REFERENCE_COST",
      quote_source: null,
      reference_type: "MODEL_REFERENCE",
      latency_ms: 0,
      minimum_package_size: 1,
      tick_size: "0.000001",
      midpoint_to_adverse_fraction: null,
      additional_cost_per_package: "0",
      queue_model: "NOT_MODELED",
      market_impact_model: "NOT_MODELED",
      atomic_package: true,
    };
    const simulation = simulateHistoricalExecution({
      run_id: "issue-64-source-contract",
      frozen_decision_id: "decision-64",
      frozen_candidate_id: "dd-2026-08-25",
      candidate_fingerprint: entryEvidence.candidate_fingerprint,
      grading_profile: {
        version: "SPX-SPREAD-V1",
        hash: contentId("a"),
      },
      candidate_construction_profile: {
        version: "SPX-CANDIDATE-RESEARCH-V1",
        hash: contentId("b"),
      },
      measurement_basis: {
        basis_id: "MODEL_VALUATION",
        version: "1.0.0",
        hash: contentId("c"),
      },
      study_stage: "IN_SAMPLE",
      prior_outcome_accessed: true,
      decision_frozen_at: "2026-08-20T12:00:00.000Z",
      candidate_frozen_at: "2026-08-20T12:01:00.000Z",
      profile_frozen_at: "2026-08-20T12:02:00.000Z",
      outcome_accessed_at: "2026-09-10T12:00:00.000Z",
      source_manifest_ids: [
        ...new Set([
          ...entryEvidence.source_manifest_ids,
          ...exitEvidence.source_manifest_ids,
        ]),
      ].sort(),
      source_contract: fallback.source_contract,
      quantity: 1,
      horizon: {
        kind: "FIXED_TRADING_DAYS",
        trading_days: 3,
        scheduled_exit_at: exit.scheduled_checkpoint,
      },
      execution_profile: {
        ...profileBody,
        profile_hash: historicalExecutionProfileHash(profileBody),
      },
      fee_model: null,
      entry: {
        window_start: entry.scheduled_checkpoint,
        window_end: "2026-08-25T14:31:00.000Z",
        signed_limit:
          entry.valuation.regression_reference.signed_value,
        evidence: entryEvidence,
      },
      exit: {
        window_start: exit.scheduled_checkpoint,
        window_end: "2026-08-31T14:31:00.000Z",
        signed_limit:
          exit.valuation.regression_reference.signed_value,
        evidence: exitEvidence,
      },
    });
    expect(simulation.evidence_strength).toBe("REFERENCE_MODEL");
  });

  test("uses coherent parallel-IV package uncertainty scenarios", async () => {
    const candidate = {
      candidate_id: "credit-put-vertical",
      family: "CREDIT_VERTICAL",
      entry_date: "2026-08-25",
      legs: [
        {
          role: "SHORT_PUT",
          provider_symbol: "SPXW  260922P07400000",
          action: "SELL_TO_OPEN",
        },
        {
          role: "LONG_PUT",
          provider_symbol: "SPXW  260922P07350000",
          action: "BUY_TO_OPEN",
        },
      ],
    };
    const service = {
      getHistoricalCandlesBatch: jest.fn(async (request) =>
        request.instruments.map((instrument) => ({
          ...candleResult(instrument, request.interval, []),
          status: "NOT_AVAILABLE",
          failure_reasons: ["MISSING_CONTRACT_EVIDENCE"],
        })),
      ),
    };
    const result = await getHistoricalOptionPackageHorizons(
      service,
      horizonRequest({
        horizons: ["ENTRY"],
        candidates: [candidate],
        valuation_fallback: modelFallback([
          modelCheckpoint("2026-08-25", candidate.legs, {
            underlying: {
              value: "7400",
              ...modelSource("2026-08-25", "d"),
            },
          }),
        ]),
      }),
    );
    const valuation = result.candidates[0].horizons[0].valuation;
    const low = Number(valuation.uncertainty.signed_value_low);
    const high = Number(valuation.uncertainty.signed_value_high);

    expect(valuation.uncertainty.method).toBe("PARALLEL_IV_SHIFT");
    expect(low).toBeGreaterThanOrEqual(-50);
    expect(high).toBeLessThanOrEqual(0);
    expect(low).toBeLessThanOrEqual(
      Number(valuation.regression_reference.signed_value),
    );
    expect(high).toBeGreaterThanOrEqual(
      Number(valuation.regression_reference.signed_value),
    );
  });

  test("rejects future, stale, and invalid model inputs", async () => {
    await expect(
      getHistoricalOptionPackageHorizons(
        horizonService(),
        horizonRequest({
          horizons: ["ENTRY"],
          valuation_fallback: modelFallback([
            modelCheckpoint("2026-08-25", DD_LEGS, {
              underlying: {
                value: "7800",
                ...modelSource("2026-08-25", "d"),
                available_at: "2026-08-25T14:31:00.000Z",
              },
            }),
          ]),
        }),
      ),
    ).rejects.toThrow(
      "valuation_fallback.checkpoints[0].underlying.available_at must not be after the scheduled checkpoint",
    );

    const futureIvCheckpoint = modelCheckpoint("2026-08-25");
    futureIvCheckpoint.leg_inputs[0].available_at =
      "2026-08-25T14:31:00.000Z";
    await expect(
      getHistoricalOptionPackageHorizons(
        horizonService(),
        horizonRequest({
          horizons: ["ENTRY"],
          valuation_fallback: modelFallback([
            futureIvCheckpoint,
          ]),
        }),
      ),
    ).rejects.toThrow(
      "valuation_fallback.checkpoints[0].leg_inputs[0].available_at must not be after the scheduled checkpoint",
    );

    await expect(
      getHistoricalOptionPackageHorizons(
        horizonService(),
        horizonRequest({
          horizons: ["ENTRY"],
          valuation_fallback: modelFallback(
            [modelCheckpoint("2026-08-25")],
            { max_input_age_minutes: 10 },
          ),
        }),
      ),
    ).rejects.toThrow(
      "valuation_fallback.checkpoints[0].underlying.observed_at exceeds valuation_fallback.max_input_age_minutes",
    );

    const invalidIvCheckpoint = modelCheckpoint("2026-08-25");
    invalidIvCheckpoint.leg_inputs[0].implied_volatility = "0";
    await expect(
      getHistoricalOptionPackageHorizons(
        horizonService(),
        horizonRequest({
          horizons: ["ENTRY"],
          valuation_fallback: modelFallback([
            invalidIvCheckpoint,
          ]),
        }),
      ),
    ).rejects.toThrow(
      "valuation_fallback.checkpoints[0].leg_inputs[0].implied_volatility must be greater than 0",
    );
  });

  test("fails closed when CACHE_ONLY cannot resolve an exact manifest", async () => {
    const service = {
      getHistoricalCandlesBatch: jest.fn(async () => {
        throw new EvidenceCacheError(
          "EVIDENCE_CACHE_OBJECT_MISSING",
          "fixture manifest mismatch",
        );
      }),
    };

    await expect(
      getHistoricalOptionPackageHorizons(
        service,
        horizonRequest({
          horizons: ["ENTRY"],
          evidence_cache: {
            mode: "CACHE_ONLY",
            manifest_ids: [contentId("f")],
          },
        }),
      ),
    ).rejects.toMatchObject({
      code: "EVIDENCE_CACHE_OBJECT_MISSING",
    });
  });
});
