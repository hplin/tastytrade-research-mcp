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
      capabilities: {
        historical_contract_universe_reconstructed: true,
        exact_provider_contract_identity: true,
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
    });
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
});
