import { readFileSync } from "node:fs";
import { describe, expect, jest, test } from "@jest/globals";
import {
  discoverHistoricalSpxCandidates,
  prepareHistoricalSpxCandidates,
} from "../dist/historical-spx-candidates.js";

function loadFixture(name) {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"),
  );
}

const fixture = loadFixture("spx-candidate-2026-04-15.json");
const entryTimeIgnoredFixture = loadFixture(
  "spx-candidate-entry-time-ignored-2026-08-25.json",
);
const pathBFixture = loadFixture("spx-candidate-path-b-2026-08-25.json");

const CHECKPOINT_REQUEST = {
  underlying: "SPX",
  as_of: "2026-04-15T14:30:00.000Z",
  min_dte: 21,
  max_dte: 35,
  sides: ["PUT"],
  selector_grid: [
    {
      method: "DELTA",
      value: "20",
      days_until_expiration: 28,
    },
  ],
  lookback_calendar_days: 1,
  phase: "REGRESSION_RESEARCH",
  references: { checkpoint_id: "spx-2026-04-15-0730-pt" },
};

const EXACT_SELECTION_REQUEST = {
  ...CHECKPOINT_REQUEST,
  as_of: "2026-04-14T19:45:00.000Z",
  references: { checkpoint_id: "spx-2026-04-14-1245-pt" },
};

const ENTRY_TIME_IGNORED_REQUEST = {
  ...CHECKPOINT_REQUEST,
  as_of: "2026-08-25T14:30:00.000Z",
  sides: ["CALL"],
  lookback_calendar_days: 0,
  references: { checkpoint_id: "spx-2026-08-25-0730-pt" },
};

const PATH_B_REQUEST = {
  underlying: "SPX",
  as_of: "2026-08-25T14:30:00.000Z",
  min_dte: 21,
  max_dte: 35,
  sides: ["CALL", "PUT"],
  selector_grid: [
    {
      method: "DELTA",
      value: "20",
      days_until_expiration: 28,
    },
    {
      method: "PERCENTAGE_OTM",
      value: "0.01",
      days_until_expiration: 28,
    },
  ],
  lookback_calendar_days: 0,
  phase: "REGRESSION_RESEARCH",
  references: { checkpoint_id: "spx-2026-08-25-0730-pt" },
};

function fixtureBacktester(source = fixture, logs = source.logs) {
  return {
    createBacktest: jest.fn(async () => source.create_response),
    getBacktest: jest.fn(async () => source.create_response),
    getBacktestLogs: jest.fn(async () => logs),
    simulateTrade: jest.fn(async () => source.simulation ?? { snapshots: [] }),
  };
}

function candleResult(
  symbol,
  streamerSymbol,
  candles,
  interval = "5m",
  session = "ALL",
) {
  return {
    contract_version: "1.0.0",
    symbol,
    streamer_symbol: streamerSymbol,
    instrument_type: symbol === "SPX" ? "INDEX" : "OPTION",
    interval,
    requested_range: {
      start: "2026-08-25T13:25:00.000Z",
      end: "2026-08-25T14:30:00.000Z",
    },
    actual_range:
      candles.length === 0
        ? null
        : {
            start: candles[0].source_time,
            end: candles.at(-1).source_time,
          },
    timezone:
      session === "REGULAR" ? "America/New_York" : "UTC",
    session,
    retrieved_at: "2026-08-25T16:00:00.000Z",
    source: "tastytrade-dxlink",
    source_timestamp_unit: "epoch_milliseconds",
    candles,
    snapshot_complete: true,
    snapshot_truncated: false,
    resampled: false,
    warnings: [],
  };
}

function fixturePathBCandles(source = pathBFixture) {
  const bySymbol = new Map(
    source.options.map((option) => [option.symbol, option]),
  );

  return {
    getHistoricalCandles: jest.fn(async (input) => {
      expect(input.symbol).toBe("SPX");
      return candleResult(
        source.underlying.symbol,
        source.underlying.streamer_symbol,
        [structuredClone(source.underlying.candle)],
        input.interval,
        input.session?.kind,
      );
    }),
    getHistoricalCandlesBatch: jest.fn(async (input) =>
      input.instruments.map((instrument) => {
        const option = bySymbol.get(instrument.symbol);
        return candleResult(
          instrument.symbol,
          instrument.streamer_symbol,
          option ? [structuredClone(option.candle)] : [],
          input.interval,
          input.session?.kind,
        );
      }),
    ),
  };
}

describe("historical SPX candidate discovery", () => {
  test("builds bounded provider requests from the selector grid", () => {
    const plan = prepareHistoricalSpxCandidates(CHECKPOINT_REQUEST);

    expect(plan.as_of).toBe("2026-04-15T14:30:00.000Z");
    expect(plan.start_date).toBe("2026-04-14");
    expect(plan.session_date).toBe("2026-04-15");
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0].backtest_request).toMatchObject({
      symbol: "SPX",
      startDate: "2026-04-14",
      endDate: "2026-04-15",
      legs: [
        {
          type: "equity-option",
          direction: "long",
          side: "put",
          quantity: 1,
          strikeSelection: "delta",
          delta: 20,
          daysUntilExpiration: 28,
        },
      ],
      entryConditions: {
        frequency: "every day",
        maximumActiveTrials: 2,
        maximumActiveTrialsBehavior: "don't enter",
      },
      exitConditions: { afterDaysInTrade: 1 },
    });
    expect(plan.items[0].backtest_request.entryConditions).not.toHaveProperty(
      "entryTime",
    );
    expect(plan.request_id).toMatch(/^[a-f0-9]{64}$/);
    expect(plan.resolution_profile).toMatchObject({
      profile_id: "DEFAULT_5M",
      requested_aggregation: "5m",
      native_aggregation: "5m",
      effective_aggregation: null,
      session: { kind: "ALL", timezone: "UTC" },
      alignment: "MIDNIGHT",
      max_observation_age_minutes: 60,
      max_temporal_skew_minutes: 0,
      fallback_policy: { allowed: false, aggregations: [] },
    });
    expect(plan.candidate_construction_profile).toBeNull();
  });

  test("keeps local checkpoints, resolution cohorts, and candidate policy in request identity", () => {
    const candidateConstructionProfile = {
      version: "candidate-construction/7",
      rules: {
        grading_engine: "external",
        dd_bucket: ["opaque", 3],
      },
    };
    const { as_of: _asOf, ...withoutAsOf } = PATH_B_REQUEST;
    const defaultPlan = prepareHistoricalSpxCandidates(PATH_B_REQUEST);
    const hourlyPlan = prepareHistoricalSpxCandidates({
      ...withoutAsOf,
      local_checkpoint: {
        local_date: "2026-08-25",
        local_time: "07:30",
        timezone: "America/Los_Angeles",
      },
      resolution_profile: {
        profile_id: "HOURLY_VALUATION_RESEARCH",
        profile_version: "1.0.0",
      },
      candidate_construction_profile: candidateConstructionProfile,
    });
    const otherProviderPlan = prepareHistoricalSpxCandidates({
      ...withoutAsOf,
      local_checkpoint: {
        local_date: "2026-08-25",
        local_time: "07:30",
        timezone: "America/Los_Angeles",
      },
      resolution_profile: {
        profile_id: "HOURLY_VALUATION_RESEARCH",
        profile_version: "1.0.0",
        provider_id: "licensed-provider-b",
      },
      candidate_construction_profile: candidateConstructionProfile,
    });

    expect(hourlyPlan.as_of).toBe("2026-08-25T14:30:00.000Z");
    expect(hourlyPlan.checkpoint).toMatchObject({
      kind: "IANA_LOCAL",
      timezone: "America/Los_Angeles",
      local_date: "2026-08-25",
      local_time: "07:30:00",
    });
    expect(hourlyPlan.resolution_profile).toMatchObject({
      profile_id: "HOURLY_VALUATION_RESEARCH",
      requested_aggregation: "1h",
      native_aggregation: "h",
      session: {
        kind: "REGULAR",
        timezone: "America/New_York",
        start_time: "09:30",
        end_time: "16:00",
      },
      alignment: "SESSION",
    });
    expect(hourlyPlan.candidate_construction_profile).toBe(
      candidateConstructionProfile,
    );
    expect(defaultPlan.request_id).not.toBe(hourlyPlan.request_id);
    expect(hourlyPlan.request_id).not.toBe(otherProviderPlan.request_id);
    expect(hourlyPlan.resolution_profile.cohort_id).not.toBe(
      otherProviderPlan.resolution_profile.cohort_id,
    );
  });

  test("preserves exact identity for a provider selection at the checkpoint", async () => {
    const backtester = fixtureBacktester();
    const result = await discoverHistoricalSpxCandidates(
      backtester,
      EXACT_SELECTION_REQUEST,
    );

    expect(result).toMatchObject({
      status: "COMPLETE",
      evidence_type: "HISTORICAL_SELECTOR_CANDIDATE_SET",
      evidence_phase: "REGRESSION_RESEARCH",
      as_of: "2026-04-14T19:45:00.000Z",
      surface: {
        atm_iv: null,
        skew: null,
        term_structure: null,
      },
      capabilities: {
        full_historical_chain: false,
        exact_provider_contract_identity: true,
        exact_leg_simulation: true,
        exact_checkpoint_simulation: true,
        backtester_entry_time_configurable: false,
        exact_checkpoint_selection: true,
        forward_outcomes_included: false,
      },
      references: { checkpoint_id: "spx-2026-04-14-1245-pt" },
    });
    expect(result.contracts).toEqual([
      expect.objectContaining({
        provider_symbol: "equity-option.SPX.20260512200000.P.6690000",
        simulation_symbol: "equity-option.SPX.20260512200000.P.6690000",
        occ_symbol: null,
        expiration: "2026-05-12T20:00:00.000Z",
        strike: "6690",
        option_side: "PUT",
        selected_at: "2026-04-14T19:45:00.000Z",
        requested_dte: 28,
        selected_dte: 28,
        dte_at_as_of: 28,
        selection_method: "DELTA",
        selector_value: "20",
        backtester_fill_price: "42.35",
        historical_price: "42.35",
        historical_price_effect: "DEBIT",
        selected_historical_delta: "-20.17",
        underlying_price: "6969.23",
        observation_age_ms: 0,
        confidence: "MEDIUM",
      }),
    ]);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        "BACKTESTER_ENTRY_TIME_NOT_CONFIGURABLE",
        "CHECKPOINT_SELECTION_REQUIRES_EXACT_TIMESTAMP",
      ]),
    );
    expect(result.warnings).toContain(
      "PUT:DELTA:20:28:FUTURE_TRIALS_EXCLUDED:1",
    );
    expect(
      result.provenance.every(
        (item) => Date.parse(item.source_timestamp) <= Date.parse(result.as_of),
      ),
    ).toBe(true);
    expect(backtester.simulateTrade).toHaveBeenCalledWith({
      underlying: "SPX",
      startTime: "2026-04-14T19:45:00.000Z",
      endTime: "2026-04-14T19:45:00.000Z",
      legs: [
        {
          symbol: "equity-option.SPX.20260512200000.P.6690000",
          direction: "long",
          quantity: 1,
        },
      ],
    });

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("profitLoss");
    expect(serialized).not.toContain("closeDateTime");
    expect(serialized).not.toContain("underlyingPriceAtClose");
    expect(serialized).not.toContain("7039.36");
    expect(serialized).not.toContain("reached days in trade limit");
  });

  test("fails closed instead of reusing a stale selector trial at 07:30 PT", async () => {
    const backtester = fixtureBacktester();
    const result = await discoverHistoricalSpxCandidates(
      backtester,
      CHECKPOINT_REQUEST,
    );

    expect(result.status).toBe("NOT_AVAILABLE");
    expect(result.contracts).toEqual([]);
    expect(result.attempts[0].status).toBe("NO_ELIGIBLE_TRIAL");
    expect(backtester.simulateTrade).not.toHaveBeenCalled();
    expect(result.capabilities.exact_checkpoint_selection).toBe(false);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        "PUT:DELTA:20:28:STALE_TRIALS_EXCLUDED:1",
        "PUT:DELTA:20:28:FUTURE_TRIALS_EXCLUDED:1",
        "PUT:DELTA:20:28:NO_BACKTEST_TRIAL_AT_EXACT_AS_OF",
      ]),
    );
  });

  test("does not trust an undocumented entryTime that the provider ignored", async () => {
    expect(
      entryTimeIgnoredFixture.submitted_request.entryConditions.entryTime,
    ).toBe("14:30:00Z");
    expect(
      Date.parse(entryTimeIgnoredFixture.logs.trials[0].openDateTime),
    ).toBeGreaterThan(Date.parse(ENTRY_TIME_IGNORED_REQUEST.as_of));

    const backtester = fixtureBacktester(entryTimeIgnoredFixture);
    const result = await discoverHistoricalSpxCandidates(
      backtester,
      ENTRY_TIME_IGNORED_REQUEST,
    );

    expect(result.status).toBe("NOT_AVAILABLE");
    expect(result.contracts).toEqual([]);
    expect(backtester.simulateTrade).not.toHaveBeenCalled();
    expect(backtester.createBacktest.mock.calls[0][0].entryConditions).not
      .toHaveProperty("entryTime");
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        "BACKTESTER_ENTRY_TIME_NOT_CONFIGURABLE",
        "CALL:DELTA:20:28:FUTURE_TRIALS_EXCLUDED:1",
        "CALL:DELTA:20:28:NO_BACKTEST_TRIAL_AT_EXACT_AS_OF",
      ]),
    );
  });

  test("reconstructs timestamp-safe 07:30 candidates from DXLink evidence", async () => {
    const backtester = fixtureBacktester(entryTimeIgnoredFixture);
    const candles = fixturePathBCandles();
    const result = await discoverHistoricalSpxCandidates(
      backtester,
      PATH_B_REQUEST,
      candles,
    );

    expect(result).toMatchObject({
      status: "COMPLETE",
      as_of: "2026-08-25T14:30:00.000Z",
      capabilities: {
        exact_provider_contract_identity: true,
        exact_leg_simulation: true,
        exact_checkpoint_simulation: false,
        exact_checkpoint_selection: true,
        deterministic_checkpoint_reconstruction: true,
        historical_contract_universe_reconstructed: true,
      },
    });

    expect(result.contracts).toHaveLength(4);
    expect(result.contracts).toEqual([
      expect.objectContaining({
        occ_symbol: "SPXW  260922C07900000",
        provider_symbol: "SPXW  260922C07900000",
        simulation_symbol: "SPXW  260922C07900000",
        expiration: "2026-09-22T20:00:00.000Z",
        strike: "7900",
        option_side: "CALL",
        selected_at: "2026-08-25T14:30:00.000Z",
        selection_method: "DELTA",
        selector_value: "20",
        requested_dte: 28,
        selected_dte: 28,
        dte_at_as_of: 28,
        historical_price: "24.52",
        selected_historical_iv: "0.1083390992764817",
        historical_volume: "14",
        historical_open_interest: "1298",
        underlying_price: "7664.96",
        observation_age_ms: 1_800_000,
      }),
      expect.objectContaining({
        occ_symbol: "SPXW  260922C07740000",
        strike: "7740",
        option_side: "CALL",
        selected_at: "2026-08-25T14:30:00.000Z",
        selection_method: "PERCENTAGE_OTM",
        selector_value: "0.01",
        observation_age_ms: 2_400_000,
      }),
      expect.objectContaining({
        occ_symbol: "SPXW  260922P07425000",
        strike: "7425",
        option_side: "PUT",
        selected_at: "2026-08-25T14:30:00.000Z",
        selection_method: "DELTA",
        selector_value: "20",
        observation_age_ms: 2_100_000,
      }),
      expect.objectContaining({
        occ_symbol: "SPXW  260922P07590000",
        strike: "7590",
        option_side: "PUT",
        selected_at: "2026-08-25T14:30:00.000Z",
        selection_method: "PERCENTAGE_OTM",
        selector_value: "0.01",
        observation_age_ms: 1_200_000,
      }),
    ]);
    expect(
      result.contracts
        .filter((candidate) => candidate.selection_method === "DELTA")
        .every(
          (candidate) =>
            Math.abs(Math.abs(Number(candidate.selected_historical_delta)) - 20) <
            2,
        ),
    ).toBe(true);
    expect(result.attempts.every((attempt) => attempt.status === "RECONSTRUCTED_CANDIDATE_FOUND")).toBe(
      true,
    );
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        "HISTORICAL_CONTRACT_UNIVERSE_RECONSTRUCTED_FROM_DXLINK",
        "OPTION_CANDLE_SOURCE_TIME_IS_INTERVAL_START",
        "DELTA_DERIVED_FROM_CANDLE_IV_AND_PUT_CALL_PARITY_FORWARD",
      ]),
    );
    expect(result.warnings).not.toContain(
      "BACKTEST_LOG_IDENTITY_FIELDS_ARE_UNDOCUMENTED",
    );
    expect(
      result.provenance.every(
        (item) => Date.parse(item.source_timestamp) <= Date.parse(result.as_of),
      ),
    ).toBe(true);
    expect(backtester.createBacktest).not.toHaveBeenCalled();
    expect(backtester.simulateTrade).not.toHaveBeenCalled();
    expect(candles.getHistoricalCandles).toHaveBeenCalledTimes(1);
    expect(candles.getHistoricalCandlesBatch).toHaveBeenCalled();
    expect(
      candles.getHistoricalCandlesBatch.mock.calls.every(
        ([input]) =>
          input.instruments.length <= 20 &&
          input.max_output_candles === 20_000 &&
          input.max_received_events === 20_000 &&
          input.max_buffer_bytes === 32 * 1024 * 1024 &&
          Date.parse(input.end_time) <= Date.parse(PATH_B_REQUEST.as_of),
      ),
    ).toBe(true);
    expect(
      result.contracts.some(
        (candidate) => candidate.occ_symbol === "SPXW  260922C07925000",
      ),
    ).toBe(false);
  });

  test("uses only the completed 09:30-10:30 ET native-hour bar", async () => {
    const source = structuredClone(pathBFixture);
    source.underlying.candle.source_time = "2026-08-25T13:30:00.000Z";
    for (const option of source.options) {
      option.candle.source_time = "2026-08-25T13:30:00.000Z";
    }
    const candles = fixturePathBCandles(source);
    const underlying = candles.getHistoricalCandles;
    candles.getHistoricalCandles = jest.fn(async (input) => {
      const result = await underlying(input);
      result.candles.push({
        ...structuredClone(result.candles[0]),
        source_time: PATH_B_REQUEST.as_of,
        close: "9999",
      });
      return result;
    });
    const batch = candles.getHistoricalCandlesBatch;
    candles.getHistoricalCandlesBatch = jest.fn(async (input) => {
      const results = await batch(input);
      for (const result of results) {
        if (result.candles[0]) {
          result.candles.push({
            ...structuredClone(result.candles[0]),
            source_time: PATH_B_REQUEST.as_of,
            close: "0.01",
          });
        }
      }
      return results;
    });
    const candidateConstructionProfile = {
      version: "candidate-construction/7",
      selection_rules: { intentionally_opaque: true },
    };

    const result = await discoverHistoricalSpxCandidates(
      fixtureBacktester(entryTimeIgnoredFixture),
      {
        ...PATH_B_REQUEST,
        resolution_profile: {
          profile_id: "HOURLY_VALUATION_RESEARCH",
          profile_version: "1.0.0",
        },
        candidate_construction_profile: candidateConstructionProfile,
      },
      candles,
    );

    expect(result.status).toBe("COMPLETE");
    expect(result.resolution_profile).toMatchObject({
      profile_id: "HOURLY_VALUATION_RESEARCH",
      requested_aggregation: "1h",
      native_aggregation: "h",
      effective_aggregation: "1h",
      session: {
        kind: "REGULAR",
        timezone: "America/New_York",
      },
      alignment: "SESSION",
    });
    expect(result.candidate_construction_profile).toBe(
      candidateConstructionProfile,
    );
    expect(
      result.contracts.every(
        (candidate) =>
          candidate.bar_start === "2026-08-25T13:30:00.000Z" &&
          candidate.bar_end === PATH_B_REQUEST.as_of &&
          candidate.available_at === PATH_B_REQUEST.as_of &&
          candidate.retrieved_at === "2026-08-25T16:00:00.000Z",
      ),
    ).toBe(true);
    expect(
      candles.getHistoricalCandles.mock.calls.every(
        ([input]) =>
          input.interval === "1h" &&
          input.session.kind === "REGULAR" &&
          input.session.timezone === "America/New_York",
      ),
    ).toBe(true);
    expect(
      candles.getHistoricalCandlesBatch.mock.calls.every(
        ([input]) =>
          input.interval === "1h" &&
          input.session.kind === "REGULAR" &&
          input.session.timezone === "America/New_York",
      ),
    ).toBe(true);
    expect(
      result.contracts.some(
        (candidate) => candidate.historical_price === "0.01",
      ),
    ).toBe(false);
  });

  test("fails reconstructed delta closed when historical IV is unavailable", async () => {
    const source = structuredClone(pathBFixture);
    for (const option of source.options) {
      option.candle.implied_volatility = null;
    }
    const backtester = fixtureBacktester(entryTimeIgnoredFixture);
    const result = await discoverHistoricalSpxCandidates(
      backtester,
      {
        ...PATH_B_REQUEST,
        sides: ["CALL"],
        selector_grid: [PATH_B_REQUEST.selector_grid[0]],
      },
      fixturePathBCandles(source),
    );

    expect(result.status).toBe("NOT_AVAILABLE");
    expect(result.contracts).toEqual([]);
    expect(result.warnings).toContain(
      "CALL:DELTA:20:28:NO_TIMESTAMP_SAFE_RECONSTRUCTED_CANDIDATE",
    );
  });

  test("uses an option bar only after the full five-minute interval completes", async () => {
    const source = structuredClone(pathBFixture);
    const future = source.options.find(
      (option) => option.symbol === "SPXW  260922C07925000",
    );
    future.candle.source_time = "2026-08-25T14:25:00.000Z";
    const result = await discoverHistoricalSpxCandidates(
      fixtureBacktester(entryTimeIgnoredFixture),
      {
        ...PATH_B_REQUEST,
        sides: ["CALL"],
        selector_grid: [PATH_B_REQUEST.selector_grid[0]],
      },
      fixturePathBCandles(source),
    );

    expect(result.status).toBe("COMPLETE");
    expect(result.contracts[0]).toMatchObject({
      occ_symbol: "SPXW  260922C07925000",
      selected_at: PATH_B_REQUEST.as_of,
      observation_age_ms: 0,
    });
  });

  test("rejects reconstructed option evidence older than sixty minutes", async () => {
    const source = structuredClone(pathBFixture);
    const candidate = source.options.find(
      (option) => option.symbol === "SPXW  260922C07900000",
    );
    candidate.candle.source_time = "2026-08-25T13:20:00.000Z";
    const result = await discoverHistoricalSpxCandidates(
      fixtureBacktester(entryTimeIgnoredFixture),
      {
        ...PATH_B_REQUEST,
        sides: ["CALL"],
        selector_grid: [PATH_B_REQUEST.selector_grid[0]],
      },
      fixturePathBCandles(source),
    );

    expect(result.status).toBe("NOT_AVAILABLE");
    expect(result.contracts).toEqual([]);
    expect(result.warnings).toContain(
      "CALL:DELTA:20:28:NO_TIMESTAMP_SAFE_RECONSTRUCTED_CANDIDATE",
    );
  });

  test("requires a timestamp-aligned put-call pair for reconstructed delta", async () => {
    const source = structuredClone(pathBFixture);
    const parityPut = source.options.find(
      (option) => option.symbol === "SPXW  260922P07700000",
    );
    parityPut.candle.source_time = "2026-08-25T14:00:00.000Z";
    const result = await discoverHistoricalSpxCandidates(
      fixtureBacktester(entryTimeIgnoredFixture),
      {
        ...PATH_B_REQUEST,
        sides: ["CALL"],
        selector_grid: [PATH_B_REQUEST.selector_grid[0]],
      },
      fixturePathBCandles(source),
    );

    expect(result.status).toBe("NOT_AVAILABLE");
    expect(result.contracts).toEqual([]);
    expect(result.warnings).toContain(
      "CALL:DELTA:20:28:NO_TIMESTAMP_SAFE_RECONSTRUCTED_CANDIDATE",
    );
  });

  test("returns NOT_AVAILABLE instead of using a future trial", async () => {
    const backtester = fixtureBacktester({
      ...fixture,
      logs: {
        trials: [fixture.logs.trials[1]],
        snapshots: {},
      },
    });
    const result = await discoverHistoricalSpxCandidates(
      backtester,
      CHECKPOINT_REQUEST,
    );

    expect(result.status).toBe("NOT_AVAILABLE");
    expect(result.contracts).toEqual([]);
    expect(result.attempts[0].status).toBe("NO_ELIGIBLE_TRIAL");
    expect(backtester.simulateTrade).not.toHaveBeenCalled();
    expect(result.warnings).toContain(
      "PUT:DELTA:20:28:FUTURE_TRIALS_EXCLUDED:1",
    );
  });

  test("does not invent identity when undocumented log fields drift", async () => {
    const logs = structuredClone(fixture.logs);
    delete logs.trials[0].orders[0].legs[0].instrument.internalSymbol;
    const backtester = fixtureBacktester(fixture, logs);
    const result = await discoverHistoricalSpxCandidates(
      backtester,
      EXACT_SELECTION_REQUEST,
    );

    expect(result.status).toBe("NOT_AVAILABLE");
    expect(result.contracts).toEqual([]);
    expect(result.attempts[0].status).toBe("INVALID_PROVIDER_LOGS");
    expect(result.warnings).toContain(
      "PUT:DELTA:20:28:ELIGIBLE_TRIAL_DID_NOT_EXPOSE_EXACT_CONTRACT_IDENTITY",
    );
    expect(backtester.simulateTrade).not.toHaveBeenCalled();
  });

  test("rejects an exact trial whose opening order is not at the checkpoint", async () => {
    const logs = structuredClone(fixture.logs);
    logs.trials[0].orders[0].datetime = "2026-04-14T19:45:01Z";
    const backtester = fixtureBacktester(fixture, logs);
    const result = await discoverHistoricalSpxCandidates(
      backtester,
      EXACT_SELECTION_REQUEST,
    );

    expect(result.status).toBe("NOT_AVAILABLE");
    expect(result.contracts).toEqual([]);
    expect(result.attempts[0].status).toBe("INVALID_PROVIDER_LOGS");
    expect(result.warnings).toContain(
      "PUT:DELTA:20:28:ELIGIBLE_TRIAL_DID_NOT_EXPOSE_EXACT_CONTRACT_IDENTITY",
    );
    expect(backtester.simulateTrade).not.toHaveBeenCalled();
  });

  test("fails closed when logs contain multiple trials at the checkpoint", async () => {
    const logs = structuredClone(fixture.logs);
    logs.trials = [logs.trials[0], structuredClone(logs.trials[0])];
    const backtester = fixtureBacktester(fixture, logs);
    const result = await discoverHistoricalSpxCandidates(
      backtester,
      EXACT_SELECTION_REQUEST,
    );

    expect(result.status).toBe("NOT_AVAILABLE");
    expect(result.contracts).toEqual([]);
    expect(result.attempts[0].status).toBe("INVALID_PROVIDER_LOGS");
    expect(result.warnings).toContain(
      "PUT:DELTA:20:28:MULTIPLE_BACKTEST_TRIALS_AT_EXACT_AS_OF",
    );
    expect(backtester.simulateTrade).not.toHaveBeenCalled();
  });

  test("enforces the requested DTE range at as_of, not selection time", async () => {
    const logs = structuredClone(fixture.logs);
    logs.trials[0].orders[0].legs[0].instrument.expiration =
      "2026-06-30T20:00:00Z";
    const backtester = fixtureBacktester(fixture, logs);
    const result = await discoverHistoricalSpxCandidates(
      backtester,
      EXACT_SELECTION_REQUEST,
    );

    expect(result.status).toBe("NOT_AVAILABLE");
    expect(result.contracts).toEqual([]);
    expect(result.attempts[0].status).toBe("NO_ELIGIBLE_TRIAL");
    expect(result.warnings).toContain(
      "PUT:DELTA:20:28:SELECTED_CONTRACT_DTE_OUTSIDE_REQUESTED_RANGE_AT_AS_OF",
    );
    expect(backtester.simulateTrade).not.toHaveBeenCalled();
  });

  test("rejects selectors outside the requested DTE range", () => {
    expect(() =>
      prepareHistoricalSpxCandidates({
        ...CHECKPOINT_REQUEST,
        selector_grid: [
          {
            method: "DELTA",
            value: "20",
            days_until_expiration: 36,
          },
        ],
      }),
    ).toThrow("must be between min_dte and max_dte");
  });
});
