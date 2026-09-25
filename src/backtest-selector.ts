import type { JsonObject } from "./backtester-client.js";
import { ExactDecimal, type DecimalInput } from "./decimal.js";

export type BacktestStrikeSelector =
  | { method: "DELTA"; value: DecimalInput }
  | { method: "PERCENTAGE_OTM"; value: DecimalInput }
  | { method: "CURRENT_PRICE_OFFSET"; value: DecimalInput }
  | { method: "PREMIUM"; value: DecimalInput };

export type NormalizedBacktestSelector = {
  method: BacktestStrikeSelector["method"];
  value: string;
  provider_fields: JsonObject;
};

export function normalizeBacktestSelector(
  selector: BacktestStrikeSelector,
  field = "backtest_selector",
): NormalizedBacktestSelector {
  const valueText = ExactDecimal.parse(
    selector.value,
    `${field}.${selector.method}`,
  ).toString();
  const value = Number(valueText);
  if (!Number.isFinite(value)) {
    throw new Error(`${field}.${selector.method} is out of range.`);
  }

  switch (selector.method) {
    case "DELTA":
      if (value < 1 || value > 100) {
        throw new Error(`${field}.DELTA must be between 1 and 100.`);
      }
      return {
        method: selector.method,
        value: valueText,
        provider_fields: { strikeSelection: "delta", delta: value },
      };
    case "PERCENTAGE_OTM":
      return {
        method: selector.method,
        value: valueText,
        provider_fields: {
          strikeSelection: "percentageOTM",
          percentageOTM: value,
        },
      };
    case "CURRENT_PRICE_OFFSET":
      if (Math.abs(value) > 50_000) {
        throw new Error(
          `${field}.CURRENT_PRICE_OFFSET must be between -50000 and 50000.`,
        );
      }
      return {
        method: selector.method,
        value: valueText,
        provider_fields: {
          strikeSelection: "currentPriceOffset",
          currentPriceOffset: value,
        },
      };
    case "PREMIUM":
      if (value < 0 || value > 50_000) {
        throw new Error(`${field}.PREMIUM must be between 0 and 50000.`);
      }
      return {
        method: selector.method,
        value: valueText,
        provider_fields: { strikeSelection: "premium", premium: value },
      };
  }
}
