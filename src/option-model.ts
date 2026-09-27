export type OptionModelSide = "CALL" | "PUT";

export type BlackScholesSpotInput = {
  spot: number;
  strike: number;
  years_to_expiration: number;
  annualized_volatility: number;
  annualized_risk_free_rate: number;
  annualized_dividend_yield: number;
  option_side: OptionModelSide;
};

function finite(value: number, field: string): number {
  if (!Number.isFinite(value)) {
    throw new Error(`${field} must be finite.`);
  }
  return value;
}

export function normalCdf(value: number): number {
  const absolute = Math.abs(value);
  const t = 1 / (1 + 0.2316419 * absolute);
  const density =
    0.3989422804014327 * Math.exp((-absolute * absolute) / 2);
  const tail =
    density *
    t *
    (0.31938153 +
      t *
        (-0.356563782 +
          t *
            (1.781477937 +
              t * (-1.821255978 + t * 1.330274429))));
  const positive = 1 - tail;
  return value >= 0 ? positive : 1 - positive;
}

export function blackScholesSpotPrice(
  input: BlackScholesSpotInput,
): number {
  const spot = finite(input.spot, "spot");
  const strike = finite(input.strike, "strike");
  const years = finite(
    input.years_to_expiration,
    "years_to_expiration",
  );
  const volatility = finite(
    input.annualized_volatility,
    "annualized_volatility",
  );
  const rate = finite(
    input.annualized_risk_free_rate,
    "annualized_risk_free_rate",
  );
  const dividend = finite(
    input.annualized_dividend_yield,
    "annualized_dividend_yield",
  );
  if (spot <= 0) throw new Error("spot must be positive.");
  if (strike <= 0) throw new Error("strike must be positive.");
  if (years < 0) {
    throw new Error("years_to_expiration must be non-negative.");
  }
  if (volatility < 0) {
    throw new Error("annualized_volatility must be non-negative.");
  }
  if (input.option_side !== "CALL" && input.option_side !== "PUT") {
    throw new Error(`Unsupported option_side: ${String(input.option_side)}.`);
  }

  if (years === 0) {
    return input.option_side === "CALL"
      ? Math.max(spot - strike, 0)
      : Math.max(strike - spot, 0);
  }

  const discountedSpot = spot * Math.exp(-dividend * years);
  const discountedStrike = strike * Math.exp(-rate * years);
  if (volatility === 0) {
    return input.option_side === "CALL"
      ? Math.max(discountedSpot - discountedStrike, 0)
      : Math.max(discountedStrike - discountedSpot, 0);
  }

  const volatilityTime = volatility * Math.sqrt(years);
  const d1 =
    (Math.log(spot / strike) +
      (rate - dividend + 0.5 * volatility * volatility) * years) /
    volatilityTime;
  const d2 = d1 - volatilityTime;
  const value =
    input.option_side === "CALL"
      ? discountedSpot * normalCdf(d1) -
        discountedStrike * normalCdf(d2)
      : discountedStrike * normalCdf(-d2) -
        discountedSpot * normalCdf(-d1);
  return Math.max(value, 0);
}
