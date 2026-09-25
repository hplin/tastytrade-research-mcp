import { describe, expect, test } from "@jest/globals";
import {
  normalizeSimulationResponse,
  prepareSpreadResearch,
} from "../dist/spread-adapter.js";

function leg(
  providerSymbol,
  action,
  optionSide,
  strike,
  expiration = "2026-10-16T20:00:00.000Z",
) {
  return {
    provider_symbol: providerSymbol,
    action,
    quantity: 1,
    expiration,
    strike,
    option_side: optionSide,
    backtest_selector: {
      method: "DELTA",
      value: optionSide === "PUT" ? "20" : "15",
    },
    days_until_expiration: 30,
  };
}

const BASE = {
  underlying: "SPX",
  entry_at: "2026-09-24T14:30:00.000Z",
  exit_at: "2026-09-25T19:45:00.000Z",
  intended_price: "2.5",
  price_effect: "DEBIT",
  references: { checkpoint_id: "checkpoint-1" },
};

describe("SPX spread adapter", () => {
  test("normalizes a vertical into exact simulation and aggregate requests", () => {
    const plan = prepareSpreadResearch({
      ...BASE,
      family: "DEBIT_VERTICAL",
      legs: [
        leg("SPX   261016C07500000", "BUY_TO_OPEN", "CALL", "7500"),
        leg("SPX   261016C07550000", "SELL_TO_OPEN", "CALL", "7550"),
      ],
      backtest: {
        start_date: "2024-01-01",
        end_date: "2024-03-31",
        entry_conditions: { frequency: "every day" },
        exit_conditions: { afterDaysInTrade: 1 },
      },
    });

    expect(plan.simulate_trade_request.legs).toEqual([
      {
        symbol: "SPX   261016C07500000",
        direction: "long",
        quantity: 1,
      },
      {
        symbol: "SPX   261016C07550000",
        direction: "short",
        quantity: 1,
      },
    ]);
    expect(plan.backtest_request).toMatchObject({
      symbol: "SPX",
      startDate: "2024-01-01",
      endDate: "2024-03-31",
    });
    expect(plan.backtest_request.legs[0].delta).toBe(15);
    expect(typeof plan.backtest_request.legs[0].delta).toBe("number");
    expect(plan.capabilities.aggregate_backtest_supported).toBe(true);
    expect(plan.request_id).toMatch(/^[a-f0-9]{64}$/);
    expect(
      prepareSpreadResearch({
        ...BASE,
        family: "DEBIT_VERTICAL",
        legs: [
          leg("SPX   261016C07500000", "BUY_TO_OPEN", "CALL", "7500"),
          leg("SPX   261016C07550000", "SELL_TO_OPEN", "CALL", "7550"),
        ],
        backtest: {
          start_date: "2024-01-01",
          end_date: "2024-03-31",
          entry_conditions: { frequency: "every day" },
          exit_conditions: { afterDaysInTrade: 1 },
        },
      }).request_id,
    ).toBe(plan.request_id);
  });

  test("normalizes an iron condor", () => {
    const plan = prepareSpreadResearch({
      ...BASE,
      family: "IRON_CONDOR",
      price_effect: "CREDIT",
      legs: [
        leg("P-LONG", "BUY_TO_OPEN", "PUT", "7000"),
        leg("P-SHORT", "SELL_TO_OPEN", "PUT", "7050"),
        leg("C-SHORT", "SELL_TO_OPEN", "CALL", "7800"),
        leg("C-LONG", "BUY_TO_OPEN", "CALL", "7850"),
      ],
      backtest: {
        start_date: "2024-01-01",
        end_date: "2024-03-31",
      },
    });

    expect(plan.legs).toHaveLength(4);
    expect(plan.backtest_request.legs).toHaveLength(4);
  });

  test("keeps double diagonals exact-simulation only", () => {
    const near = "2026-10-02T20:00:00.000Z";
    const far = "2026-10-30T20:00:00.000Z";
    const plan = prepareSpreadResearch({
      ...BASE,
      family: "DOUBLE_DIAGONAL",
      legs: [
        leg("P-NEAR", "SELL_TO_OPEN", "PUT", "7000", near),
        leg("C-NEAR", "SELL_TO_OPEN", "CALL", "7800", near),
        leg("P-FAR", "BUY_TO_OPEN", "PUT", "6950", far),
        leg("C-FAR", "BUY_TO_OPEN", "CALL", "7850", far),
      ],
      backtest: {
        start_date: "2024-01-01",
        end_date: "2024-03-31",
      },
    });

    expect(plan.backtest_request).toBeNull();
    expect(plan.simulate_trade_request.legs).toHaveLength(4);
    expect(plan.warnings).toContain(
      "DOUBLE_DIAGONAL_AGGREGATE_BACKTEST_UNSUPPORTED_USE_EXACT_SIMULATION",
    );
  });

  test("excludes 0DTE unless explicitly enabled", () => {
    expect(() =>
      prepareSpreadResearch({
        ...BASE,
        family: "DEBIT_VERTICAL",
        legs: [
          leg(
            "C-LONG",
            "BUY_TO_OPEN",
            "CALL",
            "7500",
            "2026-09-24T20:00:00.000Z",
          ),
          leg(
            "C-SHORT",
            "SELL_TO_OPEN",
            "CALL",
            "7550",
            "2026-09-24T20:00:00.000Z",
          ),
        ],
      }),
    ).toThrow("0DTE is excluded by default");
  });

  test("rejects aggregate zero-DTE selectors by default", () => {
    expect(() =>
      prepareSpreadResearch({
        ...BASE,
        family: "DEBIT_VERTICAL",
        legs: [
          {
            ...leg("C-LONG", "BUY_TO_OPEN", "CALL", "7500"),
            days_until_expiration: 0,
          },
          {
            ...leg("C-SHORT", "SELL_TO_OPEN", "CALL", "7550"),
            days_until_expiration: 0,
          },
        ],
        backtest: {
          start_date: "2024-01-01",
          end_date: "2024-03-31",
        },
      }),
    ).toThrow("days_until_expiration=0");
  });

  test("rejects two same-direction legs masquerading as a vertical", () => {
    expect(() =>
      prepareSpreadResearch({
        ...BASE,
        family: "DEBIT_VERTICAL",
        legs: [
          leg("C-LONG-1", "BUY_TO_OPEN", "CALL", "7500"),
          leg("C-LONG-2", "BUY_TO_OPEN", "CALL", "7550"),
        ],
      }),
    ).toThrow("one long and one short leg");
  });

  test("rejects timezone-less timestamps", () => {
    expect(() =>
      prepareSpreadResearch({
        ...BASE,
        entry_at: "2026-09-24T14:30:00",
        family: "DEBIT_VERTICAL",
        legs: [
          leg("C-LONG", "BUY_TO_OPEN", "CALL", "7500"),
          leg("C-SHORT", "SELL_TO_OPEN", "CALL", "7550"),
        ],
      }),
    ).toThrow("with Z or an explicit UTC offset");
  });

  test("normalizes raw simulation quirks behind a stable schema", () => {
    const plan = prepareSpreadResearch({
      ...BASE,
      family: "CREDIT_VERTICAL",
      price_effect: "CREDIT",
      legs: [
        leg("P-SHORT", "SELL_TO_OPEN", "PUT", "7050"),
        leg("P-LONG", "BUY_TO_OPEN", "PUT", "7000"),
      ],
    });
    const result = normalizeSimulationResponse(plan, [
      {
        dateTime: "2026-09-24T15:00:00Z",
        price: "1.2",
        effect: "credit",
        underlyingPrice: "7600.25",
        delta: "4.5",
      },
      { malformed: true },
    ]);

    expect(result.snapshots).toEqual([
      {
        as_of: "2026-09-24T15:00:00.000Z",
        price: "1.2",
        price_effect: "CREDIT",
        underlying_price: "7600.25",
        delta: "4.5",
      },
    ]);
    expect(result.warnings).toContain("INVALID_SIMULATION_SNAPSHOT:1");
    expect(result.legs).toEqual(plan.legs);
    expect(result.simulate_trade_request).toEqual(
      plan.simulate_trade_request,
    );
    expect(result.request_id).toBe(plan.request_id);
  });
});
