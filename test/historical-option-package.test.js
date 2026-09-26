import { readFileSync } from "node:fs";
import { describe, expect, jest, test } from "@jest/globals";
import {
  getHistoricalOptionPackageAtCheckpoint,
  getHistoricalOptionPackagePath,
} from "../dist/historical-option-package.js";
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

    expect(result).toMatchObject({
      status: "AVAILABLE",
      evidence_type: "HISTORICAL_OPTION_PACKAGE_REFERENCE",
      family: "DEBIT_VERTICAL",
      underlying: "SPX",
      as_of: fixture.checkpoint,
      effective_resolution: "5m",
      reference_value: {
        value: "21.06",
        price_effect: "DEBIT",
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
        available_at: "2026-08-27T13:40:00.000Z",
        observation_age_minutes: 50,
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

  test("returns missing evidence instead of a success-shaped package", async () => {
    const service = fixtureService();
    const original = service.getHistoricalCandlesBatch;
    service.getHistoricalCandlesBatch = jest.fn(async (request) => {
      const results = await original(request);
      results[0] = candleResult(request.instruments[0], request.interval, []);
      return results;
    });

    const result = await getHistoricalOptionPackageAtCheckpoint(
      service,
      checkpointRequest(),
    );

    expect(result.status).toBe("NOT_AVAILABLE");
    expect(result.reference_value).toBeNull();
    expect(result.temporal_alignment).toBe("UNKNOWN");
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
          throw new Error(
            "DXLink replays from start_time through the present and does not honor toTime; this request may require 42000 snapshot events, exceeding max_candles=20000.",
          );
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
        reason: "DXLINK_SNAPSHOT_LIMIT",
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
