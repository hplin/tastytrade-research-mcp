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

function fixtureBacktester(source = fixture, logs = source.logs) {
  return {
    createBacktest: jest.fn(async () => source.create_response),
    getBacktest: jest.fn(async () => source.create_response),
    getBacktestLogs: jest.fn(async () => logs),
    simulateTrade: jest.fn(async () => source.simulation ?? { snapshots: [] }),
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
