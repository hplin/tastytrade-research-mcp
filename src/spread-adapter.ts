import type { JsonObject } from "./backtester-client.js";
import { createHash } from "node:crypto";
import {
  normalizeBacktestSelector,
  type BacktestStrikeSelector,
} from "./backtest-selector.js";
import { ExactDecimal, type DecimalInput } from "./decimal.js";
import {
  createExecutionEvidence,
  type ExecutionEvidence,
  type ExecutionReferences,
} from "./execution-evidence.js";
import {
  type LegAction,
  type PriceEffect,
  type SpreadFamily,
} from "./package-pricing.js";
import { normalizeDate, normalizeRfc3339 } from "./time.js";

export type OptionSide = "CALL" | "PUT";

export type { BacktestStrikeSelector } from "./backtest-selector.js";

export type SpreadLeg = {
  provider_symbol: string;
  action: LegAction;
  quantity: number;
  expiration: string;
  strike: DecimalInput;
  option_side: OptionSide;
  backtest_selector?: BacktestStrikeSelector;
  days_until_expiration?: number;
};

export type SpreadBacktestWindow = {
  start_date: string;
  end_date: string;
  entry_conditions?: JsonObject;
  exit_conditions?: JsonObject;
};

export type SpreadResearchInput = {
  family: SpreadFamily;
  underlying: string;
  legs: SpreadLeg[];
  entry_at: string;
  exit_at: string;
  intended_price: DecimalInput;
  price_effect: Exclude<PriceEffect, "EVEN">;
  allow_0dte?: boolean;
  backtest?: SpreadBacktestWindow;
  references?: ExecutionReferences;
};

export type NormalizedSpreadLeg = {
  provider_symbol: string;
  action: LegAction;
  direction: "long" | "short";
  quantity: number;
  expiration: string;
  strike: string;
  option_side: OptionSide;
  backtest_selector: BacktestStrikeSelector | null;
  days_until_expiration: number | null;
};

export type SpreadResearchPlan = {
  contract_version: "1.0.0";
  request_id: string;
  family: SpreadFamily;
  underlying: "SPX";
  legs: NormalizedSpreadLeg[];
  entry_at: string;
  exit_at: string;
  intended_price: string;
  price_effect: Exclude<PriceEffect, "EVEN">;
  simulate_trade_request: JsonObject;
  backtest_request: JsonObject | null;
  capabilities: {
    exact_leg_simulation: true;
    aggregate_backtest_supported: boolean;
    preserves_exact_expiration_and_strike_in_simulation: true;
    preserves_exact_expiration_and_strike_in_aggregate: false;
  };
  warnings: string[];
  references: ExecutionReferences;
};

export type NormalizedSimulationSnapshot = {
  as_of: string;
  price: string;
  price_effect: Exclude<PriceEffect, "EVEN">;
  underlying_price: string | null;
  delta: string | null;
};

export type SpreadSimulationResult = {
  contract_version: "1.0.0";
  request_id: string;
  family: SpreadFamily;
  underlying: "SPX";
  entry_at: string;
  exit_at: string;
  intended_price: string;
  price_effect: Exclude<PriceEffect, "EVEN">;
  legs: NormalizedSpreadLeg[];
  simulate_trade_request: JsonObject;
  snapshots: NormalizedSimulationSnapshot[];
  warnings: string[];
  evidence: ExecutionEvidence;
  upstream: unknown;
};

export type SpreadBacktestResult = {
  contract_version: "1.0.0";
  request_id: string;
  family: SpreadFamily;
  underlying: "SPX";
  upstream_id: string | null;
  status: string;
  legs: NormalizedSpreadLeg[];
  backtest_request: JsonObject;
  warnings: string[];
  evidence: ExecutionEvidence;
  upstream: unknown;
};

export type SpreadBacktester = {
  createBacktest(request: JsonObject): Promise<unknown>;
  simulateTrade(request: JsonObject): Promise<unknown>;
};

function normalizeTimestamp(value: string, field: string): string {
  return normalizeRfc3339(value, field);
}

function dateOnly(value: string, field: string): string {
  return normalizeDate(value, field);
}

function directionForAction(action: LegAction): "long" | "short" {
  switch (action) {
    case "BUY_TO_OPEN":
    case "BUY_TO_CLOSE":
      return "long";
    case "SELL_TO_OPEN":
    case "SELL_TO_CLOSE":
      return "short";
    default:
      throw new Error(`Unsupported leg action: ${String(action)}.`);
  }
}

function calendarDaysBetween(start: string, end: string): number {
  const startDate = Date.parse(`${start.slice(0, 10)}T00:00:00.000Z`);
  const endDate = Date.parse(`${end.slice(0, 10)}T00:00:00.000Z`);
  return Math.floor((endDate - startDate) / 86_400_000);
}

function validateStructure(
  family: SpreadFamily,
  legs: NormalizedSpreadLeg[],
): void {
  const expectedCount =
    family === "DEBIT_VERTICAL" || family === "CREDIT_VERTICAL"
      ? 2
      : family === "IRON_CONDOR" || family === "DOUBLE_DIAGONAL"
        ? 4
        : (() => {
            throw new Error(`Unsupported spread family: ${String(family)}.`);
          })();
  if (legs.length !== expectedCount) {
    throw new Error(`${family} requires exactly ${expectedCount} legs.`);
  }

  const expirations = new Map<string, number>();
  for (const leg of legs) {
    expirations.set(
      leg.expiration,
      (expirations.get(leg.expiration) ?? 0) + 1,
    );
  }

  if (family === "DEBIT_VERTICAL" || family === "CREDIT_VERTICAL") {
    if (new Set(legs.map((leg) => leg.option_side)).size !== 1) {
      throw new Error(`${family} legs must use the same option side.`);
    }
    if (expirations.size !== 1) {
      throw new Error(`${family} legs must use the same expiration.`);
    }
    if (
      legs.filter((leg) => leg.direction === "long").length !== 1 ||
      legs[0].quantity !== legs[1].quantity
    ) {
      throw new Error(
        `${family} requires one long and one short leg with equal quantities.`,
      );
    }
  }

  if (family === "IRON_CONDOR") {
    if (expirations.size !== 1) {
      throw new Error("IRON_CONDOR legs must use the same expiration.");
    }
    for (const side of ["CALL", "PUT"] as const) {
      const sideLegs = legs.filter((leg) => leg.option_side === side);
      if (
        sideLegs.length !== 2 ||
        sideLegs.filter((leg) => leg.direction === "long").length !== 1 ||
        sideLegs[0].quantity !== sideLegs[1].quantity
      ) {
        throw new Error(
          `IRON_CONDOR requires one long and one short ${side} leg.`,
        );
      }
    }
  }

  if (family === "DOUBLE_DIAGONAL") {
    if (
      expirations.size !== 2 ||
      [...expirations.values()].some((count) => count !== 2)
    ) {
      throw new Error(
        "DOUBLE_DIAGONAL requires two legs in each of two expirations.",
      );
    }
    for (const side of ["CALL", "PUT"] as const) {
      const sideLegs = legs.filter((leg) => leg.option_side === side);
      if (
        sideLegs.length !== 2 ||
        sideLegs.filter((leg) => leg.direction === "long").length !== 1 ||
        sideLegs[0].quantity !== sideLegs[1].quantity
      ) {
        throw new Error(
          `DOUBLE_DIAGONAL requires one long and one short ${side} leg.`,
        );
      }
    }
  }
}

function stableRequestId(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

function normalizeObject(value: JsonObject | undefined): JsonObject | undefined {
  if (value === undefined) return undefined;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [
        key,
        item &&
        typeof item === "object" &&
        !Array.isArray(item)
          ? normalizeObject(item as JsonObject)
          : item,
      ]),
  );
}

export function prepareSpreadResearch(
  input: SpreadResearchInput,
): SpreadResearchPlan {
  const underlying = input.underlying.trim().toUpperCase();
  if (underlying !== "SPX") {
    throw new Error("The defined-risk spread adapter currently supports SPX.");
  }

  const entryAt = normalizeTimestamp(input.entry_at, "entry_at");
  const exitAt = normalizeTimestamp(input.exit_at, "exit_at");
  if (Date.parse(exitAt) <= Date.parse(entryAt)) {
    throw new Error("exit_at must be later than entry_at.");
  }

  const symbols = new Set<string>();
  const legs: NormalizedSpreadLeg[] = input.legs.map((leg, index) => {
    const providerSymbol = leg.provider_symbol.trim();
    if (!providerSymbol) {
      throw new Error(`legs[${index}].provider_symbol must be non-empty.`);
    }
    if (symbols.has(providerSymbol)) {
      throw new Error(`Duplicate provider symbol: ${providerSymbol}.`);
    }
    symbols.add(providerSymbol);
    if (!Number.isSafeInteger(leg.quantity) || leg.quantity <= 0) {
      throw new Error(
        `Quantity for ${providerSymbol} must be a positive integer.`,
      );
    }
    if (
      leg.days_until_expiration !== undefined &&
      (!Number.isSafeInteger(leg.days_until_expiration) ||
        leg.days_until_expiration < 0)
    ) {
      throw new Error(
        `days_until_expiration for ${providerSymbol} must be a non-negative integer.`,
      );
    }
    if (leg.option_side !== "CALL" && leg.option_side !== "PUT") {
      throw new Error(
        `option_side for ${providerSymbol} must be CALL or PUT.`,
      );
    }

    return {
      provider_symbol: providerSymbol,
      action: leg.action,
      direction: directionForAction(leg.action),
      quantity: leg.quantity,
      expiration: normalizeTimestamp(leg.expiration, `${providerSymbol}.expiration`),
      strike: ExactDecimal.parse(
        leg.strike,
        `${providerSymbol}.strike`,
      ).toString(),
      option_side: leg.option_side,
      backtest_selector: leg.backtest_selector ?? null,
      days_until_expiration: leg.days_until_expiration ?? null,
    };
  });

  validateStructure(input.family, legs);

  if (!input.allow_0dte) {
    const zeroDteLeg = legs.find(
      (leg) => calendarDaysBetween(entryAt, leg.expiration) <= 0,
    );
    if (zeroDteLeg) {
      throw new Error(
        `0DTE is excluded by default; ${zeroDteLeg.provider_symbol} expires on the entry date.`,
      );
    }
    const aggregateZeroDteLeg = legs.find(
      (leg) => leg.days_until_expiration === 0,
    );
    if (aggregateZeroDteLeg) {
      throw new Error(
        `0DTE is excluded by default; ${aggregateZeroDteLeg.provider_symbol} uses days_until_expiration=0.`,
      );
    }
  }

  const warnings: string[] = [];
  if (input.price_effect !== "DEBIT" && input.price_effect !== "CREDIT") {
    throw new Error("price_effect must be DEBIT or CREDIT.");
  }
  const intendedPrice = ExactDecimal.parse(
    input.intended_price,
    "intended_price",
  );
  if (intendedPrice.compare(ExactDecimal.zero()) < 0) {
    throw new Error("intended_price must be non-negative.");
  }

  const simulateTradeRequest: JsonObject = {
    underlying,
    startTime: entryAt,
    endTime: exitAt,
    legs: legs.map((leg) => ({
      symbol: leg.provider_symbol,
      direction: leg.direction,
      quantity: leg.quantity,
    })),
  };

  let backtestRequest: JsonObject | null = null;
  const aggregateInputsComplete =
    input.backtest !== undefined &&
    legs.every(
      (leg) =>
        leg.backtest_selector !== null &&
        leg.days_until_expiration !== null,
    );
  if (input.family === "DOUBLE_DIAGONAL") {
    warnings.push(
      "DOUBLE_DIAGONAL_AGGREGATE_BACKTEST_UNSUPPORTED_USE_EXACT_SIMULATION",
    );
  } else if (!aggregateInputsComplete) {
    warnings.push(
      "AGGREGATE_BACKTEST_REQUIRES_WINDOW_AND_RELATIVE_LEG_SELECTORS",
    );
  } else {
    const backtest = input.backtest!;
    backtestRequest = {
      symbol: underlying,
      startDate: dateOnly(backtest.start_date, "backtest.start_date"),
      endDate: dateOnly(backtest.end_date, "backtest.end_date"),
      legs: legs.map((leg) => ({
        type: "equity-option",
        direction: leg.direction,
        side: leg.option_side.toLowerCase(),
        quantity: leg.quantity,
        ...normalizeBacktestSelector(
          leg.backtest_selector!,
        ).provider_fields,
        daysUntilExpiration: leg.days_until_expiration,
      })),
      ...(backtest.entry_conditions
        ? { entryConditions: normalizeObject(backtest.entry_conditions) }
        : {}),
      ...(backtest.exit_conditions
        ? { exitConditions: normalizeObject(backtest.exit_conditions) }
        : {}),
    };
  }

  const requestId = stableRequestId({
    family: input.family,
    underlying,
    legs,
    entry_at: entryAt,
    exit_at: exitAt,
    intended_price: intendedPrice.toString(),
    price_effect: input.price_effect,
    simulate_trade_request: simulateTradeRequest,
    backtest_request: backtestRequest,
  });

  return {
    contract_version: "1.0.0",
    request_id: requestId,
    family: input.family,
    underlying: "SPX",
    legs,
    entry_at: entryAt,
    exit_at: exitAt,
    intended_price: intendedPrice.toString(),
    price_effect: input.price_effect,
    simulate_trade_request: simulateTradeRequest,
    backtest_request: backtestRequest,
    capabilities: {
      exact_leg_simulation: true,
      aggregate_backtest_supported: backtestRequest !== null,
      preserves_exact_expiration_and_strike_in_simulation: true,
      preserves_exact_expiration_and_strike_in_aggregate: false,
    },
    warnings,
    references: input.references ?? {},
  };
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeOptionalDecimal(
  value: unknown,
  field: string,
): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  return ExactDecimal.parse(value, field).toString();
}

export function normalizeSimulationResponse(
  plan: SpreadResearchPlan,
  raw: unknown,
): SpreadSimulationResult {
  const response = objectValue(raw);
  const snapshotsValue = Array.isArray(raw) ? raw : response?.snapshots;
  if (!Array.isArray(snapshotsValue)) {
    throw new Error("Backtester simulation response did not contain snapshots.");
  }

  const warnings = [...plan.warnings];
  const snapshots: NormalizedSimulationSnapshot[] = [];
  for (const [index, value] of snapshotsValue.entries()) {
    const snapshot = objectValue(value);
    if (!snapshot) {
      warnings.push(`INVALID_SIMULATION_SNAPSHOT:${index}`);
      continue;
    }
    const asOfValue = snapshot.dateTime ?? snapshot.time;
    const priceValue = snapshot.price;
    const effectValue = snapshot.effect ?? snapshot.priceEffect;
    if (
      typeof asOfValue !== "string" ||
      (typeof priceValue !== "string" && typeof priceValue !== "number") ||
      (effectValue !== "debit" && effectValue !== "credit")
    ) {
      warnings.push(`INVALID_SIMULATION_SNAPSHOT:${index}`);
      continue;
    }
    snapshots.push({
      as_of: normalizeTimestamp(asOfValue, `snapshots[${index}].dateTime`),
      price: ExactDecimal.parse(
        priceValue,
        `snapshots[${index}].price`,
      ).toString(),
      price_effect: effectValue === "debit" ? "DEBIT" : "CREDIT",
      underlying_price: normalizeOptionalDecimal(
        snapshot.underlyingPrice,
        `snapshots[${index}].underlyingPrice`,
      ),
      delta: normalizeOptionalDecimal(
        snapshot.delta,
        `snapshots[${index}].delta`,
      ),
    });
  }
  snapshots.sort((left, right) => left.as_of.localeCompare(right.as_of));
  if (snapshots.length === 0) warnings.push("SIMULATION_RETURNED_NO_USABLE_SNAPSHOTS");

  const evidence = createExecutionEvidence({
    evidence_type: "BACKTESTER_SIMULATION",
    evidence_phase: "POST_SESSION_REGRESSION",
    source: "tastytrade-backtester:/simulate-trade",
    as_of: snapshots.at(-1)?.as_of ?? null,
    oldest_leg_as_of: null,
    freshness_status: "UNKNOWN",
    temporal_alignment: "UNKNOWN",
    native_available: false,
    working_limit: plan.intended_price,
    acceptable_bound: null,
    fill_model: "NOT_APPLICABLE",
    fill_confidence: "NOT_APPLICABLE",
    references: plan.references,
    warnings,
  });

  return {
    contract_version: "1.0.0",
    request_id: plan.request_id,
    family: plan.family,
    underlying: plan.underlying,
    entry_at: plan.entry_at,
    exit_at: plan.exit_at,
    intended_price: plan.intended_price,
    price_effect: plan.price_effect,
    legs: plan.legs,
    simulate_trade_request: plan.simulate_trade_request,
    snapshots,
    warnings: evidence.warnings,
    evidence,
    upstream: raw,
  };
}

export function normalizeBacktestResponse(
  plan: SpreadResearchPlan,
  raw: unknown,
): SpreadBacktestResult {
  const response = objectValue(raw);
  if (!response) throw new Error("Backtester response must be an object.");
  const upstreamId =
    typeof response.id === "string" && response.id ? response.id : null;
  const status =
    typeof response.status === "string" && response.status
      ? response.status
      : "unknown";
  const warnings = [...plan.warnings];
  if (!upstreamId) warnings.push("BACKTESTER_RESPONSE_MISSING_ID");

  const evidence = createExecutionEvidence({
    evidence_type: "BACKTESTER_SIMULATION",
    evidence_phase: "POST_SESSION_REGRESSION",
    source: "tastytrade-backtester:/backtests",
    as_of:
      typeof response.createdAt === "string"
        ? normalizeTimestamp(response.createdAt, "createdAt")
        : null,
    oldest_leg_as_of: null,
    freshness_status: "UNKNOWN",
    temporal_alignment: "UNKNOWN",
    native_available: false,
    working_limit: plan.intended_price,
    acceptable_bound: null,
    fill_model: "NOT_APPLICABLE",
    fill_confidence: "NOT_APPLICABLE",
    references: plan.references,
    warnings,
  });

  return {
    contract_version: "1.0.0",
    request_id: plan.request_id,
    family: plan.family,
    underlying: plan.underlying,
    upstream_id: upstreamId,
    status,
    legs: plan.legs,
    backtest_request: plan.backtest_request!,
    warnings: evidence.warnings,
    evidence,
    upstream: raw,
  };
}

export async function runSpreadSimulation(
  backtester: SpreadBacktester,
  input: SpreadResearchInput,
): Promise<SpreadSimulationResult> {
  const plan = prepareSpreadResearch(input);
  const raw = await backtester.simulateTrade(plan.simulate_trade_request);
  return normalizeSimulationResponse(plan, raw);
}

export async function createSpreadBacktest(
  backtester: SpreadBacktester,
  input: SpreadResearchInput,
): Promise<SpreadBacktestResult> {
  const plan = prepareSpreadResearch(input);
  if (!plan.backtest_request) {
    throw new Error(
      plan.warnings.find((warning) => warning.includes("BACKTEST")) ??
        "Aggregate Backtester request is unavailable for this spread.",
    );
  }
  const raw = await backtester.createBacktest(plan.backtest_request);
  return normalizeBacktestResponse(plan, raw);
}
