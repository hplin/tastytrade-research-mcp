import { readFileSync } from "node:fs";
import { describe, expect, jest, test } from "@jest/globals";
import {
  getHistoricalSpxCandidateUniverse,
  prepareHistoricalSpxCandidateUniverse,
} from "../dist/historical-spx-reconstruction.js";

function loadFixture(name) {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"),
  );
}

const fixture = loadFixture("spx-universe-2026-08-25.json");

const REQUEST = {
  underlying: "SPX",
  as_of: "2026-08-25T14:30:00.000Z",
  min_dte: 21,
  max_dte: 35,
  strike_min: 7375,
  strike_max: 7950,
  strike_step: 25,
  option_sides: ["CALL", "PUT"],
  max_contracts: 500,
  phase: "REGRESSION_RESEARCH",
  references: { checkpoint_id: "spx-universe-2026-08-25-0730-pt" },
};

function candleResult(symbol, streamerSymbol, candles) {
  return {
    contract_version: "1.0.0",
    symbol,
    streamer_symbol: streamerSymbol,
    instrument_type: symbol === "SPX" ? "INDEX" : "OPTION",
    interval: "5m",
    requested_range: {
      start: "2026-08-25T13:25:00.000Z",
      end: REQUEST.as_of,
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

function fixtureCandles(source = fixture) {
  const bySymbol = new Map(
    source.options.map((option) => [option.symbol, option]),
  );
  return {
    getHistoricalCandles: jest.fn(async () =>
      candleResult(
        source.underlying.symbol,
        source.underlying.streamer_symbol,
        [structuredClone(source.underlying.candle)],
      ),
    ),
    getHistoricalCandlesBatch: jest.fn(async (input) =>
      input.instruments.map((instrument) => {
        const option = bySymbol.get(instrument.symbol);
        return candleResult(
          instrument.symbol,
          instrument.streamer_symbol,
          option ? [structuredClone(option.candle)] : [],
        );
      }),
    ),
  };
}

describe("historical SPX candidate universe", () => {
  test("prepares a bounded min/mid/max DTE SPXW grid", () => {
    const plan = prepareHistoricalSpxCandidateUniverse(REQUEST);

    expect(plan).toMatchObject({
      as_of: REQUEST.as_of,
      session_date: "2026-08-25",
      expiration_dates: ["2026-09-15", "2026-09-22", "2026-09-29"],
      strike_min: 7375,
      strike_max: 7950,
      strike_step: 25,
      option_sides: ["CALL", "PUT"],
      requested_contract_count: 144,
    });
    expect(plan.request_id).toMatch(/^[a-f0-9]{64}$/);
  });

  test("returns only timestamp-safe evidence across strikes and expirations", async () => {
    const candles = fixtureCandles();
    const result = await getHistoricalSpxCandidateUniverse(candles, REQUEST);

    expect(result).toMatchObject({
      contract_version: "1.0.0",
      status: "PARTIAL",
      evidence_type: "HISTORICAL_SPX_CANDIDATE_UNIVERSE",
      evidence_phase: "REGRESSION_RESEARCH",
      as_of: REQUEST.as_of,
      underlying: "SPX",
      requested_dte_range: { min: 21, max: 35 },
      requested_strike_range: { min: "7375", max: "7950", step: "25" },
      underlying_price: "7664.96",
      max_observation_age_minutes: 60,
      freshness_threshold_minutes: 60,
      capabilities: {
        historical_contract_universe_reconstructed: true,
        exact_provider_contract_identity: true,
        reconstructed_contract_identity: true,
        provider_returned_contract_identity: false,
        checkpoint_timestamp_safe: true,
        historical_price: true,
        historical_delta: true,
        historical_contract_iv: true,
        historical_open_interest: true,
        historical_volume: true,
        historical_bid_ask: false,
        full_historical_chain: false,
      },
      references: REQUEST.references,
    });
    expect(result.coverage).toMatchObject({
      requested_contract_count: 144,
      verified_contract_count: 18,
      missing_contract_count: 126,
      provider_errors: [],
    });
    expect(result.coverage.gaps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          expiration: "2026-09-22T20:00:00.000Z",
          option_side: "CALL",
          missing_strikes: expect.arrayContaining(["7925"]),
        }),
      ]),
    );
    expect(result.contracts).toHaveLength(18);
    expect(
      new Set(result.contracts.map((contract) => contract.expiration)),
    ).toEqual(
      new Set([
        "2026-09-15T20:00:00.000Z",
        "2026-09-22T20:00:00.000Z",
        "2026-09-29T20:00:00.000Z",
      ]),
    );
    for (const expiration of [
      "2026-09-15T20:00:00.000Z",
      "2026-09-22T20:00:00.000Z",
      "2026-09-29T20:00:00.000Z",
    ]) {
      for (const optionSide of ["CALL", "PUT"]) {
        expect(
          result.contracts.filter(
            (contract) =>
              contract.expiration === expiration &&
              contract.option_side === optionSide,
          ).length,
        ).toBeGreaterThanOrEqual(2);
      }
    }
    expect(result.contracts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider_symbol: "SPXW  260922P07375000",
          occ_symbol: "SPXW  260922P07375000",
          expiration: "2026-09-22T20:00:00.000Z",
          strike: "7375",
          option_side: "PUT",
          source_timestamp: "2026-08-25T13:55:00.000Z",
          historical_price: "29.1",
          historical_iv: "0.166",
          historical_open_interest: "1800",
          historical_volume: "18",
          observation_age_ms: 2_100_000,
          freshness: "FRESH",
          identity_source: "RECONSTRUCTED_OCC_VALIDATED_BY_DXLINK",
        }),
        expect.objectContaining({
          provider_symbol: "SPXW  260922C07950000",
          expiration: "2026-09-22T20:00:00.000Z",
          strike: "7950",
          option_side: "CALL",
        }),
      ]),
    );
    expect(
      result.contracts.every(
        (contract) =>
          Date.parse(contract.source_timestamp) <= Date.parse(result.as_of) &&
          contract.provenance.every(
            (item) =>
              Date.parse(item.source_timestamp) <= Date.parse(result.as_of),
          ),
      ),
    ).toBe(true);
    expect(
      result.contracts.some(
        (contract) => contract.provider_symbol === "SPXW  260922C07925000",
      ),
    ).toBe(false);
    expect(
      candles.getHistoricalCandlesBatch.mock.calls.every(
        ([input]) =>
          input.instruments.length <= 20 &&
          input.max_output_candles === 20_000 &&
          input.max_received_events === 20_000 &&
          input.max_buffer_bytes === 32 * 1024 * 1024 &&
          Date.parse(input.end_time) <= Date.parse(REQUEST.as_of),
      ),
    ).toBe(true);
  });

  test("fails input closed when the requested bounded grid exceeds max_contracts", () => {
    expect(() =>
      prepareHistoricalSpxCandidateUniverse({
        ...REQUEST,
        strike_min: 6000,
        strike_max: 9000,
        strike_step: 5,
        max_contracts: 500,
      }),
    ).toThrow("requested universe contains");
  });

  test("labels explicitly allowed stale pre-checkpoint evidence", async () => {
    const source = structuredClone(fixture);
    const stale = source.options.find(
      (option) => option.symbol === "SPXW  260922C07925000",
    );
    stale.candle.source_time = "2026-08-25T13:20:00.000Z";
    const result = await getHistoricalSpxCandidateUniverse(
      fixtureCandles(source),
      {
        ...REQUEST,
        max_observation_age_minutes: 120,
      },
    );

    expect(result.max_observation_age_minutes).toBe(120);
    expect(result.capabilities.stale_pre_checkpoint_evidence_included).toBe(
      true,
    );
    expect(
      result.contracts.find(
        (contract) =>
          contract.provider_symbol === "SPXW  260922C07925000",
      ),
    ).toMatchObject({
      source_timestamp: "2026-08-25T13:25:00.000Z",
      observation_age_ms: 3_900_000,
      freshness: "STALE",
      confidence: "LOW",
      warnings: expect.arrayContaining([
        "STALE_PRE_CHECKPOINT_OBSERVATION",
      ]),
    });
  });

  test("keeps future evidence excluded even with a longer observation window", async () => {
    const result = await getHistoricalSpxCandidateUniverse(
      fixtureCandles(),
      {
        ...REQUEST,
        max_observation_age_minutes: 1_440,
      },
    );

    expect(
      result.contracts.some(
        (contract) =>
          contract.provider_symbol === "SPXW  260922C07925000",
      ),
    ).toBe(false);
    expect(
      result.contracts.every(
        (contract) =>
          Date.parse(contract.source_timestamp) <= Date.parse(result.as_of),
      ),
    ).toBe(true);
  });

  test("uses a documented spot-forward fallback when parity timestamps do not align", async () => {
    const source = structuredClone(fixture);
    source.options.find(
      (option) => option.symbol === "SPXW  260915P07700000",
    ).candle.source_time = "2026-08-25T14:00:00.000Z";
    source.options.find(
      (option) => option.symbol === "SPXW  260929P07700000",
    ).candle.source_time = "2026-08-25T14:05:00.000Z";

    const result = await getHistoricalSpxCandidateUniverse(
      fixtureCandles(source),
      REQUEST,
    );
    const frontPut = result.contracts.find(
      (contract) =>
        contract.provider_symbol === "SPXW  260915P07425000",
    );
    const middleCall = result.contracts.find(
      (contract) =>
        contract.provider_symbol === "SPXW  260922C07900000",
    );
    const backCall = result.contracts.find(
      (contract) =>
        contract.provider_symbol === "SPXW  260929C07900000",
    );

    expect(frontPut.historical_delta).not.toBeNull();
    expect(Number(frontPut.historical_delta)).toBeCloseTo(-19.804, 3);
    expect(frontPut.warnings).toEqual(
      expect.arrayContaining([
        "DELTA_DERIVED_FROM_CANDLE_IV_AND_SPOT_FORWARD_APPROXIMATION",
        "SPOT_FORWARD_APPROXIMATION_ASSUMES_ZERO_CARRY",
      ]),
    );
    expect(frontPut.provenance).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "tastytrade-research-mcp:spot-forward-zero-carry",
          source_timestamp: REQUEST.as_of,
          fields: ["historical_delta"],
        }),
      ]),
    );
    expect(middleCall.warnings).toContain(
      "DELTA_DERIVED_FROM_CANDLE_IV_AND_PUT_CALL_PARITY_FORWARD",
    );
    expect(backCall.historical_delta).not.toBeNull();
    expect(backCall.provenance).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "tastytrade-research-mcp:spot-forward-zero-carry",
          source_timestamp: REQUEST.as_of,
          fields: ["historical_delta"],
        }),
      ]),
    );
    expect(result.field_coverage.historical_delta).toEqual({
      available: 18,
      missing: 0,
    });
    expect(result.capabilities.historical_delta).toBe(true);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        "DELTA_DERIVED_FROM_CANDLE_IV_AND_PUT_CALL_PARITY_FORWARD",
        "DELTA_DERIVED_FROM_CANDLE_IV_AND_SPOT_FORWARD_APPROXIMATION",
        "SPOT_FORWARD_APPROXIMATION_ASSUMES_ZERO_CARRY",
      ]),
    );
    expect(
      result.contracts.every((contract) =>
        contract.provenance.every(
          (item) =>
            Date.parse(item.source_timestamp) <= Date.parse(REQUEST.as_of),
        ),
      ),
    ).toBe(true);
  });

  test("preserves missing fields as null and downgrades aggregate capabilities", async () => {
    const source = structuredClone(fixture);
    const incomplete = source.options.find(
      (option) => option.symbol === "SPXW  260922P07375000",
    );
    incomplete.candle.implied_volatility = null;
    incomplete.candle.open_interest = null;
    incomplete.candle.volume = null;
    const result = await getHistoricalSpxCandidateUniverse(
      fixtureCandles(source),
      REQUEST,
    );
    const contract = result.contracts.find(
      (item) => item.provider_symbol === incomplete.symbol,
    );

    expect(contract).toMatchObject({
      historical_delta: null,
      historical_iv: null,
      historical_open_interest: null,
      historical_volume: null,
    });
    expect(contract.provenance).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "tastytrade-research-mcp:spot-forward-zero-carry",
        }),
      ]),
    );
    expect(contract.warnings).not.toContain(
      "DELTA_DERIVED_FROM_CANDLE_IV_AND_SPOT_FORWARD_APPROXIMATION",
    );
    expect(result.capabilities).toMatchObject({
      historical_delta: false,
      historical_contract_iv: false,
      historical_open_interest: false,
      historical_volume: false,
    });
    expect(result.field_coverage).toMatchObject({
      historical_delta: { available: 17, missing: 1 },
      historical_iv: { available: 17, missing: 1 },
      historical_open_interest: { available: 17, missing: 1 },
      historical_volume: { available: 17, missing: 1 },
    });
  });

  test("returns partial coverage when one provider batch fails", async () => {
    const candles = fixtureCandles();
    const retrieve = candles.getHistoricalCandlesBatch;
    let batchIndex = 0;
    candles.getHistoricalCandlesBatch = jest.fn(async (input) => {
      if (batchIndex++ === 0) throw new Error("fixture batch unavailable");
      return retrieve(input);
    });

    const result = await getHistoricalSpxCandidateUniverse(candles, REQUEST);

    expect(result.status).toBe("PARTIAL");
    expect(result.contracts.length).toBeGreaterThan(0);
    expect(result.coverage.provider_errors).toEqual([
      expect.objectContaining({
        message: "fixture batch unavailable",
      }),
    ]);
    expect(result.warnings).toContain("OPTION_BATCH_PROVIDER_ERRORS:1");
  });

  test("returns PROVIDER_ERROR when underlying evidence retrieval fails", async () => {
    const candles = fixtureCandles();
    candles.getHistoricalCandles = jest.fn(async () => {
      throw new Error("fixture underlying unavailable");
    });

    const result = await getHistoricalSpxCandidateUniverse(candles, REQUEST);

    expect(result.status).toBe("PROVIDER_ERROR");
    expect(result.contracts).toEqual([]);
    expect(result.coverage.provider_errors).toEqual([
      expect.objectContaining({
        message: "fixture underlying unavailable",
      }),
    ]);
  });
});
