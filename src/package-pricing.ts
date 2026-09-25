import { ExactDecimal, type DecimalInput } from "./decimal.js";
import {
  createExecutionEvidence,
  type EvidenceType,
  type ExecutionEvidence,
  type ExecutionReferences,
  type FreshnessStatus,
  type TemporalAlignment,
} from "./execution-evidence.js";
import { normalizeRfc3339 } from "./time.js";

export type SpreadFamily =
  | "DEBIT_VERTICAL"
  | "CREDIT_VERTICAL"
  | "IRON_CONDOR"
  | "DOUBLE_DIAGONAL";

export type LegAction =
  | "BUY_TO_OPEN"
  | "SELL_TO_OPEN"
  | "BUY_TO_CLOSE"
  | "SELL_TO_CLOSE";

export type PriceEffect = "DEBIT" | "CREDIT" | "EVEN";

export type OptionLegQuote = {
  symbol: string;
  action: LegAction;
  quantity: number;
  expiration: string;
  bid?: DecimalInput | null;
  ask?: DecimalInput | null;
  as_of?: string | null;
  source?: string | null;
};

export type NativePackageQuote = {
  bid: DecimalInput;
  ask: DecimalInput;
  price_effect: Exclude<PriceEffect, "EVEN">;
  as_of: string;
  source: string;
};

export type PackagePricingInput = {
  family: SpreadFamily;
  legs: OptionLegQuote[];
  native_package?: NativePackageQuote | null;
  evaluated_at?: string;
  max_quote_age_ms?: number;
  max_temporal_skew_ms?: number;
  references?: ExecutionReferences;
};

export type PricedAmount = {
  value: string;
  price_effect: PriceEffect;
  evidence_type: "SYNTHETIC_NATURAL" | "SYNTHETIC_MID_REFERENCE";
  guaranteed_executable: false;
};

export type NormalizedLegQuote = {
  symbol: string;
  action: LegAction;
  quantity: number;
  expiration: string;
  bid: string | null;
  ask: string | null;
  mid: string | null;
  as_of: string | null;
  source: string | null;
};

export type PackagePricingResult = {
  family: SpreadFamily;
  quote_type: Extract<
    EvidenceType,
    "NATIVE_PACKAGE" | "SYNTHETIC_NATURAL" | "SYNTHETIC_MID_REFERENCE"
  >;
  native_available: boolean;
  package_bid: string | null;
  package_ask: string | null;
  package_mid: string | null;
  package_price_effect: PriceEffect | null;
  synthetic_natural: PricedAmount | null;
  synthetic_mid: PricedAmount | null;
  leg_quotes: NormalizedLegQuote[];
  source: string;
  as_of: string | null;
  freshness_status: FreshnessStatus;
  temporal_alignment: TemporalAlignment;
  usable_for_execution: boolean;
  warnings: string[];
  evidence: ExecutionEvidence;
};

const DEFAULT_MAX_QUOTE_AGE_MS = 30_000;
const DEFAULT_MAX_TEMPORAL_SKEW_MS = 2_000;

function normalizeTimestamp(
  value: string | null | undefined,
  field: string,
): string | null {
  if (value === null || value === undefined) return null;
  return normalizeRfc3339(value, field);
}

function validateDuration(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Quote age and skew limits must be non-negative integers.");
  }
  return value;
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

function pricedAmount(
  signedDebit: ExactDecimal,
  evidenceType: PricedAmount["evidence_type"],
): PricedAmount {
  const comparison = signedDebit.compare(ExactDecimal.zero());
  return {
    value: signedDebit.abs().toString(),
    price_effect:
      comparison > 0 ? "DEBIT" : comparison < 0 ? "CREDIT" : "EVEN",
    evidence_type: evidenceType,
    guaranteed_executable: false,
  };
}

function validateFamily(family: SpreadFamily, legs: OptionLegQuote[]): void {
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

  const buyCount = legs.filter((leg) => isBuy(leg.action)).length;
  if (buyCount !== expectedCount / 2) {
    throw new Error(
      `${family} requires equal numbers of buy and sell legs.`,
    );
  }

  const expirations = new Map<string, number>();
  for (const leg of legs) {
    const expiration = leg.expiration.trim();
    const normalizedExpiration = normalizeRfc3339(
      expiration,
      `${leg.symbol}.expiration`,
    );
    expirations.set(
      normalizedExpiration,
      (expirations.get(normalizedExpiration) ?? 0) + 1,
    );
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
  } else if (expirations.size !== 1) {
    throw new Error(`${family} requires a single shared expiration.`);
  }
}

function normalizeLegs(
  legs: OptionLegQuote[],
  warnings: string[],
): {
  legs: NormalizedLegQuote[];
  natural: ExactDecimal | null;
  midpoint: ExactDecimal | null;
  timestamps: number[];
  hasInvalidMarket: boolean;
} {
  let natural = ExactDecimal.zero();
  let midpoint = ExactDecimal.zero();
  let naturalAvailable = true;
  let midpointAvailable = true;
  let hasInvalidMarket = false;
  const timestamps: number[] = [];
  const normalized: NormalizedLegQuote[] = [];
  const symbols = new Set<string>();

  for (const [index, leg] of legs.entries()) {
    const symbol = leg.symbol.trim();
    if (!symbol) throw new Error(`legs[${index}].symbol must be non-empty.`);
    if (symbols.has(symbol)) {
      throw new Error(`Duplicate leg symbol: ${symbol}.`);
    }
    symbols.add(symbol);
    if (!Number.isSafeInteger(leg.quantity) || leg.quantity <= 0) {
      throw new Error(`Quantity for leg ${symbol} must be a positive integer.`);
    }

    const bid =
      leg.bid === null || leg.bid === undefined
        ? null
        : ExactDecimal.parse(leg.bid, `${symbol}.bid`);
    const ask =
      leg.ask === null || leg.ask === undefined
        ? null
        : ExactDecimal.parse(leg.ask, `${symbol}.ask`);
    if (
      (bid && bid.compare(ExactDecimal.zero()) < 0) ||
      (ask && ask.compare(ExactDecimal.zero()) < 0)
    ) {
      throw new Error(`Quotes for leg ${symbol} must be non-negative.`);
    }

    const expiration = normalizeRfc3339(
      leg.expiration.trim(),
      `${symbol}.expiration`,
    );
    const asOf = normalizeTimestamp(leg.as_of, `${symbol}.as_of`);
    if (asOf) timestamps.push(Date.parse(asOf));
    const source = leg.source?.trim() || null;

    let mid: ExactDecimal | null = null;
    if (bid && ask) {
      mid = bid.add(ask).half();
      if (bid.compare(ask) > 0) {
        warnings.push(`CROSSED_LEG_MARKET:${symbol}`);
        naturalAvailable = false;
        hasInvalidMarket = true;
      }
    } else {
      warnings.push(`MISSING_LEG_QUOTE:${symbol}`);
      naturalAvailable = false;
      midpointAvailable = false;
      hasInvalidMarket = true;
    }
    if (!asOf) {
      warnings.push(`MISSING_LEG_TIMESTAMP:${symbol}`);
      hasInvalidMarket = true;
    }
    if (!source) {
      warnings.push(`MISSING_LEG_SOURCE:${symbol}`);
      hasInvalidMarket = true;
    }

    if (naturalAvailable && bid && ask) {
      const side = isBuy(leg.action) ? ask : bid.negate();
      natural = natural.add(side.multiplyInteger(leg.quantity));
    }
    if (midpointAvailable && mid) {
      const side = isBuy(leg.action) ? mid : mid.negate();
      midpoint = midpoint.add(side.multiplyInteger(leg.quantity));
    }

    normalized.push({
      symbol,
      action: leg.action,
      quantity: leg.quantity,
      expiration,
      bid: bid?.toString() ?? null,
      ask: ask?.toString() ?? null,
      mid: mid?.toString() ?? null,
      as_of: asOf,
      source,
    });
  }

  return {
    legs: normalized,
    natural: naturalAvailable ? natural : null,
    midpoint: midpointAvailable ? midpoint : null,
    timestamps,
    hasInvalidMarket,
  };
}

function marketTiming(
  timestamps: number[],
  expectedTimestampCount: number,
  evaluatedAt: number,
  maxQuoteAgeMs: number,
  maxTemporalSkewMs: number,
  warnings: string[],
): {
  asOf: string | null;
  freshnessStatus: FreshnessStatus;
  temporalAlignment: TemporalAlignment;
} {
  if (timestamps.length === 0) {
    return {
      asOf: null,
      freshnessStatus: "UNKNOWN",
      temporalAlignment: "UNKNOWN",
    };
  }

  const oldest = Math.min(...timestamps);
  const newest = Math.max(...timestamps);
  const ages = timestamps.map((timestamp) => evaluatedAt - timestamp);
  const hasFutureTimestamp = ages.some((age) => age < 0);
  if (hasFutureTimestamp) warnings.push("FUTURE_QUOTE_TIMESTAMP");
  const hasMissingTimestamp = timestamps.length !== expectedTimestampCount;
  const stale = ages.some((age) => age > maxQuoteAgeMs);
  if (stale) warnings.push("STALE_QUOTE_SET");

  const skew = newest - oldest;
  const temporalAlignment =
    timestamps.length < 2
      ? "ALIGNED"
      : skew > maxTemporalSkewMs
        ? "MISALIGNED"
        : "ALIGNED";
  if (temporalAlignment === "MISALIGNED") {
    warnings.push(`TEMPORAL_MISALIGNMENT:${skew}ms`);
  }

  return {
    asOf: new Date(oldest).toISOString(),
    freshnessStatus:
      hasFutureTimestamp || hasMissingTimestamp
        ? "UNKNOWN"
        : stale
          ? "STALE"
          : "FRESH",
    temporalAlignment: hasMissingTimestamp ? "UNKNOWN" : temporalAlignment,
  };
}

function expectedPriceEffect(family: SpreadFamily): PriceEffect {
  switch (family) {
    case "CREDIT_VERTICAL":
    case "IRON_CONDOR":
      return "CREDIT";
    case "DEBIT_VERTICAL":
    case "DOUBLE_DIAGONAL":
      return "DEBIT";
    default:
      throw new Error(`Unsupported spread family: ${String(family)}.`);
  }
}

export function priceOptionPackage(
  input: PackagePricingInput,
): PackagePricingResult {
  validateFamily(input.family, input.legs);

  const warnings: string[] = [];
  const evaluatedAtText = normalizeTimestamp(
    input.evaluated_at ?? new Date().toISOString(),
    "evaluated_at",
  );
  const evaluatedAt = Date.parse(evaluatedAtText!);
  const maxQuoteAgeMs = validateDuration(
    input.max_quote_age_ms,
    DEFAULT_MAX_QUOTE_AGE_MS,
  );
  const maxTemporalSkewMs = validateDuration(
    input.max_temporal_skew_ms,
    DEFAULT_MAX_TEMPORAL_SKEW_MS,
  );
  const normalized = normalizeLegs(input.legs, warnings);
  const oldestLegAsOf =
    normalized.timestamps.length > 0
      ? new Date(Math.min(...normalized.timestamps)).toISOString()
      : null;

  let packageBid: ExactDecimal | null = null;
  let packageAsk: ExactDecimal | null = null;
  let packageMid: ExactDecimal | null = null;
  let nativeTimestamp: number | null = null;
  let nativeSource: string | null = null;
  let nativePriceEffect: Exclude<PriceEffect, "EVEN"> | null = null;
  let nativeAvailable = false;

  if (input.native_package) {
    packageBid = ExactDecimal.parse(
      input.native_package.bid,
      "native_package.bid",
    );
    packageAsk = ExactDecimal.parse(
      input.native_package.ask,
      "native_package.ask",
    );
    if (
      packageBid.compare(ExactDecimal.zero()) < 0 ||
      packageAsk.compare(ExactDecimal.zero()) < 0
    ) {
      throw new Error("Native package quotes must be non-negative.");
    }
    nativePriceEffect = input.native_package.price_effect;
    nativeSource = input.native_package.source.trim();
    if (!nativeSource) throw new Error("native_package.source is required.");
    nativeTimestamp = Date.parse(
      normalizeTimestamp(input.native_package.as_of, "native_package.as_of")!,
    );
    if (packageBid.compare(packageAsk) > 0) {
      warnings.push("CROSSED_NATIVE_PACKAGE_MARKET");
      packageBid = null;
      packageAsk = null;
    } else {
      packageMid = packageBid.add(packageAsk).half();
      nativeAvailable = true;
    }
  }

  const quoteType: PackagePricingResult["quote_type"] = nativeAvailable
    ? "NATIVE_PACKAGE"
    : normalized.natural
      ? "SYNTHETIC_NATURAL"
      : "SYNTHETIC_MID_REFERENCE";
  const decisionTimestamps =
    quoteType === "NATIVE_PACKAGE" && nativeTimestamp !== null
      ? [nativeTimestamp]
      : normalized.timestamps;
  const timing = marketTiming(
    decisionTimestamps,
    quoteType === "NATIVE_PACKAGE" ? 1 : input.legs.length,
    evaluatedAt,
    maxQuoteAgeMs,
    maxTemporalSkewMs,
    warnings,
  );

  const natural = normalized.natural
    ? pricedAmount(normalized.natural, "SYNTHETIC_NATURAL")
    : null;
  const midpoint = normalized.midpoint
    ? pricedAmount(normalized.midpoint, "SYNTHETIC_MID_REFERENCE")
    : null;
  if (natural && natural.price_effect !== expectedPriceEffect(input.family)) {
    warnings.push(
      `FAMILY_PRICE_EFFECT_MISMATCH:${expectedPriceEffect(input.family)}_EXPECTED`,
    );
  }
  if (midpoint) warnings.push("SYNTHETIC_MIDPOINT_IS_VALUATION_ONLY");

  const source =
    quoteType === "NATIVE_PACKAGE"
      ? nativeSource!
      : `synthetic:${[
          ...new Set(
            normalized.legs
              .map((leg) => leg.source)
              .filter((value): value is string => value !== null),
          ),
        ]
          .sort()
          .join(",") || "unknown"}`;
  const usableForExecution =
    timing.freshnessStatus === "FRESH" &&
    timing.temporalAlignment === "ALIGNED" &&
    (quoteType === "NATIVE_PACKAGE"
      ? nativeAvailable
      : natural !== null && !normalized.hasInvalidMarket);
  if (!usableForExecution) warnings.push("NOT_USABLE_FOR_EXECUTION");

  const evidence = createExecutionEvidence({
    evidence_type: quoteType,
    evidence_phase: "LIVE_CHECKPOINT",
    source,
    as_of: timing.asOf,
    oldest_leg_as_of: oldestLegAsOf,
    freshness_status: timing.freshnessStatus,
    temporal_alignment: timing.temporalAlignment,
    native_available: nativeAvailable,
    working_limit: null,
    acceptable_bound: null,
    fill_model: "NOT_APPLICABLE",
    fill_confidence: "NOT_APPLICABLE",
    references: input.references ?? {},
    warnings,
  });

  return {
    family: input.family,
    quote_type: quoteType,
    native_available: nativeAvailable,
    package_bid: packageBid?.toString() ?? null,
    package_ask: packageAsk?.toString() ?? null,
    package_mid: packageMid?.toString() ?? null,
    package_price_effect: nativePriceEffect,
    synthetic_natural: natural,
    synthetic_mid: midpoint,
    leg_quotes: normalized.legs,
    source,
    as_of: timing.asOf,
    freshness_status: timing.freshnessStatus,
    temporal_alignment: timing.temporalAlignment,
    usable_for_execution: usableForExecution,
    warnings: evidence.warnings,
    evidence,
  };
}
