import { readFileSync } from "node:fs";
import { describe, expect, jest, test } from "@jest/globals";
import {
  discoverHistoricalSpxCandidates,
  prepareHistoricalSpxCandidates,
} from "../dist/historical-spx-candidates.js";

const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/spx-candidate-2026-04-15.json", import.meta.url),
    "utf8",
  ),
);

const REQUEST = {
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

function fixtureBacktester(logs = fixture.logs) {
  return {
    createBacktest: jest.fn(async () => fixture.create_response),
    getBacktest: jest.fn(async () => fixture.create_response),
    getBacktestLogs: jest.fn(async () => logs),
    simulateTrade: jest.fn(async () => fixture.simulation),
  };
}

describe("historical SPX candidate discovery", () => {
  test("builds bounded provider requests from the selector grid", () => {
    const plan = prepareHistoricalSpxCandidates(REQUEST);

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
    expect(plan.request_id).toMatch(/^[a-f0-9]{64}$/);
  });

  test("uses the latest provider selection at or before the checkpoint", async () => {
    const backtester = fixtureBacktester();
    const result = await discoverHistoricalSpxCandidates(backtester, REQUEST);

    expect(result).toMatchObject({
      status: "COMPLETE",
      evidence_type: "HISTORICAL_SELECTOR_CANDIDATE_SET",
      evidence_phase: "REGRESSION_RESEARCH",
      as_of: "2026-04-15T14:30:00.000Z",
      surface: {
        atm_iv: null,
        skew: null,
        term_structure: null,
      },
      capabilities: {
        full_historical_chain: false,
        exact_provider_contract_identity: true,
        exact_leg_simulation: true,
        forward_outcomes_included: false,
      },
      references: { checkpoint_id: "spx-2026-04-15-0730-pt" },
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
        dte_at_as_of: 27,
        selection_method: "DELTA",
        selector_value: "20",
        backtester_fill_price: "42.35",
        historical_price: "42.35",
        historical_price_effect: "DEBIT",
        selected_historical_delta: "-20.17",
        underlying_price: "6969.23",
        confidence: "MEDIUM",
      }),
    ]);
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

  test("returns NOT_AVAILABLE instead of using a future trial", async () => {
    const backtester = fixtureBacktester({
      trials: [fixture.logs.trials[1]],
      snapshots: {},
    });
    const result = await discoverHistoricalSpxCandidates(backtester, REQUEST);

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
    const backtester = fixtureBacktester(logs);
    const result = await discoverHistoricalSpxCandidates(backtester, REQUEST);

    expect(result.status).toBe("NOT_AVAILABLE");
    expect(result.contracts).toEqual([]);
    expect(result.attempts[0].status).toBe("INVALID_PROVIDER_LOGS");
    expect(result.warnings).toContain(
      "PUT:DELTA:20:28:ELIGIBLE_TRIAL_DID_NOT_EXPOSE_EXACT_CONTRACT_IDENTITY",
    );
    expect(backtester.simulateTrade).not.toHaveBeenCalled();
  });

  test("enforces the requested DTE range at as_of, not selection time", async () => {
    const backtester = fixtureBacktester();
    const result = await discoverHistoricalSpxCandidates(backtester, {
      ...REQUEST,
      min_dte: 28,
      max_dte: 35,
    });

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
        ...REQUEST,
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
