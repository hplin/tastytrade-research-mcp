import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, jest, test } from "@jest/globals";
import {
  discoverHistoricalSpxCandidates,
  prepareHistoricalSpxCandidates,
} from "../dist/historical-spx-candidates.js";
import {
  discoverHistoricalSpxCandidatesRange,
  prepareHistoricalSpxCandidatesRange,
} from "../dist/historical-spx-candidate-range.js";

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

const RANGE_REQUEST = {
  underlying: "SPX",
  start_date: "2026-08-24",
  end_date: "2026-08-28",
  trading_calendar: {
    timezone: "America/Los_Angeles",
    local_time: "07:30",
    session_dates: [
      "2026-08-24",
      "2026-08-25",
      "2026-08-27",
      "2026-08-28",
    ],
  },
  min_dte: 21,
  max_dte: 35,
  sides: ["CALL"],
  selector_grid: [
    {
      method: "DELTA",
      value: "20",
      days_until_expiration: 28,
    },
  ],
  lookback_calendar_days: 0,
  resolution_profile: {
    profile_id: "HOURLY_PROVIDER_ALIGNED_RESEARCH",
    profile_version: "1.0.0",
  },
  candidate_construction_profile: {
    version: "SPX-CANDIDATE-RESEARCH-V1",
  },
  phase: "REGRESSION_RESEARCH",
  references: { checkpoint_id: "spx-august-range" },
  max_concurrency: 2,
  checkpoint_deadline_ms: 5_000,
  max_checkpoints_per_run: 50,
  retry_policy: {
    max_attempts: 2,
    backoff_ms: 0,
  },
};

const ISSUE_70_SELECTOR_GRID = [
  [20, 21],
  [30, 21],
  [20, 28],
  [45, 28],
  [20, 35],
  [30, 35],
].map(([value, daysUntilExpiration]) => ({
  method: "DELTA",
  value: String(value),
  days_until_expiration: daysUntilExpiration,
}));

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

function rangeCandidateResult(input, overrides = {}) {
  const asOf =
    input.as_of ??
    `${input.local_checkpoint.local_date}T14:30:00.000Z`;
  const localDate =
    input.local_checkpoint?.local_date ?? asOf.slice(0, 10);
  const status = overrides.status ?? "COMPLETE";
  const contracts =
    overrides.contracts ??
    (status === "NOT_AVAILABLE"
      ? []
      : [
          {
            provider_symbol: `SPXW-${localDate}`,
            option_side: "CALL",
            requested_dte: 28,
          },
        ]);
  return {
    contract_version: "1.0.0",
    request_id: `checkpoint-${localDate}`,
    status,
    evidence_type: "HISTORICAL_SELECTOR_CANDIDATE_SET",
    evidence_phase: "REGRESSION_RESEARCH",
    as_of: asOf,
    checkpoint: input.local_checkpoint
      ? {
          kind: "IANA_LOCAL",
          instant: asOf,
          timezone: "America/Los_Angeles",
          local_date: localDate,
          local_time: "07:30:00",
        }
      : {
          kind: "RFC3339",
          instant: asOf,
          timezone: null,
          local_date: null,
          local_time: null,
        },
    retrieved_at: asOf,
    underlying: "SPX",
    requested_dte_range: { min: 21, max: 35 },
    lookback_calendar_days: 0,
    contracts,
    surface: {
      atm_iv: null,
      skew: null,
      term_structure: null,
    },
    provenance: [],
    capabilities: {},
    attempts:
      overrides.attempts ??
      [
        {
          option_side: "CALL",
          selector: {
            method: "DELTA",
            value: "20",
            days_until_expiration: 28,
          },
          backtest_id: null,
          status:
            contracts.length > 0
              ? "RECONSTRUCTED_CANDIDATE_FOUND"
              : "NO_ELIGIBLE_TRIAL",
          error: null,
        },
      ],
    resolution_profile: {},
    candidate_construction_profile: {
      version: "SPX-CANDIDATE-RESEARCH-V1",
    },
    references: input.references ?? {},
    warnings: overrides.warnings ?? [],
    evidence_cache: overrides.evidence_cache ?? null,
  };
}

function continuationCursor(version, payload) {
  const serialized = JSON.stringify(payload);
  return `${version}.${Buffer.from(serialized, "utf8").toString(
    "base64url",
  )}.${createHash("sha256").update(serialized).digest("hex")}`;
}

function rateLimitedRangeCandidateResult(input, cacheHit = false) {
  const date = input.as_of.slice(0, 10);
  return rangeCandidateResult(input, {
    status: "PARTIAL",
    attempts: [
      {
        option_side: "CALL",
        selector: {
          method: "DELTA",
          value: "20",
          days_until_expiration: 28,
        },
        backtest_id: null,
        status: "RECONSTRUCTED_CANDIDATE_FOUND",
        error: null,
      },
      {
        option_side: "PUT",
        selector: {
          method: "DELTA",
          value: "20",
          days_until_expiration: 28,
        },
        backtest_id: null,
        status: "PROVIDER_ERROR",
        error: "Request failed with status code 429",
        provider_error: {
          code: "ERR_BAD_REQUEST",
          http_status: 429,
          retryable: true,
        },
      },
    ],
    evidence_cache: {
      contract_version: "1.0.0",
      manifest_ids: [`sha256:${date.replaceAll("-", "").padEnd(64, "0")}`],
      normalized_content_ids: [],
      provider_payload_content_ids: [],
      cache_hits: cacheHit ? 1 : 0,
      cache_misses: cacheHit ? 0 : 1,
      cache_only_hits: 0,
      refreshes: 0,
      retryable_failures: 0,
      retryable_failure_hits: 0,
      provider_calls_avoided: cacheHit ? 1 : 0,
      bytes_read: cacheHit ? 1 : 0,
      bytes_written: cacheHit ? 0 : 1,
    },
  });
}

describe("historical SPX candidate discovery", () => {
  test("keeps outcome cache roles out of the entry selector", () => {
    expect(() =>
      prepareHistoricalSpxCandidates({
        ...PATH_B_REQUEST,
        evidence_cache: {
          mode: "READ_WRITE",
          evidence_role: "OUTCOME_3_TRADING_DAYS",
        },
      }),
    ).toThrow(
      "Historical SPX candidate discovery only accepts ENTRY evidence.",
    );
  });

  test("never falls through to Backtester during cache-only entry replay", async () => {
    const backtester = fixtureBacktester(entryTimeIgnoredFixture);
    const candles = {
      getHistoricalCandles: jest.fn(async (request) =>
        candleResult(
          request.symbol,
          request.streamer_symbol ?? request.symbol,
          [],
          request.interval,
        ),
      ),
      getHistoricalCandlesBatch: jest.fn(async (request) =>
        request.instruments.map((instrument) =>
          candleResult(
            instrument.symbol,
            instrument.streamer_symbol ?? instrument.symbol,
            [],
            request.interval,
          ),
        ),
      ),
    };

    const result = await discoverHistoricalSpxCandidates(
      backtester,
      {
        ...PATH_B_REQUEST,
        sides: ["CALL"],
        selector_grid: [PATH_B_REQUEST.selector_grid[0]],
        evidence_cache: {
          mode: "CACHE_ONLY",
          manifest_ids: [`sha256:${"1".repeat(64)}`],
          evidence_role: "ENTRY",
        },
      },
      candles,
    );

    expect(result.status).toBe("NOT_AVAILABLE");
    expect(backtester.createBacktest).not.toHaveBeenCalled();
    expect(backtester.getBacktestLogs).not.toHaveBeenCalled();
    expect(backtester.simulateTrade).not.toHaveBeenCalled();
    expect(result.warnings).toContain(
      "CALL:DELTA:20:28:CACHE_ONLY_BACKTESTER_FALLBACK_DISABLED",
    );
  });

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
          input.instruments.length <= 100 &&
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

  test("uses a session-aligned SPX reference with provider-clock hourly options", async () => {
    const source = structuredClone(pathBFixture);
    source.underlying.candle.source_time = "2026-08-25T13:30:00.000Z";
    for (const option of source.options) {
      option.candle.source_time = "2026-08-25T13:00:00.000Z";
    }
    const candles = fixturePathBCandles(source);

    const result = await discoverHistoricalSpxCandidates(
      fixtureBacktester(entryTimeIgnoredFixture),
      {
        ...PATH_B_REQUEST,
        resolution_profile: {
          profile_id: "HOURLY_PROVIDER_ALIGNED_RESEARCH",
          profile_version: "1.0.0",
          max_observation_age_minutes: 120,
          max_temporal_skew_minutes: 0,
        },
      },
      candles,
    );

    expect(result.status).toBe("COMPLETE");
    expect(
      result.contracts.every(
        (candidate) =>
          candidate.bar_start === "2026-08-25T13:00:00.000Z" &&
          candidate.bar_end === "2026-08-25T14:00:00.000Z",
      ),
    ).toBe(true);
    expect(result.warnings).toContain(
      "SPX_UNDERLYING_USES_SESSION_ALIGNED_HOURLY_COHORT",
    );
    expect(
      candles.getHistoricalCandles.mock.calls[0][0].resolution_profile
        .profile_id,
    ).toBe("HOURLY_VALUATION_RESEARCH");
    expect(
      candles.getHistoricalCandlesBatch.mock.calls.every(
        ([input]) =>
          input.resolution_profile.profile_id ===
          "HOURLY_PROVIDER_ALIGNED_RESEARCH",
      ),
    ).toBe(true);
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

  test("preserves structured transient provider metadata", async () => {
    const rateLimit = Object.assign(
      new Error("Request failed with status code 429"),
      {
        code: "ERR_BAD_REQUEST",
        response: { status: 429 },
      },
    );
    const result = await discoverHistoricalSpxCandidates(
      {
        createBacktest: jest.fn(async () => {
          throw rateLimit;
        }),
        getBacktest: jest.fn(),
        getBacktestLogs: jest.fn(),
        simulateTrade: jest.fn(),
      },
      CHECKPOINT_REQUEST,
    );

    expect(result.attempts[0]).toMatchObject({
      status: "PROVIDER_ERROR",
      error: "Request failed with status code 429",
      provider_error: {
        code: "ERR_BAD_REQUEST",
        http_status: 429,
        retryable: true,
      },
    });
  });

  describe("historical SPX candidate range discovery", () => {
    test("expands only the caller-supplied trading sessions with stable logical identity", () => {
      const plan = prepareHistoricalSpxCandidatesRange(RANGE_REQUEST);
      const operationallyDifferent =
        prepareHistoricalSpxCandidatesRange({
          ...RANGE_REQUEST,
          max_concurrency: 4,
          checkpoint_deadline_ms: 60_000,
          max_checkpoints_per_run: 2,
          retry_policy: {
            max_attempts: 1,
            backoff_ms: 1_000,
          },
        });

      expect(plan.request_id).toMatch(/^[a-f0-9]{64}$/);
      expect(plan.request_id).toBe(operationallyDifferent.request_id);
      expect(
        plan.checkpoints.map((checkpoint) => ({
          session_date: checkpoint.session_date,
          scheduled_checkpoint: checkpoint.scheduled_checkpoint,
        })),
      ).toEqual([
        {
          session_date: "2026-08-24",
          scheduled_checkpoint: "2026-08-24T14:30:00.000Z",
        },
        {
          session_date: "2026-08-25",
          scheduled_checkpoint: "2026-08-25T14:30:00.000Z",
        },
        {
          session_date: "2026-08-27",
          scheduled_checkpoint: "2026-08-27T14:30:00.000Z",
        },
        {
          session_date: "2026-08-28",
          scheduled_checkpoint: "2026-08-28T14:30:00.000Z",
        },
      ]);
      expect(plan.max_concurrency).toBe(2);
      expect(plan.retry_policy).toEqual({
        max_attempts: 2,
        backoff_ms: 0,
      });
      expect(plan.checkpoints).toHaveLength(4);
    });

    test("rejects inferred, ambiguous, or pre-contextualized range inputs", () => {
      expect(() =>
        prepareHistoricalSpxCandidatesRange({
          ...RANGE_REQUEST,
          trading_calendar: {
            ...RANGE_REQUEST.trading_calendar,
            session_dates: ["2026-08-25", "2026-08-24"],
          },
        }),
      ).toThrow("strictly increasing");
      expect(() =>
        prepareHistoricalSpxCandidatesRange({
          ...RANGE_REQUEST,
          evidence_cache: {
            mode: "READ_WRITE",
            as_of: "2026-08-24T14:30:00.000Z",
          },
        }),
      ).toThrow("assigns evidence_cache.as_of");
      expect(() =>
        prepareHistoricalSpxCandidatesRange({
          ...RANGE_REQUEST,
          start_date: "2026-08-26",
          end_date: "2026-08-26",
        }),
      ).toThrow("does not contain a trading session");
    });

    test("uses bounded workers and preserves deterministic checkpoint order", async () => {
      let active = 0;
      let maximumActive = 0;
      const completionOrder = [];
      const delays = new Map([
        ["2026-08-24", 30],
        ["2026-08-25", 5],
        ["2026-08-27", 20],
        ["2026-08-28", 1],
      ]);
      const discover = jest.fn(async (_backtester, input, _candles, options) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        expect(options.deadline_ms).toBeGreaterThan(0);
        expect(options.deadline_ms).toBeLessThanOrEqual(5_000);
        expect(input.evidence_cache).toMatchObject({
          mode: "READ_WRITE",
          as_of: input.as_of,
          evidence_role: "ENTRY",
        });
        await new Promise((resolve) =>
          setTimeout(
            resolve,
            delays.get(input.as_of.slice(0, 10)),
          ),
        );
        active -= 1;
        completionOrder.push(input.as_of.slice(0, 10));
        return rangeCandidateResult(input);
      });

      const result = await discoverHistoricalSpxCandidatesRange(
        {},
        {
          ...RANGE_REQUEST,
          evidence_cache: {
            mode: "READ_WRITE",
            dataset_id: "fixture-candles",
          },
        },
        undefined,
        { discover },
      );

      expect(maximumActive).toBe(2);
      expect(completionOrder).not.toEqual(
        RANGE_REQUEST.trading_calendar.session_dates,
      );
      expect(
        result.checkpoints.map((checkpoint) => checkpoint.session_date),
      ).toEqual(RANGE_REQUEST.trading_calendar.session_dates);
      expect(
        result.checkpoints.every(
          (checkpoint) =>
            checkpoint.status === "AVAILABLE" &&
            checkpoint.attempt_count === 1,
        ),
      ).toBe(true);
      expect(result.status).toBe("COMPLETE");
      expect(result.progress).toMatchObject({
        trading_sessions_requested: 4,
        checkpoints_previously_completed: 0,
        checkpoints_attempted: 4,
        checkpoints_completed_this_run: 4,
        checkpoints_remaining: 0,
      });
      expect(result.coverage).toMatchObject({
        selector_attempts_requested: 4,
        selector_attempts_attempted: 4,
        selectors_found: 4,
        checkpoints_available: 4,
        checkpoints_failed: 0,
      });
      expect(result.continuation).toBeNull();
    });

    test("preserves partial progress, retries only transient failures, and resumes unresolved checkpoints", async () => {
      const calls = new Map();
      const discover = jest.fn(async (_backtester, input) => {
        const date = input.as_of.slice(0, 10);
        calls.set(date, (calls.get(date) ?? 0) + 1);
        if (date === "2026-08-25" && calls.get(date) === 1) {
          throw Object.assign(new Error("provider returned 429"), {
            code: "RATE_LIMITED",
            retryable: true,
          });
        }
        if (date === "2026-08-27") {
          throw Object.assign(new Error("provider timed out"), {
            code: "ETIMEDOUT",
            retryable: true,
          });
        }
        return rangeCandidateResult(input, {
          evidence_cache: {
            contract_version: "1.0.0",
            manifest_ids: [`sha256:${date.endsWith("24") ? "1".repeat(64) : "2".repeat(64)}`],
            normalized_content_ids: [],
            provider_payload_content_ids: [],
            cache_hits: date.endsWith("24") ? 1 : 0,
            cache_misses: date.endsWith("24") ? 0 : 1,
            cache_only_hits: 0,
            refreshes: 0,
            retryable_failures: 0,
            retryable_failure_hits: 0,
            provider_calls_avoided: date.endsWith("24") ? 1 : 0,
            bytes_read: 0,
            bytes_written: 0,
          },
        });
      });
      const request = {
        ...RANGE_REQUEST,
        end_date: "2026-08-27",
        max_concurrency: 1,
      };

      const first = await discoverHistoricalSpxCandidatesRange(
        {},
        request,
        undefined,
        { discover },
      );

      expect(
        first.checkpoints.map((checkpoint) => ({
          session_date: checkpoint.session_date,
          status: checkpoint.status,
          attempt_count: checkpoint.attempt_count,
        })),
      ).toEqual([
        {
          session_date: "2026-08-24",
          status: "AVAILABLE",
          attempt_count: 1,
        },
        {
          session_date: "2026-08-25",
          status: "AVAILABLE",
          attempt_count: 2,
        },
        {
          session_date: "2026-08-27",
          status: "PROVIDER_TIMEOUT",
          attempt_count: 2,
        },
      ]);
      expect(first.status).toBe("PARTIAL");
      expect(first.coverage).toMatchObject({
        checkpoints_available: 2,
        checkpoints_failed: 1,
        provider_timeout_count: 1,
        checkpoint_retry_count: 2,
        checkpoints_fully_served_from_cache: 1,
        checkpoints_requiring_provider_access: 2,
        cache: {
          cache_hits: 1,
          cache_misses: 1,
          provider_calls_avoided: 1,
        },
      });
      expect(first.continuation).toMatchObject({
        unresolved_session_dates: ["2026-08-27"],
        completed_session_dates: ["2026-08-24", "2026-08-25"],
      });

      const resumeDiscover = jest.fn(async (_backtester, input) =>
        rangeCandidateResult(input),
      );
      const resumed = await discoverHistoricalSpxCandidatesRange(
        {},
        {
          ...request,
          continuation_cursor: first.continuation.cursor,
        },
        undefined,
        { discover: resumeDiscover },
      );

      expect(resumeDiscover).toHaveBeenCalledTimes(1);
      expect(
        resumeDiscover.mock.calls[0][1].as_of.slice(0, 10),
      ).toBe("2026-08-27");
      expect(resumed.progress).toMatchObject({
        checkpoints_previously_completed: 2,
        checkpoints_attempted: 1,
        checkpoints_completed_this_run: 1,
        checkpoints_remaining: 0,
      });
      expect(resumed.status).toBe("COMPLETE");
      expect(resumed.continuation).toBeNull();
    });

    test("limits each invocation and keeps deferred checkpoints in the continuation cursor", async () => {
      const discover = jest.fn(async (_backtester, input) =>
        rangeCandidateResult(input),
      );
      const first = await discoverHistoricalSpxCandidatesRange(
        {},
        {
          ...RANGE_REQUEST,
          max_checkpoints_per_run: 2,
        },
        undefined,
        { discover },
      );

      expect(discover).toHaveBeenCalledTimes(2);
      expect(first.progress).toMatchObject({
        trading_sessions_requested: 4,
        checkpoints_attempted: 2,
        checkpoints_deferred: 2,
        checkpoints_remaining: 2,
      });
      expect(first.continuation.unresolved_session_dates).toEqual([
        "2026-08-27",
        "2026-08-28",
      ]);
      expect(first.continuation).toMatchObject({
        unattempted_session_dates: ["2026-08-27", "2026-08-28"],
        deferred_session_dates: [],
      });
      expect(first.continuation.cursor.startsWith("v2.")).toBe(true);

      const secondDiscover = jest.fn(async (_backtester, input) =>
        rangeCandidateResult(input),
      );
      const second = await discoverHistoricalSpxCandidatesRange(
        {},
        {
          ...RANGE_REQUEST,
          continuation_cursor: first.continuation.cursor,
        },
        undefined,
        { discover: secondDiscover },
      );

      expect(
        secondDiscover.mock.calls.map(
          ([, input]) => input.as_of.slice(0, 10),
        ),
      ).toEqual(["2026-08-27", "2026-08-28"]);
      expect(second.progress.checkpoints_previously_completed).toBe(2);
      expect(second.progress.checkpoints_remaining).toBe(0);
      expect(second.continuation).toBeNull();
    });

    test("finishes the first pass before retrying rate-limited partial checkpoints", async () => {
      const sessionDates = [
        "2026-08-24",
        "2026-08-25",
        "2026-08-26",
        "2026-08-27",
        "2026-08-28",
        "2026-08-31",
      ];
      const attempts = new Map();
      const calledDates = [];
      const discover = jest.fn(async (_backtester, input) => {
        const date = input.as_of.slice(0, 10);
        calledDates.push(date);
        attempts.set(date, (attempts.get(date) ?? 0) + 1);
        if (
          sessionDates.slice(0, 2).includes(date) &&
          attempts.get(date) === 1
        ) {
          return rateLimitedRangeCandidateResult(input);
        }
        return rangeCandidateResult(input, {
          evidence_cache: sessionDates.slice(0, 2).includes(date)
            ? rateLimitedRangeCandidateResult(input, true).evidence_cache
            : null,
        });
      });
      const request = {
        ...RANGE_REQUEST,
        start_date: sessionDates[0],
        end_date: sessionDates.at(-1),
        trading_calendar: {
          ...RANGE_REQUEST.trading_calendar,
          session_dates: sessionDates,
        },
        max_concurrency: 1,
        max_checkpoints_per_run: 2,
        retry_policy: {
          max_attempts: 1,
          backoff_ms: 0,
        },
      };
      const rounds = [];
      let cursor;
      for (let round = 0; round < 4; round += 1) {
        const result = await discoverHistoricalSpxCandidatesRange(
          {},
          {
            ...request,
            ...(cursor ? { continuation_cursor: cursor } : {}),
          },
          undefined,
          { discover },
        );
        rounds.push(result);
        cursor = result.continuation?.cursor;
      }

      expect(calledDates).toEqual([
        "2026-08-24",
        "2026-08-25",
        "2026-08-26",
        "2026-08-27",
        "2026-08-28",
        "2026-08-31",
        "2026-08-24",
        "2026-08-25",
      ]);
      expect(rounds[0].checkpoints).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            status: "PARTIAL",
            result: expect.objectContaining({
              contracts: [
                expect.objectContaining({
                  provider_symbol: "SPXW-2026-08-24",
                }),
              ],
            }),
            error: expect.objectContaining({
              category: "PROVIDER_RATE_LIMIT",
              retryable: true,
            }),
          }),
        ]),
      );
      expect(rounds[0].continuation).toMatchObject({
        unattempted_session_dates: sessionDates.slice(2),
        deferred_session_dates: sessionDates.slice(0, 2),
        unresolved_session_dates: [
          ...sessionDates.slice(2),
          ...sessionDates.slice(0, 2),
        ],
      });
      expect(rounds[1].continuation).toMatchObject({
        unattempted_session_dates: sessionDates.slice(4),
        deferred_session_dates: sessionDates.slice(0, 2),
      });
      expect(rounds[2].continuation).toMatchObject({
        unattempted_session_dates: [],
        deferred_session_dates: sessionDates.slice(0, 2),
      });
      expect(rounds[3].continuation).toBeNull();
      expect(rounds[3].coverage.cache).toMatchObject({
        cache_hits: 2,
        cache_misses: 0,
        provider_calls_avoided: 2,
      });
      expect(
        new Set(rounds.map((result) => result.request_id)).size,
      ).toBe(1);
      expect(
        prepareHistoricalSpxCandidatesRange({
          ...request,
          continuation_cursor: rounds[0].continuation.cursor,
        }).request_id,
      ).toBe(rounds[0].request_id);
    });

    test("makes a finite first pass over 21 sessions and rotates deferred retries", async () => {
      const sessionDates = [
        "2026-08-03",
        "2026-08-04",
        "2026-08-05",
        "2026-08-06",
        "2026-08-07",
        "2026-08-10",
        "2026-08-11",
        "2026-08-12",
        "2026-08-13",
        "2026-08-14",
        "2026-08-17",
        "2026-08-18",
        "2026-08-19",
        "2026-08-20",
        "2026-08-21",
        "2026-08-24",
        "2026-08-25",
        "2026-08-26",
        "2026-08-27",
        "2026-08-28",
        "2026-08-31",
      ];
      const calledDates = [];
      const discover = jest.fn(async (_backtester, input) => {
        calledDates.push(input.as_of.slice(0, 10));
        return rateLimitedRangeCandidateResult(input);
      });
      const request = {
        ...RANGE_REQUEST,
        start_date: sessionDates[0],
        end_date: sessionDates.at(-1),
        trading_calendar: {
          ...RANGE_REQUEST.trading_calendar,
          session_dates: sessionDates,
        },
        max_concurrency: 1,
        max_checkpoints_per_run: 5,
        retry_policy: {
          max_attempts: 1,
          backoff_ms: 0,
        },
      };
      let cursor;
      let lastFirstPass;
      for (let round = 0; round < 5; round += 1) {
        lastFirstPass = await discoverHistoricalSpxCandidatesRange(
          {},
          {
            ...request,
            ...(cursor ? { continuation_cursor: cursor } : {}),
          },
          undefined,
          { discover },
        );
        cursor = lastFirstPass.continuation.cursor;
      }

      expect(calledDates).toEqual(sessionDates);
      expect(lastFirstPass.continuation).toMatchObject({
        unattempted_session_dates: [],
        deferred_session_dates: sessionDates,
        unresolved_session_dates: sessionDates,
      });
      expect(lastFirstPass.progress).toMatchObject({
        checkpoints_attempted: 1,
        checkpoints_deferred: 20,
        checkpoints_remaining: 21,
        checkpoints_unattempted: 0,
        checkpoints_awaiting_retry: 21,
      });

      const retryRound = await discoverHistoricalSpxCandidatesRange(
        {},
        {
          ...request,
          continuation_cursor: cursor,
        },
        undefined,
        { discover },
      );
      expect(
        retryRound.checkpoints.map((checkpoint) => checkpoint.session_date),
      ).toEqual(sessionDates.slice(0, 5));
      expect(retryRound.continuation.deferred_session_dates).toEqual([
        ...sessionDates.slice(5),
        ...sessionDates.slice(0, 5),
      ]);
      expect(retryRound.continuation.unattempted_session_dates).toEqual([]);
    });

    test("accepts v1 cursors and emits classified v2 queue state", async () => {
      const plan = prepareHistoricalSpxCandidatesRange(RANGE_REQUEST);
      const cursor = continuationCursor("v1", {
        completed: [],
        contract_version: "1.0.0",
        pending_session_dates:
          RANGE_REQUEST.trading_calendar.session_dates,
        request_id: plan.request_id,
      });
      const discover = jest.fn(async (_backtester, input) =>
        rateLimitedRangeCandidateResult(input),
      );
      const result = await discoverHistoricalSpxCandidatesRange(
        {},
        {
          ...RANGE_REQUEST,
          max_checkpoints_per_run: 1,
          retry_policy: {
            max_attempts: 1,
            backoff_ms: 0,
          },
          continuation_cursor: cursor,
        },
        undefined,
        { discover },
      );

      expect(result.request_id).toBe(plan.request_id);
      expect(result.continuation.cursor.startsWith("v2.")).toBe(true);
      expect(result.continuation).toMatchObject({
        unattempted_session_dates:
          RANGE_REQUEST.trading_calendar.session_dates.slice(1),
        deferred_session_dates: [
          RANGE_REQUEST.trading_calendar.session_dates[0],
        ],
      });
    });

    test("rejects cursor tampering and logical-request changes before discovery", async () => {
      const discover = jest.fn(async (_backtester, input) =>
        rangeCandidateResult(input),
      );
      const first = await discoverHistoricalSpxCandidatesRange(
        {},
        {
          ...RANGE_REQUEST,
          max_checkpoints_per_run: 1,
        },
        undefined,
        { discover },
      );
      const cursor = first.continuation.cursor;
      discover.mockClear();

      await expect(
        discoverHistoricalSpxCandidatesRange(
          {},
          {
            ...RANGE_REQUEST,
            max_checkpoints_per_run: 1,
            continuation_cursor: `${cursor.slice(0, -1)}${
              cursor.endsWith("0") ? "1" : "0"
            }`,
          },
          undefined,
          { discover },
        ),
      ).rejects.toThrow("integrity check");
      await expect(
        discoverHistoricalSpxCandidatesRange(
          {},
          {
            ...RANGE_REQUEST,
            selector_grid: [
              {
                method: "DELTA",
                value: "25",
                days_until_expiration: 28,
              },
            ],
            max_checkpoints_per_run: 1,
            continuation_cursor: cursor,
          },
          undefined,
          { discover },
        ),
      ).rejects.toThrow("does not match");
      const [, encoded] = cursor.split(".");
      const payload = JSON.parse(
        Buffer.from(encoded, "base64url").toString("utf8"),
      );
      payload.deferred_session_dates = [
        payload.unattempted_session_dates[0],
      ];
      const invalidQueueCursor = continuationCursor("v2", payload);
      await expect(
        discoverHistoricalSpxCandidatesRange(
          {},
          {
            ...RANGE_REQUEST,
            max_checkpoints_per_run: 1,
            continuation_cursor: invalidQueueCursor,
          },
          undefined,
          { discover },
        ),
      ).rejects.toThrow("progress does not match");
      expect(discover).not.toHaveBeenCalled();
    });

    test("does not retry non-transient provider failures", async () => {
      const discover = jest.fn(async () => {
        throw Object.assign(new Error("provider rejected the request"), {
          code: "BAD_REQUEST",
          retryable: false,
        });
      });
      const result = await discoverHistoricalSpxCandidatesRange(
        {},
        {
          ...RANGE_REQUEST,
          end_date: "2026-08-24",
          retry_policy: {
            max_attempts: 3,
            backoff_ms: 0,
          },
        },
        undefined,
        { discover },
      );

      expect(discover).toHaveBeenCalledTimes(1);
      expect(result.checkpoints[0]).toMatchObject({
        status: "PROVIDER_ERROR",
        attempt_count: 1,
        error: {
          code: "BAD_REQUEST",
          retryable: false,
        },
      });
      expect(result.continuation.unresolved_session_dates).toEqual([
        "2026-08-24",
      ]);
    });

    test("retries structured rate limits returned by single discovery", async () => {
      let attempt = 0;
      const discover = jest.fn(async (_backtester, input) => {
        attempt += 1;
        if (attempt === 1) {
          return rangeCandidateResult(input, {
            status: "NOT_AVAILABLE",
            contracts: [],
            attempts: [
              {
                option_side: "CALL",
                selector: {
                  method: "DELTA",
                  value: "20",
                  days_until_expiration: 28,
                },
                backtest_id: null,
                status: "PROVIDER_ERROR",
                error: "Request failed with status code 429",
                provider_error: {
                  code: "ERR_BAD_REQUEST",
                  http_status: 429,
                  retryable: true,
                },
              },
            ],
          });
        }
        return rangeCandidateResult(input);
      });
      const result = await discoverHistoricalSpxCandidatesRange(
        {},
        {
          ...RANGE_REQUEST,
          end_date: "2026-08-24",
        },
        undefined,
        { discover },
      );

      expect(discover).toHaveBeenCalledTimes(2);
      expect(result.checkpoints[0]).toMatchObject({
        status: "AVAILABLE",
        attempt_count: 2,
      });
      expect(result.coverage.checkpoint_retry_count).toBe(1);
    });

    test("retains partial evidence when a later retry times out", async () => {
      let attempt = 0;
      const discover = jest.fn(async (_backtester, input) => {
        attempt += 1;
        if (attempt === 1) {
          return rangeCandidateResult(input, {
            status: "PARTIAL",
            attempts: [
              {
                option_side: "CALL",
                selector: {
                  method: "DELTA",
                  value: "20",
                  days_until_expiration: 28,
                },
                backtest_id: null,
                status: "RECONSTRUCTED_CANDIDATE_FOUND",
                error: null,
              },
              {
                option_side: "PUT",
                selector: {
                  method: "DELTA",
                  value: "20",
                  days_until_expiration: 28,
                },
                backtest_id: null,
                status: "PROVIDER_ERROR",
                error: "provider timed out",
                provider_error: {
                  code: "ETIMEDOUT",
                  http_status: null,
                  retryable: true,
                },
              },
            ],
          });
        }
        throw Object.assign(new Error("provider timed out again"), {
          code: "ETIMEDOUT",
          retryable: true,
        });
      });
      const result = await discoverHistoricalSpxCandidatesRange(
        {},
        {
          ...RANGE_REQUEST,
          end_date: "2026-08-24",
        },
        undefined,
        { discover },
      );

      expect(result.checkpoints[0]).toMatchObject({
        status: "PARTIAL",
        attempt_count: 2,
        result: {
          status: "PARTIAL",
          contracts: [{ provider_symbol: "SPXW-2026-08-24" }],
        },
        error: {
          category: "PROVIDER_TIMEOUT",
          retryable: true,
        },
      });
      expect(result.continuation.unresolved_session_dates).toEqual([
        "2026-08-24",
      ]);
    });

    test("counts Backtester fallback as provider access on cache hits", async () => {
      const discover = jest.fn(async (_backtester, input) =>
        rangeCandidateResult(input, {
          attempts: [
            {
              option_side: "CALL",
              selector: {
                method: "DELTA",
                value: "20",
                days_until_expiration: 28,
              },
              backtest_id: "job-1",
              status: "CANDIDATE_FOUND",
              error: null,
            },
          ],
          evidence_cache: {
            contract_version: "1.0.0",
            manifest_ids: [`sha256:${"1".repeat(64)}`],
            normalized_content_ids: [],
            provider_payload_content_ids: [],
            cache_hits: 1,
            cache_misses: 0,
            cache_only_hits: 0,
            refreshes: 0,
            retryable_failures: 0,
            retryable_failure_hits: 0,
            provider_calls_avoided: 1,
            bytes_read: 1,
            bytes_written: 0,
          },
        }),
      );
      const result = await discoverHistoricalSpxCandidatesRange(
        {},
        {
          ...RANGE_REQUEST,
          end_date: "2026-08-24",
        },
        undefined,
        { discover },
      );

      expect(result.checkpoints[0]).toMatchObject({
        cache_fully_served: false,
        provider_access_required: true,
      });
      expect(result.coverage).toMatchObject({
        checkpoints_fully_served_from_cache: 0,
        checkpoints_requiring_provider_access: 1,
      });
    });

    test("matches the successful single-checkpoint discovery contract exactly", async () => {
      const single = await discoverHistoricalSpxCandidates(
        fixtureBacktester(entryTimeIgnoredFixture),
        {
          ...PATH_B_REQUEST,
          references: { checkpoint_id: "spx-range-parity" },
        },
        fixturePathBCandles(),
      );
      const range = await discoverHistoricalSpxCandidatesRange(
        fixtureBacktester(entryTimeIgnoredFixture),
        {
          ...RANGE_REQUEST,
          start_date: "2026-08-25",
          end_date: "2026-08-25",
          trading_calendar: {
            timezone: "America/Los_Angeles",
            local_time: "07:30",
            session_dates: ["2026-08-25"],
          },
          sides: PATH_B_REQUEST.sides,
          selector_grid: PATH_B_REQUEST.selector_grid,
          resolution_profile: undefined,
          candidate_construction_profile: undefined,
          references: { checkpoint_id: "spx-range-parity" },
          checkpoint_deadline_ms: 120_000,
          retry_policy: {
            max_attempts: 1,
            backoff_ms: 0,
          },
        },
        fixturePathBCandles(),
      );

      expect(range.checkpoints).toHaveLength(1);
      expect(range.checkpoints[0]).toMatchObject({
        session_date: "2026-08-25",
        scheduled_checkpoint: "2026-08-25T14:30:00.000Z",
        status: "AVAILABLE",
        result: single,
      });
    });

    test("reaches selector evaluation without serial provider bootstrap for the issue 70 grid", async () => {
      const candles = fixturePathBCandles();
      const result = await discoverHistoricalSpxCandidatesRange(
        fixtureBacktester(entryTimeIgnoredFixture),
        {
          ...RANGE_REQUEST,
          start_date: "2026-08-25",
          end_date: "2026-08-25",
          trading_calendar: {
            timezone: "America/Los_Angeles",
            local_time: "07:30",
            session_dates: ["2026-08-25"],
          },
          sides: ["CALL", "PUT"],
          selector_grid: ISSUE_70_SELECTOR_GRID,
          resolution_profile: undefined,
          checkpoint_deadline_ms: 15_000,
          retry_policy: {
            max_attempts: 1,
            backoff_ms: 0,
          },
        },
        candles,
      );

      expect(candles.getHistoricalCandlesBatch.mock.calls.length).toBeLessThanOrEqual(
        5,
      );
      expect(
        candles.getHistoricalCandlesBatch.mock.calls.every(
          ([request]) => request.instruments.length <= 100,
        ),
      ).toBe(true);
      expect(result.coverage.selector_attempts_attempted).toBe(12);
      expect(result.checkpoints[0].diagnostics).toMatchObject({
        timeout_stage: null,
        selector_attempts_started: expect.arrayContaining([
          {
            option_side: "CALL",
            selector: {
              method: "DELTA",
              value: "20",
              days_until_expiration: 21,
            },
          },
          {
            option_side: "PUT",
            selector: {
              method: "DELTA",
              value: "30",
              days_until_expiration: 35,
            },
          },
        ]),
      });
      expect(result.checkpoints[0].diagnostics.stages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            stage: "CONTRACT_UNIVERSE",
            status: "COMPLETED",
          }),
          expect.objectContaining({
            stage: "CANDLE_RECONSTRUCTION",
            status: "COMPLETED",
          }),
          expect.objectContaining({
            stage: "SELECTOR_EVALUATION",
            status: "COMPLETED",
          }),
        ]),
      );
    });

    test("identifies a timeout during provider bootstrap after cache lookup starts", async () => {
      let now = 0;
      const discover = jest.fn(
        async (_backtester, _input, _candles, execution) => {
          execution.on_progress({
            stage: "CACHE_LOOKUP",
            state: "STARTED",
          });
          now = 2;
          execution.on_progress({
            stage: "PROVIDER_BOOTSTRAP",
            state: "STARTED",
          });
          now = 7;
          throw Object.assign(new Error("provider timed out"), {
            code: "PROVIDER_TIMEOUT",
            retryable: true,
          });
        },
      );
      const result = await discoverHistoricalSpxCandidatesRange(
        {},
        {
          ...RANGE_REQUEST,
          end_date: "2026-08-24",
          retry_policy: {
            max_attempts: 1,
            backoff_ms: 0,
          },
        },
        undefined,
        { discover, now: () => now },
      );

      expect(result.checkpoints[0].diagnostics).toMatchObject({
        elapsed_ms: 7,
        timeout_stage: "PROVIDER_BOOTSTRAP",
        selector_attempts_started: [],
        stages: expect.arrayContaining([
          {
            stage: "CACHE_LOOKUP",
            status: "TIMED_OUT",
            duration_ms: 7,
            operation_count: 1,
          },
          {
            stage: "PROVIDER_BOOTSTRAP",
            status: "TIMED_OUT",
            duration_ms: 5,
            operation_count: 1,
          },
        ]),
      });
    });

    test("counts selectors that start before a selector-evaluation timeout", async () => {
      let now = 0;
      const discover = jest.fn(
        async (_backtester, _input, _candles, execution) => {
          execution.on_progress({
            stage: "SELECTOR_EVALUATION",
            state: "STARTED",
          });
          now = 1;
          execution.on_progress({
            stage: "SELECTOR_EVALUATION",
            state: "PROGRESS",
            selector: {
              option_side: "CALL",
              method: "DELTA",
              value: "20",
              days_until_expiration: 28,
            },
          });
          now = 4;
          throw Object.assign(new Error("provider timed out"), {
            code: "PROVIDER_TIMEOUT",
            retryable: true,
          });
        },
      );
      const result = await discoverHistoricalSpxCandidatesRange(
        {},
        {
          ...RANGE_REQUEST,
          end_date: "2026-08-24",
          retry_policy: {
            max_attempts: 1,
            backoff_ms: 0,
          },
        },
        undefined,
        { discover, now: () => now },
      );

      expect(result.checkpoints[0].diagnostics).toMatchObject({
        timeout_stage: "SELECTOR_EVALUATION",
        selector_attempts_started: [
          {
            option_side: "CALL",
            selector: {
              method: "DELTA",
              value: "20",
              days_until_expiration: 28,
            },
          },
        ],
      });
      expect(result.coverage).toMatchObject({
        selector_attempts_attempted: 1,
        by_dte: expect.arrayContaining([
          { dte: 28, requested: 1, attempted: 1, found: 0 },
        ]),
        by_side: [
          {
            option_side: "CALL",
            requested: 1,
            attempted: 1,
            found: 0,
          },
        ],
      });
    });

    test("attributes result-derived provider timeouts to selector evaluation", async () => {
      const backtester = fixtureBacktester();
      backtester.createBacktest.mockRejectedValue(
        Object.assign(new Error("selector timed out"), {
          code: "ETIMEDOUT",
          retryable: true,
        }),
      );
      const result = await discoverHistoricalSpxCandidatesRange(
        backtester,
        {
          ...RANGE_REQUEST,
          end_date: "2026-08-24",
          retry_policy: {
            max_attempts: 1,
            backoff_ms: 0,
          },
        },
      );

      expect(result.checkpoints[0]).toMatchObject({
        status: "PROVIDER_TIMEOUT",
        result: {
          attempts: [
            expect.objectContaining({
              status: "PROVIDER_ERROR",
              provider_error: expect.objectContaining({
                code: "ETIMEDOUT",
              }),
            }),
          ],
        },
        diagnostics: {
          timeout_stage: "SELECTOR_EVALUATION",
          stages: expect.arrayContaining([
            expect.objectContaining({
              stage: "SELECTOR_EVALUATION",
              status: "TIMED_OUT",
            }),
          ]),
        },
      });
    });

    test("prefers the current selector timeout over a failed prior retry stage", async () => {
      const backtester = fixtureBacktester();
      backtester.createBacktest.mockRejectedValue(
        Object.assign(new Error("selector timed out"), {
          code: "ETIMEDOUT",
          retryable: true,
        }),
      );
      let attempt = 0;
      const discover = jest.fn(
        async (candidateBacktester, input, candles, execution) => {
          attempt += 1;
          if (attempt === 1) {
            execution.on_progress({
              stage: "PROVIDER_BOOTSTRAP",
              state: "STARTED",
            });
            execution.on_progress({
              stage: "PROVIDER_BOOTSTRAP",
              state: "FAILED",
            });
            throw Object.assign(new Error("bootstrap timed out"), {
              code: "PROVIDER_TIMEOUT",
              retryable: true,
            });
          }
          return discoverHistoricalSpxCandidates(
            candidateBacktester,
            input,
            candles,
            execution,
          );
        },
      );
      const result = await discoverHistoricalSpxCandidatesRange(
        backtester,
        {
          ...RANGE_REQUEST,
          end_date: "2026-08-24",
          retry_policy: {
            max_attempts: 2,
            backoff_ms: 0,
          },
        },
        undefined,
        { discover },
      );

      expect(result.checkpoints[0]).toMatchObject({
        status: "PROVIDER_TIMEOUT",
        attempt_count: 2,
        diagnostics: {
          timeout_stage: "SELECTOR_EVALUATION",
          stages: expect.arrayContaining([
            expect.objectContaining({
              stage: "PROVIDER_BOOTSTRAP",
              status: "FAILED",
            }),
            expect.objectContaining({
              stage: "SELECTOR_EVALUATION",
              status: "TIMED_OUT",
            }),
          ]),
        },
      });
    });

    test("bounds single-checkpoint provider work with the range deadline", async () => {
      const never = new Promise(() => {});
      const backtester = {
        createBacktest: jest.fn(() => never),
        getBacktest: jest.fn(() => never),
        getBacktestLogs: jest.fn(() => never),
        simulateTrade: jest.fn(() => never),
      };

      await expect(
        discoverHistoricalSpxCandidates(
          backtester,
          CHECKPOINT_REQUEST,
          undefined,
          { deadline_ms: 20 },
        ),
      ).rejects.toMatchObject({
        code: "PROVIDER_TIMEOUT",
        retryable: true,
      });
      expect(backtester.createBacktest).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          timeout_ms: expect.any(Number),
          signal: expect.any(AbortSignal),
        }),
      );
      expect(backtester.createBacktest.mock.calls[0][1].signal.aborted).toBe(
        true,
      );
    });

    test("does not start option batches after an underlying timeout", async () => {
      const candles = {
        getHistoricalCandles: jest.fn(
          (request) =>
            new Promise((resolve) => {
              setTimeout(
                () =>
                  resolve({
                    candles: [],
                    snapshot_complete: false,
                    snapshot_truncated: false,
                  }),
                40,
              );
              expect(request.deadline_ms).toBeUndefined();
            }),
        ),
        getHistoricalCandlesBatch: jest.fn(),
      };

      await expect(
        discoverHistoricalSpxCandidates(
          fixtureBacktester(entryTimeIgnoredFixture),
          PATH_B_REQUEST,
          candles,
          { deadline_ms: 10 },
        ),
      ).rejects.toMatchObject({
        code: "PROVIDER_TIMEOUT",
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(candles.getHistoricalCandlesBatch).not.toHaveBeenCalled();
      expect(
        candles.getHistoricalCandles.mock.calls[0][0].signal.aborted,
      ).toBe(true);
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
