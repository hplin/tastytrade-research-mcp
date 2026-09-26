import { ExactDecimal } from "./decimal.js";
import {
  createExecutionEvidence,
  type ExecutionEvidence,
  type ExecutionReferences,
  type FreshnessStatus,
  type TemporalAlignment,
} from "./execution-evidence.js";
import type {
  HistoricalCandle,
  HistoricalCandlesBatchInput,
  HistoricalCandlesResult,
} from "./historical-candles.js";
import type {
  LegAction,
  PriceEffect,
  SpreadFamily,
} from "./package-pricing.js";
import { normalizeRfc3339 } from "./time.js";

export type HistoricalOptionPackageLegInput = {
  provider_symbol: string;
  action: LegAction;
  quantity?: number;
};

export type HistoricalOptionPackageCheckpointInput = {
  family: SpreadFamily;
  underlying: "SPX";
  as_of: string;
  legs: HistoricalOptionPackageLegInput[];
  max_observation_age_minutes?: number;
  max_temporal_skew_minutes?: number;
  phase: "REGRESSION_RESEARCH";
  references?: ExecutionReferences;
};

export type HistoricalOptionPackagePathInput = {
  family: SpreadFamily;
  underlying: "SPX";
  start_time: string;
  end_time: string;
  resolution: HistoricalPackageResolution;
  legs: HistoricalOptionPackageLegInput[];
  phase: "REGRESSION_RESEARCH";
  references?: ExecutionReferences;
};

export type HistoricalPackageResolution =
  | "1m"
  | "5m"
  | "15m"
  | "30m"
  | "1h";

export type HistoricalPackageReferenceValue = {
  value: string;
  price_effect: PriceEffect;
  evidence_type: "HISTORICAL_OPTION_PACKAGE_REFERENCE";
  guaranteed_executable: false;
};

export type HistoricalOptionPackageLegObservation = {
  provider_symbol: string;
  streamer_symbol: string;
  action: LegAction;
  quantity: number;
  option_side: "CALL" | "PUT";
  strike: string;
  expiration: string;
  reference_value: string | null;
  bid: null;
  ask: null;
  implied_volatility: string | null;
  delta: null;
  source_timestamp: string | null;
  available_at: string | null;
  observation_age_minutes: number | null;
  freshness_status: FreshnessStatus | "MISSING";
  provenance: HistoricalLegProvenance;
  warnings: string[];
};

export type HistoricalPackageResolutionAttempt = {
  resolution: HistoricalPackageResolution;
  status: "SELECTED" | "UNAVAILABLE";
  reason:
    | "LOCAL_CANDLE_BUDGET_EXCEEDED"
    | "DXLINK_SNAPSHOT_INCOMPLETE"
    | "DXLINK_SNAPSHOT_TRUNCATED"
    | null;
};

export type HistoricalOptionPackageCheckpointResult = {
  contract_version: "1.0.0";
  status: "AVAILABLE" | "NOT_AVAILABLE";
  evidence_type: "HISTORICAL_OPTION_PACKAGE_REFERENCE";
  evidence_phase: "REGRESSION_RESEARCH";
  family: SpreadFamily;
  underlying: "SPX";
  as_of: string;
  requested_resolution: "5m";
  effective_resolution: HistoricalPackageResolution | null;
  resolution_attempts: HistoricalPackageResolutionAttempt[];
  reference_value: HistoricalPackageReferenceValue | null;
  synthetic_mid: null;
  synthetic_natural: null;
  price_effect: PriceEffect | null;
  oldest_leg_source_timestamp: string | null;
  newest_leg_source_timestamp: string | null;
  oldest_leg_available_at: string | null;
  newest_leg_available_at: string | null;
  temporal_skew_minutes: number | null;
  freshness_status: FreshnessStatus;
  temporal_alignment: TemporalAlignment;
  valuation_quality: "COMPLETE" | "NOT_AVAILABLE";
  execution_quality: "VALUATION_ONLY" | "NOT_AVAILABLE";
  usable_for_execution: false;
  legs: HistoricalOptionPackageLegObservation[];
  source: string;
  warnings: string[];
  evidence: ExecutionEvidence;
};

export type HistoricalOptionPackagePathPoint = {
  as_of: string;
  source_timestamp: string;
  reference_value: string;
  price_effect: PriceEffect;
  temporal_skew_minutes: 0;
  temporal_alignment: "ALIGNED";
  valuation_quality: "COMPLETE";
  synthetic_mid: null;
  synthetic_natural: null;
  execution_quality: "VALUATION_ONLY";
  usable_for_execution: false;
  legs: HistoricalOptionPackageLegObservation[];
  source: string;
};

export type HistoricalOptionPackagePathGap = {
  source_timestamp: string;
  available_at: string;
  missing_provider_symbols: string[];
  reasons: string[];
};

export type HistoricalOptionPackagePathResult = {
  contract_version: "1.0.0";
  status: "AVAILABLE" | "PARTIAL" | "NOT_AVAILABLE";
  evidence_type: "HISTORICAL_PATH";
  evidence_phase: "REGRESSION_RESEARCH";
  family: SpreadFamily;
  underlying: "SPX";
  start_time: string;
  end_time: string;
  requested_resolution: HistoricalPackageResolution;
  effective_resolution: HistoricalPackageResolution | null;
  resolution_attempts: HistoricalPackageResolutionAttempt[];
  expected_point_count: number;
  observed_point_count: number;
  path_quality: "COMPLETE" | "PARTIAL" | "INVALID";
  path: HistoricalOptionPackagePathPoint[];
  gaps: HistoricalOptionPackagePathGap[];
  fill_verification_path: Array<{
    as_of: string;
    price: string;
    price_effect: Exclude<PriceEffect, "EVEN">;
    source: string;
  }>;
  fill_verification_compatible: true;
  supported_fill_models: ["LIMIT_TOUCH"];
  source: string;
  leg_sources: HistoricalLegProvenance[];
  warnings: string[];
  evidence: ExecutionEvidence;
};

export type HistoricalOptionPackageCandlesService = {
  getHistoricalCandlesBatch(
    request: HistoricalCandlesBatchInput,
  ): Promise<HistoricalCandlesResult[]>;
};

type ParsedLeg = HistoricalOptionPackageLegInput & {
  quantity: number;
  streamer_symbol: string;
  option_side: "CALL" | "PUT";
  strike: string;
  expiration: string;
};

type HistoricalLegProvenance = {
  provider_symbol: string;
  streamer_symbol: string;
  source: "tastytrade-dxlink";
  interval: HistoricalPackageResolution;
  reference_field: "close";
  source_timestamp_semantics: "BAR_START";
  availability_rule: "source_timestamp + interval <= evaluation_time";
  snapshot_complete: boolean;
  snapshot_truncated: boolean;
  provider_warnings: string[];
};

type SelectedCandleBatch = {
  resolution: HistoricalPackageResolution | null;
  results: HistoricalCandlesResult[];
  attempts: HistoricalPackageResolutionAttempt[];
};

const CHECKPOINT_RESOLUTIONS: HistoricalPackageResolution[] = [
  "5m",
  "15m",
  "30m",
  "1h",
];
const PATH_RESOLUTIONS: HistoricalPackageResolution[] = [
  "1m",
  "5m",
  "15m",
  "30m",
  "1h",
];
const DEFAULT_MAX_OBSERVATION_AGE_MINUTES = 30;
const DEFAULT_MAX_TEMPORAL_SKEW_MINUTES = 10;
const MAX_RESEARCH_WINDOW_MS = 24 * 60 * 60_000;
const CANDLE_MAX_OUTPUT = 20_000;
const CANDLE_MAX_RECEIVED_EVENTS = 20_000;
const CANDLE_MAX_BUFFER_BYTES = 32 * 1024 * 1024;

function resolutionMilliseconds(resolution: HistoricalPackageResolution): number {
  const amount = Number.parseInt(resolution, 10);
  return resolution.endsWith("h")
    ? amount * 60 * 60_000
    : amount * 60_000;
}

function minuteValue(milliseconds: number): number {
  return Number((milliseconds / 60_000).toFixed(6));
}

function normalizeMinuteLimit(
  value: number | undefined,
  fallback: number,
  field: string,
): number {
  const normalized = value ?? fallback;
  if (
    !Number.isSafeInteger(normalized) ||
    normalized < 0 ||
    normalized > 1_440
  ) {
    throw new Error(`${field} must be an integer between 0 and 1440.`);
  }
  return normalized;
}

function isBuy(action: LegAction): boolean {
  switch (action) {
    case "BUY_TO_OPEN":
    case "BUY_TO_CLOSE":
      return true;
    case "SELL_TO_OPEN":
    case "SELL_TO_CLOSE":
      return false;
    default:
      throw new Error(`Unsupported leg action: ${String(action)}.`);
  }
}

function expectedPriceEffect(family: SpreadFamily): PriceEffect {
  switch (family) {
    case "DEBIT_VERTICAL":
    case "DOUBLE_DIAGONAL":
      return "DEBIT";
    case "CREDIT_VERTICAL":
    case "IRON_CONDOR":
      return "CREDIT";
    default:
      throw new Error(`Unsupported spread family: ${String(family)}.`);
  }
}

function parseOccDate(compact: string, symbol: string): string {
  const year = 2000 + Number(compact.slice(0, 2));
  const month = Number(compact.slice(2, 4));
  const day = Number(compact.slice(4, 6));
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new Error(`Invalid OCC expiration in provider_symbol: ${symbol}.`);
  }
  return `${year.toString().padStart(4, "0")}-${compact.slice(2, 4)}-${compact.slice(4, 6)}`;
}

export function parseHistoricalOptionSymbol(
  providerSymbol: string,
): Omit<ParsedLeg, "provider_symbol" | "action" | "quantity"> {
  if (providerSymbol !== providerSymbol.trim() || providerSymbol.length !== 21) {
    throw new Error(
      "provider_symbol must be an exact 21-character OCC option symbol without surrounding whitespace.",
    );
  }
  const rootField = providerSymbol.slice(0, 6);
  const root = rootField.trim();
  const compactDate = providerSymbol.slice(6, 12);
  const sideCode = providerSymbol.slice(12, 13);
  const strikeDigits = providerSymbol.slice(13);
  if (
    !/^[A-Z0-9]{1,6}$/.test(root) ||
    rootField !== root.padEnd(6, " ") ||
    !/^SPXW?$/.test(root) ||
    !/^\d{6}$/.test(compactDate) ||
    !/^[CP]$/.test(sideCode) ||
    !/^\d{8}$/.test(strikeDigits)
  ) {
    throw new Error(`Unsupported SPX OCC provider_symbol: ${providerSymbol}.`);
  }
  const strike = ExactDecimal.parse(
    `${strikeDigits.slice(0, 5)}.${strikeDigits.slice(5)}`,
    `${providerSymbol}.strike`,
  ).toString();
  return {
    streamer_symbol: `.${root}${compactDate}${sideCode}${strike}`,
    option_side: sideCode === "C" ? "CALL" : "PUT",
    strike,
    expiration: parseOccDate(compactDate, providerSymbol),
  };
}

function normalizeLegs(
  family: SpreadFamily,
  legs: HistoricalOptionPackageLegInput[],
): ParsedLeg[] {
  const expectedCount =
    family === "DEBIT_VERTICAL" || family === "CREDIT_VERTICAL"
      ? 2
      : family === "IRON_CONDOR" || family === "DOUBLE_DIAGONAL"
        ? 4
        : (() => {
            throw new Error(`Unsupported spread family: ${String(family)}.`);
          })();
  if (!Array.isArray(legs) || legs.length !== expectedCount) {
    throw new Error(`${family} requires exactly ${expectedCount} legs.`);
  }

  const seen = new Set<string>();
  const normalized = legs.map((leg, index) => {
    const providerSymbol = leg.provider_symbol;
    if (seen.has(providerSymbol)) {
      throw new Error(`Duplicate leg provider_symbol: ${providerSymbol}.`);
    }
    seen.add(providerSymbol);
    const quantity = leg.quantity ?? 1;
    if (!Number.isSafeInteger(quantity) || quantity <= 0) {
      throw new Error(`legs[${index}].quantity must be a positive integer.`);
    }
    isBuy(leg.action);
    return {
      provider_symbol: providerSymbol,
      action: leg.action,
      quantity,
      ...parseHistoricalOptionSymbol(providerSymbol),
    };
  });

  const buyCount = normalized.filter((leg) => isBuy(leg.action)).length;
  if (buyCount !== expectedCount / 2) {
    throw new Error(
      `${family} requires equal numbers of buy and sell legs.`,
    );
  }
  const expirationCounts = new Map<string, number>();
  for (const leg of normalized) {
    expirationCounts.set(
      leg.expiration,
      (expirationCounts.get(leg.expiration) ?? 0) + 1,
    );
  }
  if (family === "DOUBLE_DIAGONAL") {
    if (
      expirationCounts.size !== 2 ||
      [...expirationCounts.values()].some((count) => count !== 2)
    ) {
      throw new Error(
        "DOUBLE_DIAGONAL requires two legs in each of two expirations.",
      );
    }
  } else if (expirationCounts.size !== 1) {
    throw new Error(`${family} requires a single shared expiration.`);
  }
  return normalized;
}

function packageReferenceValue(
  family: SpreadFamily,
  legs: Array<Pick<ParsedLeg, "action" | "quantity">>,
  prices: string[],
  warnings: string[],
): HistoricalPackageReferenceValue {
  let signedDebit = ExactDecimal.zero();
  for (const [index, leg] of legs.entries()) {
    const price = ExactDecimal.parse(prices[index], `legs[${index}].price`);
    if (price.compare(ExactDecimal.zero()) < 0) {
      throw new Error(`legs[${index}].price must be non-negative.`);
    }
    const amount = price.multiplyInteger(leg.quantity);
    signedDebit = isBuy(leg.action)
      ? signedDebit.add(amount)
      : signedDebit.subtract(amount);
  }
  const comparison = signedDebit.compare(ExactDecimal.zero());
  const priceEffect: PriceEffect =
    comparison > 0 ? "DEBIT" : comparison < 0 ? "CREDIT" : "EVEN";
  const expected = expectedPriceEffect(family);
  if (priceEffect !== expected) {
    warnings.push(`FAMILY_PRICE_EFFECT_MISMATCH:${expected}_EXPECTED`);
  }
  return {
    value: signedDebit.abs().toString(),
    price_effect: priceEffect,
    evidence_type: "HISTORICAL_OPTION_PACKAGE_REFERENCE",
    guaranteed_executable: false,
  };
}

function isLegacyLocalBudgetError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes("exceeding max_candles=") ||
      error.message.startsWith("Requested range may contain ") ||
      error.message.includes("LOCAL_RECEIVE_BUDGET_EXCEEDED") ||
      error.message.includes("LOCAL_BUFFER_BUDGET_EXCEEDED") ||
      error.message.includes("LOCAL_OUTPUT_BUDGET_EXCEEDED"))
  );
}

async function retrieveWithFallback(
  service: HistoricalOptionPackageCandlesService,
  legs: ParsedLeg[],
  resolutions: HistoricalPackageResolution[],
  range: (resolution: HistoricalPackageResolution) => {
    start: string;
    end: string;
  },
): Promise<SelectedCandleBatch> {
  const attempts: HistoricalPackageResolutionAttempt[] = [];
  for (const resolution of resolutions) {
    const requestedRange = range(resolution);
    try {
      const results = await service.getHistoricalCandlesBatch({
        instruments: legs.map((leg) => ({
          symbol: leg.provider_symbol,
          streamer_symbol: leg.streamer_symbol,
          instrument_type: "OPTION",
        })),
        interval: resolution,
        start_time: requestedRange.start,
        end_time: requestedRange.end,
        session: { kind: "ALL", timezone: "UTC" },
        max_output_candles: CANDLE_MAX_OUTPUT,
        max_received_events: CANDLE_MAX_RECEIVED_EVENTS,
        max_buffer_bytes: CANDLE_MAX_BUFFER_BYTES,
      });
      if (!Array.isArray(results)) {
        throw new Error(
          "Historical candle provider returned a non-array batch result.",
        );
      }
      const snapshotFailure = results.some(
        (result) => !result.snapshot_complete || result.snapshot_truncated,
      );
      if (snapshotFailure) {
        const localBudgetFailure = results.some((result) =>
          (result.failure_reasons ?? []).some((reason) =>
            reason.startsWith("LOCAL_"),
          ),
        );
        attempts.push({
          resolution,
          status: "UNAVAILABLE",
          reason: localBudgetFailure
            ? "LOCAL_CANDLE_BUDGET_EXCEEDED"
            : results.some((result) => result.snapshot_truncated)
              ? "DXLINK_SNAPSHOT_TRUNCATED"
              : "DXLINK_SNAPSHOT_INCOMPLETE",
        });
        continue;
      }
      attempts.push({
        resolution,
        status: "SELECTED",
        reason: null,
      });
      return { resolution, results, attempts };
    } catch (error) {
      if (!isLegacyLocalBudgetError(error)) throw error;
      attempts.push({
        resolution,
        status: "UNAVAILABLE",
        reason: "LOCAL_CANDLE_BUDGET_EXCEEDED",
      });
    }
  }
  return { resolution: null, results: [], attempts };
}

function resultByStreamerSymbol(
  results: HistoricalCandlesResult[],
): Map<string, HistoricalCandlesResult> {
  const mapped = new Map<string, HistoricalCandlesResult>();
  for (const result of results) {
    if (mapped.has(result.streamer_symbol)) {
      throw new Error(
        `Historical candle provider returned duplicate result for ${result.streamer_symbol}.`,
      );
    }
    mapped.set(result.streamer_symbol, result);
  }
  return mapped;
}

function legProvenance(
  leg: ParsedLeg,
  resolution: HistoricalPackageResolution,
  result: HistoricalCandlesResult | undefined,
): HistoricalLegProvenance {
  return {
    provider_symbol: leg.provider_symbol,
    streamer_symbol: leg.streamer_symbol,
    source: "tastytrade-dxlink",
    interval: resolution,
    reference_field: "close",
    source_timestamp_semantics: "BAR_START",
    availability_rule: "source_timestamp + interval <= evaluation_time",
    snapshot_complete: result?.snapshot_complete ?? false,
    snapshot_truncated: result?.snapshot_truncated ?? false,
    provider_warnings: [...(result?.warnings ?? [])],
  };
}

function normalizeCandleValue(
  candle: HistoricalCandle,
  field: string,
): string {
  const value = ExactDecimal.parse(candle.close, field);
  if (value.compare(ExactDecimal.zero()) < 0) {
    throw new Error(`${field} must be non-negative.`);
  }
  return value.toString();
}

function normalizeOptionalDecimal(
  value: string | null,
  field: string,
): string | null {
  if (value === null) return null;
  return ExactDecimal.parse(value, field).toString();
}

function observedLeg(
  leg: ParsedLeg,
  resolution: HistoricalPackageResolution,
  result: HistoricalCandlesResult | undefined,
  candle: HistoricalCandle | null,
  evaluatedAt: number,
  maxObservationAgeMs: number,
  extraWarnings: string[] = [],
): HistoricalOptionPackageLegObservation {
  const provenance = legProvenance(leg, resolution, result);
  const warnings = [...extraWarnings];
  if (!result) warnings.push("PROVIDER_RESULT_MISSING");
  if (result && !result.snapshot_complete) {
    warnings.push("DXLINK_SNAPSHOT_INCOMPLETE");
  }
  if (result?.snapshot_truncated) {
    warnings.push("DXLINK_SNAPSHOT_TRUNCATED");
  }
  if (!candle) warnings.push("MISSING_LEG_EVIDENCE");

  const intervalMs = resolutionMilliseconds(resolution);
  const sourceTimestamp = candle
    ? normalizeRfc3339(candle.source_time, `${leg.provider_symbol}.source_time`)
    : null;
  const availableAtMs =
    sourceTimestamp === null ? null : Date.parse(sourceTimestamp) + intervalMs;
  const observationAgeMs =
    availableAtMs === null ? null : evaluatedAt - availableAtMs;
  let freshnessStatus: HistoricalOptionPackageLegObservation["freshness_status"] =
    candle ? "FRESH" : "MISSING";
  if (observationAgeMs !== null && observationAgeMs > maxObservationAgeMs) {
    freshnessStatus = "STALE";
    warnings.push("STALE_OBSERVATION");
  }
  if (observationAgeMs !== null && observationAgeMs < 0) {
    freshnessStatus = "MISSING";
    warnings.push("EVIDENCE_NOT_AVAILABLE_AT_EVALUATION_TIME");
  }
  if (
    candle &&
    (!provenance.snapshot_complete || provenance.snapshot_truncated)
  ) {
    freshnessStatus = "MISSING";
  }

  return {
    provider_symbol: leg.provider_symbol,
    streamer_symbol: leg.streamer_symbol,
    action: leg.action,
    quantity: leg.quantity,
    option_side: leg.option_side,
    strike: leg.strike,
    expiration: leg.expiration,
    reference_value:
      candle === null
        ? null
        : normalizeCandleValue(
            candle,
            `${leg.provider_symbol}.historical_close`,
          ),
    bid: null,
    ask: null,
    implied_volatility:
      candle === null
        ? null
        : normalizeOptionalDecimal(
            candle.implied_volatility,
            `${leg.provider_symbol}.implied_volatility`,
          ),
    delta: null,
    source_timestamp: sourceTimestamp,
    available_at:
      availableAtMs === null ? null : new Date(availableAtMs).toISOString(),
    observation_age_minutes:
      observationAgeMs === null ? null : minuteValue(observationAgeMs),
    freshness_status: freshnessStatus,
    provenance,
    warnings: [...new Set(warnings)],
  };
}

function resultSource(resolution: HistoricalPackageResolution | null): string {
  return resolution
    ? `tastytrade-dxlink:historical-option-package{=${resolution}}`
    : "tastytrade-dxlink:historical-option-package";
}

function resolutionWarnings(
  requested: HistoricalPackageResolution,
  selected: HistoricalPackageResolution | null,
): string[] {
  if (selected === null) return ["NO_SUPPORTED_RESOLUTION_AVAILABLE"];
  return selected === requested
    ? []
    : [`RESOLUTION_DOWNGRADED:${requested}_TO_${selected}`];
}

function emptyCheckpointLegs(
  legs: ParsedLeg[],
  resolution: HistoricalPackageResolution,
): HistoricalOptionPackageLegObservation[] {
  return legs.map((leg) =>
    observedLeg(leg, resolution, undefined, null, 0, 0),
  );
}

export async function getHistoricalOptionPackageAtCheckpoint(
  service: HistoricalOptionPackageCandlesService,
  input: HistoricalOptionPackageCheckpointInput,
): Promise<HistoricalOptionPackageCheckpointResult> {
  if (input.underlying !== "SPX") {
    throw new Error("Historical option package reconstruction supports SPX only.");
  }
  if (input.phase !== "REGRESSION_RESEARCH") {
    throw new Error("phase must be REGRESSION_RESEARCH.");
  }
  const asOf = normalizeRfc3339(input.as_of, "as_of");
  const asOfMs = Date.parse(asOf);
  const maxObservationAgeMinutes = normalizeMinuteLimit(
    input.max_observation_age_minutes,
    DEFAULT_MAX_OBSERVATION_AGE_MINUTES,
    "max_observation_age_minutes",
  );
  const maxTemporalSkewMinutes = normalizeMinuteLimit(
    input.max_temporal_skew_minutes,
    DEFAULT_MAX_TEMPORAL_SKEW_MINUTES,
    "max_temporal_skew_minutes",
  );
  const maxObservationAgeMs = maxObservationAgeMinutes * 60_000;
  const maxTemporalSkewMs = maxTemporalSkewMinutes * 60_000;
  const legs = normalizeLegs(input.family, input.legs);
  const selected = await retrieveWithFallback(
    service,
    legs,
    CHECKPOINT_RESOLUTIONS,
    (resolution) => {
      const intervalMs = resolutionMilliseconds(resolution);
      const diagnosticLookbackMs = Math.max(
        maxObservationAgeMs * 2,
        maxObservationAgeMs + intervalMs,
      );
      return {
        start: new Date(asOfMs - diagnosticLookbackMs).toISOString(),
        end: asOf,
      };
    },
  );
  const warnings = [
    ...resolutionWarnings("5m", selected.resolution),
    "HISTORICAL_BID_ASK_NOT_AVAILABLE",
    "VALUATION_ONLY_NOT_EXECUTABLE",
  ];

  if (!selected.resolution) {
    const source = resultSource(null);
    const observations = emptyCheckpointLegs(legs, "5m");
    warnings.push(
      ...observations.flatMap((leg) =>
        leg.warnings.map(
          (warning) => `${warning}:${leg.provider_symbol}`,
        ),
      ),
    );
    const evidence = createExecutionEvidence({
      evidence_type: "HISTORICAL_OPTION_PACKAGE_REFERENCE",
      evidence_phase: "POST_SESSION_REGRESSION",
      source,
      freshness_status: "UNKNOWN",
      temporal_alignment: "UNKNOWN",
      native_available: false,
      working_limit: null,
      acceptable_bound: null,
      fill_model: "NOT_APPLICABLE",
      fill_confidence: "NOT_APPLICABLE",
      references: input.references ?? {},
      warnings,
    });
    return {
      contract_version: "1.0.0",
      status: "NOT_AVAILABLE",
      evidence_type: "HISTORICAL_OPTION_PACKAGE_REFERENCE",
      evidence_phase: "REGRESSION_RESEARCH",
      family: input.family,
      underlying: input.underlying,
      as_of: asOf,
      requested_resolution: "5m",
      effective_resolution: null,
      resolution_attempts: selected.attempts,
      reference_value: null,
      synthetic_mid: null,
      synthetic_natural: null,
      price_effect: null,
      oldest_leg_source_timestamp: null,
      newest_leg_source_timestamp: null,
      oldest_leg_available_at: null,
      newest_leg_available_at: null,
      temporal_skew_minutes: null,
      freshness_status: "UNKNOWN",
      temporal_alignment: "UNKNOWN",
      valuation_quality: "NOT_AVAILABLE",
      execution_quality: "NOT_AVAILABLE",
      usable_for_execution: false,
      legs: observations,
      source,
      warnings: evidence.warnings,
      evidence,
    };
  }

  const intervalMs = resolutionMilliseconds(selected.resolution);
  const byStreamer = resultByStreamerSymbol(selected.results);
  const observations = legs.map((leg) => {
    const result = byStreamer.get(leg.streamer_symbol);
    const rangeStartMs =
      asOfMs -
      Math.max(
        maxObservationAgeMs * 2,
        maxObservationAgeMs + intervalMs,
      );
    const eligible: HistoricalCandle[] = [];
    let ignoredIncomplete = 0;
    for (const candle of result?.candles ?? []) {
      const sourceTime = Date.parse(
        normalizeRfc3339(
          candle.source_time,
          `${leg.provider_symbol}.source_time`,
        ),
      );
      if (sourceTime < rangeStartMs) continue;
      if (sourceTime + intervalMs > asOfMs) {
        ignoredIncomplete += 1;
        continue;
      }
      eligible.push(candle);
    }
    eligible.sort(
      (left, right) =>
        Date.parse(left.source_time) - Date.parse(right.source_time),
    );
    const extraWarnings =
      ignoredIncomplete > 0
        ? [`INCOMPLETE_OR_FUTURE_CANDLES_IGNORED:${ignoredIncomplete}`]
        : [];
    return observedLeg(
      leg,
      selected.resolution!,
      result,
      eligible.at(-1) ?? null,
      asOfMs,
      maxObservationAgeMs,
      extraWarnings,
    );
  });

  for (const observation of observations) {
    for (const warning of observation.warnings) {
      if (warning === "MISSING_LEG_EVIDENCE") {
        warnings.push(
          `MISSING_LEG_EVIDENCE:${observation.provider_symbol}`,
        );
      } else if (warning === "STALE_OBSERVATION") {
        warnings.push(
          `STALE_LEG_EVIDENCE:${observation.provider_symbol}`,
        );
      } else if (warning.startsWith("INCOMPLETE_OR_FUTURE_CANDLES_IGNORED:")) {
        warnings.push(
          `INCOMPLETE_OR_FUTURE_CANDLES_IGNORED:${observation.provider_symbol}:${warning.split(":")[1]}`,
        );
      } else if (
        warning === "DXLINK_SNAPSHOT_INCOMPLETE" ||
        warning === "DXLINK_SNAPSHOT_TRUNCATED" ||
        warning === "PROVIDER_RESULT_MISSING"
      ) {
        warnings.push(`${warning}:${observation.provider_symbol}`);
      }
    }
  }

  const completeObservations = observations.filter(
    (observation) =>
      observation.reference_value !== null &&
      observation.available_at !== null &&
      observation.freshness_status !== "MISSING",
  );
  const sourceTimestamps = completeObservations.map((observation) =>
    Date.parse(observation.source_timestamp!),
  );
  const availableTimestamps = completeObservations.map((observation) =>
    Date.parse(observation.available_at!),
  );
  const allObserved = completeObservations.length === legs.length;
  const temporalSkewMs =
    allObserved && availableTimestamps.length > 0
      ? Math.max(...availableTimestamps) - Math.min(...availableTimestamps)
      : null;
  const hasStale = observations.some(
    (observation) => observation.freshness_status === "STALE",
  );
  const temporalAlignment: TemporalAlignment = !allObserved
    ? "UNKNOWN"
    : temporalSkewMs! > maxTemporalSkewMs
      ? "MISALIGNED"
      : "ALIGNED";
  if (hasStale) warnings.push("CHECKPOINT_PACKAGE_STALE");
  if (temporalAlignment === "MISALIGNED") {
    warnings.push("TEMPORAL_ALIGNMENT_FAILED");
  }
  const available =
    allObserved &&
    !hasStale &&
    temporalAlignment === "ALIGNED" &&
    observations.every(
      (observation) => observation.freshness_status === "FRESH",
    );
  const referenceValue = available
    ? packageReferenceValue(
        input.family,
        legs,
        observations.map((observation) => observation.reference_value!),
        warnings,
      )
    : null;
  const freshnessStatus: FreshnessStatus = !allObserved
    ? "UNKNOWN"
    : hasStale
      ? "STALE"
      : "FRESH";
  const source = resultSource(selected.resolution);
  const oldestSource =
    sourceTimestamps.length > 0
      ? new Date(Math.min(...sourceTimestamps)).toISOString()
      : null;
  const newestSource =
    sourceTimestamps.length > 0
      ? new Date(Math.max(...sourceTimestamps)).toISOString()
      : null;
  const oldestAvailable =
    availableTimestamps.length > 0
      ? new Date(Math.min(...availableTimestamps)).toISOString()
      : null;
  const newestAvailable =
    availableTimestamps.length > 0
      ? new Date(Math.max(...availableTimestamps)).toISOString()
      : null;
  const evidence = createExecutionEvidence({
    evidence_type: "HISTORICAL_OPTION_PACKAGE_REFERENCE",
    evidence_phase: "POST_SESSION_REGRESSION",
    source,
    as_of: newestAvailable,
    oldest_leg_as_of: oldestAvailable,
    freshness_status: freshnessStatus,
    temporal_alignment: temporalAlignment,
    native_available: false,
    working_limit: null,
    acceptable_bound: null,
    fill_model: "NOT_APPLICABLE",
    fill_confidence: "NOT_APPLICABLE",
    references: input.references ?? {},
    warnings,
  });

  return {
    contract_version: "1.0.0",
    status: available ? "AVAILABLE" : "NOT_AVAILABLE",
    evidence_type: "HISTORICAL_OPTION_PACKAGE_REFERENCE",
    evidence_phase: "REGRESSION_RESEARCH",
    family: input.family,
    underlying: input.underlying,
    as_of: asOf,
    requested_resolution: "5m",
    effective_resolution: selected.resolution,
    resolution_attempts: selected.attempts,
    reference_value: referenceValue,
    synthetic_mid: null,
    synthetic_natural: null,
    price_effect: referenceValue?.price_effect ?? null,
    oldest_leg_source_timestamp: oldestSource,
    newest_leg_source_timestamp: newestSource,
    oldest_leg_available_at: oldestAvailable,
    newest_leg_available_at: newestAvailable,
    temporal_skew_minutes:
      temporalSkewMs === null ? null : minuteValue(temporalSkewMs),
    freshness_status: freshnessStatus,
    temporal_alignment: temporalAlignment,
    valuation_quality: available ? "COMPLETE" : "NOT_AVAILABLE",
    execution_quality: available ? "VALUATION_ONLY" : "NOT_AVAILABLE",
    usable_for_execution: false,
    legs: observations,
    source,
    warnings: evidence.warnings,
    evidence,
  };
}

function candidateResolutions(
  requested: HistoricalPackageResolution,
): HistoricalPackageResolution[] {
  const index = PATH_RESOLUTIONS.indexOf(requested);
  if (index < 0) {
    throw new Error(`Unsupported historical package resolution: ${requested}.`);
  }
  return PATH_RESOLUTIONS.slice(index);
}

function alignedSourceTimes(
  startMs: number,
  endMs: number,
  intervalMs: number,
): number[] {
  const first = Math.ceil(startMs / intervalMs) * intervalMs;
  const times: number[] = [];
  for (
    let sourceTime = first;
    sourceTime + intervalMs <= endMs;
    sourceTime += intervalMs
  ) {
    times.push(sourceTime);
  }
  return times;
}

export async function getHistoricalOptionPackagePath(
  service: HistoricalOptionPackageCandlesService,
  input: HistoricalOptionPackagePathInput,
): Promise<HistoricalOptionPackagePathResult> {
  if (input.underlying !== "SPX") {
    throw new Error("Historical option package reconstruction supports SPX only.");
  }
  if (input.phase !== "REGRESSION_RESEARCH") {
    throw new Error("phase must be REGRESSION_RESEARCH.");
  }
  const startTime = normalizeRfc3339(input.start_time, "start_time");
  const endTime = normalizeRfc3339(input.end_time, "end_time");
  const startMs = Date.parse(startTime);
  const endMs = Date.parse(endTime);
  if (endMs <= startMs) {
    throw new Error("end_time must be later than start_time.");
  }
  if (endMs - startMs > MAX_RESEARCH_WINDOW_MS) {
    throw new Error("Historical option package paths are limited to 24 hours.");
  }
  const legs = normalizeLegs(input.family, input.legs);
  const resolutions = candidateResolutions(input.resolution);
  const selected = await retrieveWithFallback(
    service,
    legs,
    resolutions,
    () => ({ start: startTime, end: endTime }),
  );
  const source = resultSource(selected.resolution);
  const warnings = [
    ...resolutionWarnings(input.resolution, selected.resolution),
    "HISTORICAL_BID_ASK_NOT_AVAILABLE",
    "VALUATION_ONLY_NOT_EXECUTABLE",
    "NO_INTERPOLATION_OR_FORWARD_FILL",
  ];

  if (!selected.resolution) {
    const evidence = createExecutionEvidence({
      evidence_type: "HISTORICAL_PATH",
      evidence_phase: "POST_SESSION_REGRESSION",
      source,
      freshness_status: "UNKNOWN",
      temporal_alignment: "UNKNOWN",
      native_available: false,
      working_limit: null,
      acceptable_bound: null,
      fill_model: "NOT_APPLICABLE",
      fill_confidence: "NOT_APPLICABLE",
      references: input.references ?? {},
      warnings,
    });
    return {
      contract_version: "1.0.0",
      status: "NOT_AVAILABLE",
      evidence_type: "HISTORICAL_PATH",
      evidence_phase: "REGRESSION_RESEARCH",
      family: input.family,
      underlying: input.underlying,
      start_time: startTime,
      end_time: endTime,
      requested_resolution: input.resolution,
      effective_resolution: null,
      resolution_attempts: selected.attempts,
      expected_point_count: 0,
      observed_point_count: 0,
      path_quality: "INVALID",
      path: [],
      gaps: [],
      fill_verification_path: [],
      fill_verification_compatible: true,
      supported_fill_models: ["LIMIT_TOUCH"],
      source,
      leg_sources: legs.map((leg) => legProvenance(leg, input.resolution, undefined)),
      warnings: evidence.warnings,
      evidence,
    };
  }

  const intervalMs = resolutionMilliseconds(selected.resolution);
  const expectedTimes = alignedSourceTimes(startMs, endMs, intervalMs);
  const byStreamer = resultByStreamerSymbol(selected.results);
  const candleMaps = new Map<string, Map<number, HistoricalCandle>>();
  for (const leg of legs) {
    const result = byStreamer.get(leg.streamer_symbol);
    const candles = new Map<number, HistoricalCandle>();
    for (const candle of result?.candles ?? []) {
      const sourceTime = Date.parse(
        normalizeRfc3339(
          candle.source_time,
          `${leg.provider_symbol}.source_time`,
        ),
      );
      if (
        sourceTime >= startMs &&
        sourceTime <= endMs &&
        sourceTime + intervalMs <= endMs
      ) {
        candles.set(sourceTime, candle);
      }
    }
    candleMaps.set(leg.streamer_symbol, candles);
  }

  const path: HistoricalOptionPackagePathPoint[] = [];
  const gaps: HistoricalOptionPackagePathGap[] = [];
  for (const sourceTime of expectedTimes) {
    const availableAt = sourceTime + intervalMs;
    const missingProviderSymbols: string[] = [];
    const reasons = new Set<string>();
    const observations = legs.map((leg) => {
      const result = byStreamer.get(leg.streamer_symbol);
      const candle = candleMaps.get(leg.streamer_symbol)?.get(sourceTime) ?? null;
      if (!result) {
        missingProviderSymbols.push(leg.provider_symbol);
        reasons.add("PROVIDER_RESULT_MISSING");
      } else if (!result.snapshot_complete || result.snapshot_truncated) {
        missingProviderSymbols.push(leg.provider_symbol);
        reasons.add(
          result.snapshot_truncated
            ? "DXLINK_SNAPSHOT_TRUNCATED"
            : "DXLINK_SNAPSHOT_INCOMPLETE",
        );
      } else if (!candle) {
        missingProviderSymbols.push(leg.provider_symbol);
        reasons.add("MISSING_LEG_EVIDENCE");
      }
      return observedLeg(
        leg,
        selected.resolution!,
        result,
        candle,
        availableAt,
        0,
      );
    });
    if (missingProviderSymbols.length > 0) {
      gaps.push({
        source_timestamp: new Date(sourceTime).toISOString(),
        available_at: new Date(availableAt).toISOString(),
        missing_provider_symbols: missingProviderSymbols,
        reasons: [...reasons],
      });
      continue;
    }

    const pointWarnings: string[] = [];
    const referenceValue = packageReferenceValue(
      input.family,
      legs,
      observations.map((observation) => observation.reference_value!),
      pointWarnings,
    );
    warnings.push(...pointWarnings);
    if (referenceValue.price_effect === "EVEN") {
      gaps.push({
        source_timestamp: new Date(sourceTime).toISOString(),
        available_at: new Date(availableAt).toISOString(),
        missing_provider_symbols: [],
        reasons: ["EVEN_PACKAGE_VALUE_NOT_FILL_VERIFICATION_COMPATIBLE"],
      });
      continue;
    }
    path.push({
      as_of: new Date(availableAt).toISOString(),
      source_timestamp: new Date(sourceTime).toISOString(),
      reference_value: referenceValue.value,
      price_effect: referenceValue.price_effect,
      temporal_skew_minutes: 0,
      temporal_alignment: "ALIGNED",
      valuation_quality: "COMPLETE",
      synthetic_mid: null,
      synthetic_natural: null,
      execution_quality: "VALUATION_ONLY",
      usable_for_execution: false,
      legs: observations,
      source,
    });
  }

  if (expectedTimes.length === 0) {
    warnings.push("NO_COMPLETE_INTERVALS_IN_WINDOW");
  }
  if (gaps.length > 0) warnings.push(`PATH_GAPS_PRESENT:${gaps.length}`);
  const status: HistoricalOptionPackagePathResult["status"] =
    path.length === 0
      ? "NOT_AVAILABLE"
      : gaps.length === 0 && path.length === expectedTimes.length
        ? "AVAILABLE"
        : "PARTIAL";
  const pathQuality: HistoricalOptionPackagePathResult["path_quality"] =
    status === "AVAILABLE"
      ? "COMPLETE"
      : status === "PARTIAL"
        ? "PARTIAL"
        : "INVALID";
  const evidence = createExecutionEvidence({
    evidence_type: "HISTORICAL_PATH",
    evidence_phase: "POST_SESSION_REGRESSION",
    source,
    as_of: path.at(-1)?.as_of ?? null,
    oldest_leg_as_of: path[0]?.source_timestamp ?? null,
    freshness_status: "UNKNOWN",
    temporal_alignment: status === "AVAILABLE" ? "ALIGNED" : "UNKNOWN",
    native_available: false,
    working_limit: null,
    acceptable_bound: null,
    fill_model: "NOT_APPLICABLE",
    fill_confidence: "NOT_APPLICABLE",
    references: input.references ?? {},
    warnings,
  });

  return {
    contract_version: "1.0.0",
    status,
    evidence_type: "HISTORICAL_PATH",
    evidence_phase: "REGRESSION_RESEARCH",
    family: input.family,
    underlying: input.underlying,
    start_time: startTime,
    end_time: endTime,
    requested_resolution: input.resolution,
    effective_resolution: selected.resolution,
    resolution_attempts: selected.attempts,
    expected_point_count: expectedTimes.length,
    observed_point_count: path.length,
    path_quality: pathQuality,
    path,
    gaps,
    fill_verification_path: path.map((point) => ({
      as_of: point.as_of,
      price: point.reference_value,
      price_effect: point.price_effect as Exclude<PriceEffect, "EVEN">,
      source: point.source,
    })),
    fill_verification_compatible: true,
    supported_fill_models: ["LIMIT_TOUCH"],
    source,
    leg_sources: legs.map((leg) =>
      legProvenance(
        leg,
        selected.resolution!,
        byStreamer.get(leg.streamer_symbol),
      ),
    ),
    warnings: evidence.warnings,
    evidence,
  };
}
