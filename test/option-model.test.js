import { describe, expect, test } from "@jest/globals";
import {
  blackScholesSpotGamma,
  blackScholesSpotPrice,
} from "../dist/option-model.js";

describe("Black-Scholes spot valuation", () => {
  test("prices calls and puts with the shared normal distribution", () => {
    const common = {
      spot: 100,
      strike: 100,
      years_to_expiration: 1,
      annualized_volatility: 0.2,
      annualized_risk_free_rate: 0.05,
      annualized_dividend_yield: 0,
    };
    const call = blackScholesSpotPrice({
      ...common,
      option_side: "CALL",
    });
    const put = blackScholesSpotPrice({
      ...common,
      option_side: "PUT",
    });

    expect(call).toBeCloseTo(10.4506, 4);
    expect(put).toBeCloseTo(5.5735, 4);
    expect(call - put).toBeCloseTo(
      100 - 100 * Math.exp(-0.05),
      10,
    );
  });

  test("handles explicit zero-time and zero-volatility boundaries", () => {
    expect(
      blackScholesSpotPrice({
        spot: 105,
        strike: 100,
        years_to_expiration: 0,
        annualized_volatility: 0.2,
        annualized_risk_free_rate: 0.05,
        annualized_dividend_yield: 0,
        option_side: "CALL",
      }),
    ).toBe(5);
    expect(
      blackScholesSpotPrice({
        spot: 100,
        strike: 100,
        years_to_expiration: 1,
        annualized_volatility: 0,
        annualized_risk_free_rate: 0.05,
        annualized_dividend_yield: 0,
        option_side: "CALL",
      }),
    ).toBeCloseTo(100 - 100 * Math.exp(-0.05), 10);
  });

  test("calculates the shared Black-Scholes gamma deterministically", () => {
    expect(
      blackScholesSpotGamma({
        spot: 100,
        strike: 100,
        years_to_expiration: 1,
        annualized_volatility: 0.2,
        annualized_risk_free_rate: 0.05,
        annualized_dividend_yield: 0,
      }),
    ).toBeCloseTo(0.0187620173458469, 14);
  });

  test("rejects invalid domains", () => {
    expect(() =>
      blackScholesSpotPrice({
        spot: 0,
        strike: 100,
        years_to_expiration: 1,
        annualized_volatility: 0.2,
        annualized_risk_free_rate: 0.05,
        annualized_dividend_yield: 0,
        option_side: "CALL",
      }),
    ).toThrow("spot must be positive");
    expect(() =>
      blackScholesSpotPrice({
        spot: 100,
        strike: 100,
        years_to_expiration: -1,
        annualized_volatility: 0.2,
        annualized_risk_free_rate: 0.05,
        annualized_dividend_yield: 0,
        option_side: "PUT",
      }),
    ).toThrow("years_to_expiration must be non-negative");
    expect(() =>
      blackScholesSpotGamma({
        spot: 100,
        strike: 100,
        years_to_expiration: 0,
        annualized_volatility: 0.2,
        annualized_risk_free_rate: 0.05,
        annualized_dividend_yield: 0,
      }),
    ).toThrow("years_to_expiration must be positive for gamma");
  });
});
